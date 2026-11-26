// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig } from "./config.js";
import {
  formatHumanCheck,
  formatJsonCheck,
  formatRulesList,
  formatSarifCheck,
  formatStripResult,
  summarizeFindings,
} from "./format.js";
import {
  auditMcpConfigStatic,
  discoverMcpConfigs,
  inspectStdioMcpServer,
  scanMcpPayload,
} from "./mcp.js";
import { RULE_IDS, RULES } from "./rules.js";
import {
  collectTargetFiles,
  filterFindings,
  scanFiles,
  scanStagedGitDiff,
  scanText,
  stripFiles,
  toPosix,
} from "./scanner.js";

/**
 * @typedef {{
 *   cwd: string,
 *   out: (s: string) => void,
 *   err: (s: string) => void,
 *   stdinText?: string,
 * }} IO
 * @typedef {import("./rules.js").Finding} Finding
 */

export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Read package.json version.
 * @returns {string}
 */
export function readVersion() {
  const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

const HELP_TEXT = `prompt-shield - Detect & strip invisible Unicode, ASCII smuggling, Trojan Source bidi, and prompt injection

Usage:
  prompt-shield [check] [targets...] [options]
  prompt-shield strip [targets...] [--dry-run] [--backup]
  prompt-shield rules [--json]
  prompt-shield [options] -- <mcp-command> [args...]

Commands:
  check       Scan files, staged diffs, stdin, or MCP servers (default)
  strip       Remove invisible Unicode tags, bidi controls, and zero-width chars
  rules       List all detection rules and whether they are enabled

Options:
  --staged              Scan only added lines in staged git diff
  --stdin               Scan text from standard input (AI surface rules enabled)
  --ai-only             Only scan AI rules, skills, instructions, and MCP files
  --all-text            Apply prompt-injection & exfil heuristics to all text files
  --mcp                 Auto-discover and scan .mcp.json / .cursor/mcp.json / .vscode/mcp.json
  --mcp-config <file>   Scan a specific MCP config file (repeatable)
  --inspect-mcp         Spawn stdio MCP servers from config and scan tools/prompts/resources
  --from-json <file>    Scan a saved MCP tools/list JSON payload (or "-" for stdin)
  --timeout <ms>        Stdio MCP server handshake timeout in ms (default: 8000)
  --config <file>       Path to .prompt-shield.json config
  --ignore-rule <id>    Disable a rule ID (repeatable)
  --strict-unicode      Also flag emoji-joining ZWJ (U+200D) characters
  --strict              Treat warnings as errors (exit 1)
  --dry-run             With strip: report changes without modifying files
  --backup              With strip: write <file>.bak before modifying
  --json                Output machine-readable JSON
  --sarif               Output SARIF 2.1.0 (for GitHub Code Scanning)
  -q, --quiet           Suppress output when status is OK
  -h, --help            Show this help message
  -v, --version         Show version

Exit codes:
  0  Clean (or warnings only when not --strict)
  1  Blocking findings detected
  2  Usage, config, or runtime error
`;

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const dashDash = argv.indexOf("--");
  const flagArgs = dashDash === -1 ? argv : argv.slice(0, dashDash);
  const directMcpCommand = dashDash === -1 ? [] : argv.slice(dashDash + 1);

  /** @type {{
   *   command: "check" | "strip" | "rules",
   *   targets: string[],
   *   staged: boolean,
   *   stdin: boolean,
   *   aiOnly: boolean,
   *   allText: boolean,
   *   mcp: boolean,
   *   mcpConfigs: string[],
   *   inspectMcp: boolean,
   *   fromJson: string | null,
   *   timeoutMs: number,
   *   configPath: string | null,
   *   ignoreRules: string[],
   *   strictUnicode: boolean,
   *   strict: boolean,
   *   dryRun: boolean,
   *   backup: boolean,
   *   json: boolean,
   *   sarif: boolean,
   *   quiet: boolean,
   *   help: boolean,
   *   version: boolean,
   *   directMcpCommand: string[],
   * }} */
  const parsed = {
    command: "check",
    targets: [],
    staged: false,
    stdin: false,
    aiOnly: false,
    allText: false,
    mcp: false,
    mcpConfigs: [],
    inspectMcp: false,
    fromJson: null,
    timeoutMs: 8000,
    configPath: null,
    ignoreRules: [],
    strictUnicode: false,
    strict: false,
    dryRun: false,
    backup: false,
    json: false,
    sarif: false,
    quiet: false,
    help: false,
    version: false,
    directMcpCommand,
  };

  /** @param {string} flag @param {string | undefined} val */
  const requireStr = (flag, val) => {
    if (val === undefined) throw new UsageError(`Option ${flag} requires a value`);
    return val;
  };

  /** @param {string} flag @param {string | undefined} val */
  const requirePosInt = (flag, val) => {
    const s = requireStr(flag, val);
    if (!/^\d+$/.test(s) || Number.parseInt(s, 10) <= 0) {
      throw new UsageError(`Option ${flag} expects a positive integer, got "${s}"`);
    }
    return Number.parseInt(s, 10);
  };

  let seenSubcommand = false;
  for (let i = 0; i < flagArgs.length; i++) {
    const arg = flagArgs[i];
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
    } else if (arg === "-v" || arg === "--version") {
      parsed.version = true;
    } else if (arg === "--staged") {
      parsed.staged = true;
    } else if (arg === "--stdin") {
      parsed.stdin = true;
    } else if (arg === "--ai-only") {
      parsed.aiOnly = true;
    } else if (arg === "--all-text") {
      parsed.allText = true;
    } else if (arg === "--mcp") {
      parsed.mcp = true;
    } else if (arg === "--mcp-config") {
      parsed.mcpConfigs.push(requireStr(arg, flagArgs[++i]));
      parsed.mcp = true;
    } else if (arg.startsWith("--mcp-config=")) {
      parsed.mcpConfigs.push(arg.slice(13));
      parsed.mcp = true;
    } else if (arg === "--inspect-mcp") {
      parsed.inspectMcp = true;
      parsed.mcp = true;
    } else if (arg === "--from-json") {
      parsed.fromJson = requireStr(arg, flagArgs[++i]);
    } else if (arg.startsWith("--from-json=")) {
      parsed.fromJson = arg.slice(12);
    } else if (arg === "--timeout") {
      parsed.timeoutMs = requirePosInt(arg, flagArgs[++i]);
    } else if (arg.startsWith("--timeout=")) {
      parsed.timeoutMs = requirePosInt("--timeout", arg.slice(10));
    } else if (arg === "--config") {
      parsed.configPath = requireStr(arg, flagArgs[++i]);
    } else if (arg.startsWith("--config=")) {
      parsed.configPath = arg.slice(9);
    } else if (arg === "--ignore-rule") {
      parsed.ignoreRules.push(requireStr(arg, flagArgs[++i]));
    } else if (arg.startsWith("--ignore-rule=")) {
      parsed.ignoreRules.push(arg.slice(14));
    } else if (arg === "--strict-unicode") {
      parsed.strictUnicode = true;
    } else if (arg === "--strict") {
      parsed.strict = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--backup") {
      parsed.backup = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--sarif") {
      parsed.sarif = true;
    } else if (arg === "-q" || arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else if (!seenSubcommand && (arg === "check" || arg === "strip" || arg === "rules")) {
      parsed.command = arg;
      seenSubcommand = true;
    } else {
      seenSubcommand = true;
      parsed.targets.push(arg);
    }
  }

  if (parsed.json && parsed.sarif) {
    throw new UsageError("Cannot combine --json and --sarif");
  }

  return parsed;
}

/**
 * Read all of stdin if needed.
 * @param {IO} io
 * @returns {Promise<string>}
 */
async function readStdin(io) {
  if (typeof io.stdinText === "string") return io.stdinText;
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Execute prompt-shield CLI and return exit code (0, 1, or 2).
 * @param {string[]} argv
 * @param {IO} io
 * @returns {Promise<number>}
 */
export async function run(argv, io) {
  const version = readVersion();

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`prompt-shield: ${err.message}\nRun "prompt-shield --help" for usage.\n`);
      return 2;
    }
    throw err;
  }

  if (parsed.help) {
    io.out(HELP_TEXT);
    return 0;
  }
  if (parsed.version) {
    io.out(version + "\n");
    return 0;
  }

  let config;
  try {
    config = loadConfig(io.cwd, parsed.configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      io.err(`prompt-shield: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  for (const r of parsed.ignoreRules) {
    if (!RULE_IDS.includes(r)) {
      io.err(`prompt-shield: Unknown rule ID "${r}". Run "prompt-shield rules" to list valid IDs.\n`);
      return 2;
    }
    config.ignoreRules.add(r);
  }

  const strict = parsed.strict || config.strict;
  const strictUnicode = parsed.strictUnicode || config.strictUnicode;

  if (parsed.command === "rules") {
    io.out(formatRulesList(RULES, config.ignoreRules, parsed.json));
    return 0;
  }

  if (parsed.command === "strip") {
    try {
      const { files } = collectTargetFiles(io.cwd, parsed.targets, {
        ignoreFiles: config.ignoreFiles,
        aiOnly: parsed.aiOnly,
        maxFileSizeKB: config.maxFileSizeKB,
      });
      const res = stripFiles(io.cwd, files, {
        dryRun: parsed.dryRun,
        backup: parsed.backup,
        strictUnicode,
      });
      io.out(formatStripResult(res, { dryRun: parsed.dryRun, json: parsed.json, version }));
      return 0;
    } catch (err) {
      io.err(`prompt-shield: ${/** @type {Error} */ (err).message}\n`);
      return 2;
    }
  }

  // Command: check
  /** @type {Finding[]} */
  let findings = [];
  let scannedFiles = 0;
  let mcpItems = 0;
  /** @type {string[]} */
  let skippedLarge = [];
  let modeLabel = "repo scan";

  try {
    if (parsed.directMcpCommand.length > 0) {
      modeLabel = "stdio MCP inspection";
      const [cmd, ...args] = parsed.directMcpCommand;
      const res = await inspectStdioMcpServer(path.basename(cmd), cmd, args, {
        cwd: io.cwd,
        timeoutMs: parsed.timeoutMs,
        strictUnicode,
      });
      if (res.error) {
        io.err(`prompt-shield: ${res.error}\n`);
        return 2;
      }
      mcpItems += res.itemCount;
      findings.push(...res.findings);
    } else if (parsed.fromJson !== null) {
      modeLabel = "MCP JSON payload";
      const raw =
        parsed.fromJson === "-"
          ? await readStdin(io)
          : fs.readFileSync(path.resolve(io.cwd, parsed.fromJson), "utf8");
      const jsonData = JSON.parse(raw);
      const label = parsed.fromJson === "-" ? "stdin.json" : toPosix(parsed.fromJson);
      const res = scanMcpPayload(jsonData, label, { strictUnicode });
      mcpItems += res.itemCount;
      findings.push(...res.findings);
    } else if (parsed.stdin) {
      modeLabel = "stdin";
      const text = await readStdin(io);
      scannedFiles = 1;
      findings.push(
        ...scanText(text, "<stdin>", {
          strictUnicode,
          aiSurface: true,
        }),
      );
    } else if (parsed.staged) {
      modeLabel = "staged diff";
      const diffRes = scanStagedGitDiff(io.cwd, {
        strictUnicode,
        allText: parsed.allText,
        aiOnly: parsed.aiOnly,
      });
      scannedFiles = diffRes.scannedFiles;
      findings.push(...diffRes.findings);
    } else {
      const scanFilesMode = !parsed.mcp || parsed.targets.length > 0;
      if (scanFilesMode) {
        const collected = collectTargetFiles(io.cwd, parsed.targets, {
          ignoreFiles: config.ignoreFiles,
          aiOnly: parsed.aiOnly,
          maxFileSizeKB: config.maxFileSizeKB,
        });
        skippedLarge = collected.skippedLarge;
        const fileRes = scanFiles(io.cwd, collected.files, {
          strictUnicode,
          allText: parsed.allText,
        });
        scannedFiles += fileRes.scannedCount;
        findings.push(...fileRes.findings);
      }

      if (parsed.mcp) {
        modeLabel = scanFilesMode ? "files + MCP" : parsed.inspectMcp ? "live MCP inspection" : "MCP config audit";
        const mcpPaths =
          parsed.mcpConfigs.length > 0
            ? parsed.mcpConfigs.map((p) => path.resolve(io.cwd, p))
            : discoverMcpConfigs(io.cwd);

        for (const cfgPath of mcpPaths) {
          if (!fs.existsSync(cfgPath)) {
            throw new Error(`MCP config file not found: ${cfgPath}`);
          }
          const rel = toPosix(path.relative(io.cwd, cfgPath));
          const label = rel && !rel.startsWith("..") ? rel : toPosix(cfgPath);
          const audited = auditMcpConfigStatic(cfgPath, label, { strictUnicode });
          findings.push(...audited.findings);
          if (!scanFilesMode) scannedFiles += 1;

          if (parsed.inspectMcp) {
            for (const entry of audited.entries) {
              if (!entry.command) continue;
              const live = await inspectStdioMcpServer(entry.name, entry.command, entry.args ?? [], {
                cwd: io.cwd,
                env: entry.env,
                timeoutMs: parsed.timeoutMs,
                strictUnicode,
              });
              if (live.error) {
                io.err(`prompt-shield: ${live.error}\n`);
                return 2;
              }
              mcpItems += live.itemCount;
              findings.push(...live.findings);
            }
          }
        }
      }
    }
  } catch (err) {
    io.err(`prompt-shield: ${/** @type {Error} */ (err).message}\n`);
    return 2;
  }

  const filtered = filterFindings(findings, config);
  // Deduplicate identical findings across overlapping modes (e.g. file scan + MCP static config)
  /** @type {Finding[]} */
  const deduped = [];
  const seen = new Set();
  for (const f of filtered) {
    const key = `${f.ruleId}|${f.file}|${f.line}|${f.column}|${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }

  if (parsed.json) {
    io.out(
      formatJsonCheck(deduped, {
        scannedFiles,
        skippedLarge,
        mcpItems,
        strict,
        version,
      }),
    );
  } else if (parsed.sarif) {
    io.out(formatSarifCheck(deduped, { version }));
  } else {
    io.out(
      formatHumanCheck(deduped, {
        scannedFiles,
        skippedLarge,
        mcpItems,
        strict,
        quiet: parsed.quiet,
        modeLabel,
      }),
    );
  }

  const summary = summarizeFindings(deduped);
  if (summary.errors > 0 || (strict && summary.warnings > 0)) {
    return 1;
  }
  return 0;
}
