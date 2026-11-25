// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAME, loadConfig, safeResolveInside } from "./config.js";
import { KNOWN_TARGETS, discoverRuleFiles, resolveTargetPath, toPosix } from "./registry.js";
import { applySyncPlan, buildSyncPlan, hasManagedBlock } from "./sync.js";
import { findBrokenReferences, findContradictions, measureRuleFiles } from "./analyze.js";
import { formatLineDiff } from "./diff.js";

/**
 * @typedef {import("./config.js").AgentRulesConfig} AgentRulesConfig
 * @typedef {import("./config.js").TargetConfig} TargetConfig
 * @typedef {import("./config.js").SyncMode} SyncMode
 */

const SUBCOMMANDS = new Set(["check", "sync", "diff", "init", "status"]);

/**
 * Read tool version from package.json.
 * @returns {string}
 */
function readVersion() {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  try {
    const raw = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return typeof raw.version === "string" ? raw.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Print CLI usage text.
 * @returns {string}
 */
function helpText() {
  const aliases = KNOWN_TARGETS.map((t) => `${t.alias} (${t.defaultPath})`).join("\n    ");
  return `agent-rules-sync - Keep AI coding instruction files in sync and lint them in CI

Usage:
  agent-rules-sync [command] [dir] [options]

Commands:
  check [dir]    Verify targets match source, check links, contradictions, and tokens (default)
  sync [dir]     Sync canonical source into configured or targeted rule files
  diff [dir]     Show line diff between files on disk and synced output (exits 1 on drift)
  init [dir]     Create .agent-rules.json (and AGENTS.md if missing) from detected files
  status [dir]   List detected instruction files, managed status, and token estimates

Options:
  --path <dir>            Project directory (default: .)
  --source <file>         Canonical source file (default: AGENTS.md)
  --targets <list>        Target aliases or paths, comma-separated or repeatable
  --mode <copy|pointer>   Sync mode: embed content ("copy") or link/import ("pointer")
  --max-tokens <n>        Fail check if any rule file exceeds estimated token budget
  --from <file>           For init: seed AGENTS.md from an existing rule file
  --force                 For init: overwrite existing .agent-rules.json
  --dry-run               Preview changes without writing files
  --strict                Treat warnings (contradictions, unmanaged files) as errors
  --no-links              Skip @path and Markdown link checks
  --no-contradictions     Skip cross-file package-manager contradiction checks
  --json                  Output machine-readable JSON
  -h, --help              Show this help message
  -v, --version           Show version

Known target aliases:
    ${aliases}
`;
}

/**
 * @typedef {object} ParsedArgs
 * @property {"check" | "sync" | "diff" | "init" | "status"} command
 * @property {string} dir
 * @property {string | null} source
 * @property {string[] | null} targets
 * @property {SyncMode | null} mode
 * @property {number | null} maxTokens
 * @property {string | null} from
 * @property {boolean} force
 * @property {boolean} dryRun
 * @property {boolean} strict
 * @property {boolean | null} checkLinks
 * @property {boolean | null} checkContradictions
 * @property {boolean} json
 * @property {boolean} help
 * @property {boolean} version
 */

/**
 * Parse CLI arguments.
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  /** @type {ParsedArgs} */
  const out = {
    command: "check",
    dir: ".",
    source: null,
    targets: null,
    mode: null,
    maxTokens: null,
    from: null,
    force: false,
    dryRun: false,
    strict: false,
    checkLinks: null,
    checkContradictions: null,
    json: false,
    help: false,
    version: false,
  };

  /** @type {string[]} */
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      out.help = true;
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      out.version = true;
      continue;
    }
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (arg === "--force") {
      out.force = true;
      continue;
    }
    if (arg === "--strict") {
      out.strict = true;
      continue;
    }
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (arg === "--no-links") {
      out.checkLinks = false;
      continue;
    }
    if (arg === "--no-contradictions") {
      out.checkContradictions = false;
      continue;
    }

    const readValue = (/** @type {string} */ flag) => {
      const val = argv[++i];
      if (val === undefined || val.startsWith("-")) {
        throw new Error(`Missing value for ${flag}`);
      }
      return val;
    };

    if (arg === "--path") {
      out.dir = readValue("--path");
    } else if (arg.startsWith("--path=")) {
      out.dir = arg.slice("--path=".length);
    } else if (arg === "--source") {
      out.source = readValue("--source");
    } else if (arg.startsWith("--source=")) {
      out.source = arg.slice("--source=".length);
    } else if (arg === "--targets") {
      const raw = readValue("--targets");
      out.targets = [...(out.targets ?? []), ...raw.split(",").map((s) => s.trim()).filter(Boolean)];
    } else if (arg.startsWith("--targets=")) {
      const raw = arg.slice("--targets=".length);
      out.targets = [...(out.targets ?? []), ...raw.split(",").map((s) => s.trim()).filter(Boolean)];
    } else if (arg === "--mode") {
      const raw = readValue("--mode");
      if (raw !== "copy" && raw !== "pointer") {
        throw new Error(`Invalid --mode "${raw}". Expected "copy" or "pointer".`);
      }
      out.mode = raw;
    } else if (arg.startsWith("--mode=")) {
      const raw = arg.slice("--mode=".length);
      if (raw !== "copy" && raw !== "pointer") {
        throw new Error(`Invalid --mode "${raw}". Expected "copy" or "pointer".`);
      }
      out.mode = raw;
    } else if (arg === "--max-tokens") {
      const raw = readValue("--max-tokens");
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Invalid --max-tokens "${raw}". Expected a positive integer.`);
      }
      out.maxTokens = Math.floor(n);
    } else if (arg.startsWith("--max-tokens=")) {
      const raw = arg.slice("--max-tokens=".length);
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Invalid --max-tokens "${raw}". Expected a positive integer.`);
      }
      out.maxTokens = Math.floor(n);
    } else if (arg === "--from") {
      out.from = readValue("--from");
    } else if (arg.startsWith("--from=")) {
      out.from = arg.slice("--from=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length > 0 && SUBCOMMANDS.has(positionals[0])) {
    out.command = /** @type {ParsedArgs["command"]} */ (positionals.shift());
  }
  if (positionals.length > 0) {
    out.dir = /** @type {string} */ (positionals.shift());
  }
  if (positionals.length > 0) {
    throw new Error(`Unexpected argument: ${positionals[0]}`);
  }

  return out;
}

/**
 * Resolve effective targets for a command.
 * @param {string} rootDir
 * @param {AgentRulesConfig} config
 * @param {string[] | null} cliTargets
 * @param {string[]} discovered
 * @returns {TargetConfig[]}
 */
function resolveEffectiveTargets(rootDir, config, cliTargets, discovered) {
  if (cliTargets && cliTargets.length > 0) {
    /** @type {TargetConfig[]} */
    const list = [];
    const seen = new Set();
    for (const raw of cliTargets) {
      const p = resolveTargetPath(raw);
      safeResolveInside(rootDir, p);
      if (p === config.source) {
        throw new Error(`Target "${p}" cannot be the same as source "${config.source}".`);
      }
      if (!seen.has(p)) {
        seen.add(p);
        const existingCfg = config.targets.find((t) => t.path === p);
        list.push(existingCfg ?? { path: p });
      }
    }
    return list;
  }

  if (config.targets.length > 0) {
    return config.targets;
  }

  // Fallback: auto-select discovered files (excluding source) that already have managed markers
  /** @type {TargetConfig[]} */
  const managed = [];
  for (const file of discovered) {
    if (file === config.source) continue;
    const abs = safeResolveInside(rootDir, file);
    const text = fs.readFileSync(abs, "utf8");
    if (hasManagedBlock(text)) {
      managed.push({ path: file });
    }
  }
  return managed;
}

/**
 * Run the `init` command.
 * @param {string} rootDir
 * @param {ParsedArgs} parsed
 * @param {AgentRulesConfig} config
 * @param {(msg: string) => void} stdout
 * @returns {number}
 */
function runInit(rootDir, parsed, config, stdout) {
  const configPath = path.join(rootDir, CONFIG_FILENAME);
  if (fs.existsSync(configPath) && !parsed.force) {
    throw new Error(`${CONFIG_FILENAME} already exists. Pass --force to overwrite it.`);
  }

  const discovered = discoverRuleFiles(rootDir);
  const sourcePath = config.source;
  const sourceAbs = safeResolveInside(rootDir, sourcePath);

  let createdSource = false;
  let seededFrom = null;

  if (!fs.existsSync(sourceAbs)) {
    let initialContent = "";
    if (parsed.from) {
      const fromRel = resolveTargetPath(parsed.from);
      const fromAbs = safeResolveInside(rootDir, fromRel);
      if (!fs.existsSync(fromAbs)) {
        throw new Error(`--from file not found: ${fromRel}`);
      }
      initialContent = fs.readFileSync(fromAbs, "utf8");
      seededFrom = fromRel;
    } else {
      const candidate = discovered.find((f) => f !== sourcePath);
      if (candidate) {
        initialContent = fs.readFileSync(safeResolveInside(rootDir, candidate), "utf8");
        seededFrom = candidate;
      } else {
        initialContent = [
          "# Project Instructions",
          "",
          "Canonical instructions for AI coding assistants working in this repository.",
          "",
          "## Commands",
          "",
          "- Test: `npm test`",
          "- Lint / Typecheck: `npm run typecheck`",
          "",
          "## Conventions",
          "",
          "- Keep changes focused and include tests for new behavior.",
          "- Never commit secrets, API keys, or machine-specific paths.",
          "",
        ].join("\n");
      }
    }
    if (!parsed.dryRun) {
      fs.mkdirSync(path.dirname(sourceAbs), { recursive: true });
      fs.writeFileSync(sourceAbs, initialContent, "utf8");
    }
    createdSource = true;
  }

  /** @type {string[]} */
  let targetPaths;
  if (parsed.targets && parsed.targets.length > 0) {
    targetPaths = parsed.targets
      .map((t) => resolveTargetPath(t))
      .filter((t) => t !== sourcePath);
  } else {
    const existingOthers = discovered.filter((f) => f !== sourcePath);
    targetPaths = existingOthers.length > 0
      ? existingOthers
      : ["CLAUDE.md", ".github/copilot-instructions.md", ".cursor/rules/project.mdc"];
  }

  const uniqueTargets = [...new Set(targetPaths)];
  const nextConfig = {
    source: sourcePath,
    mode: parsed.mode ?? config.mode,
    targets: uniqueTargets,
  };

  if (!parsed.dryRun) {
    fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2) + "\n", "utf8");
  }

  if (parsed.json) {
    stdout(JSON.stringify({
      ok: true,
      dryRun: parsed.dryRun,
      configFile: CONFIG_FILENAME,
      source: sourcePath,
      createdSource,
      seededFrom,
      targets: uniqueTargets,
      mode: nextConfig.mode,
    }, null, 2));
  } else {
    const prefix = parsed.dryRun ? "[dry-run] " : "";
    stdout(`${prefix}Initialized ${CONFIG_FILENAME} (source: ${sourcePath}, mode: ${nextConfig.mode})`);
    if (createdSource) {
      stdout(seededFrom
        ? `${prefix}Created ${sourcePath} seeded from ${seededFrom}`
        : `${prefix}Created starter ${sourcePath}`);
    }
    stdout(`Targets (${uniqueTargets.length}): ${uniqueTargets.join(", ")}`);
    stdout("Next: run `agent-rules-sync sync` to write managed blocks to targets.");
  }

  return 0;
}

/**
 * Run `sync` or `diff`.
 * @param {"sync" | "diff"} cmd
 * @param {string} rootDir
 * @param {ParsedArgs} parsed
 * @param {AgentRulesConfig} config
 * @param {(msg: string) => void} stdout
 * @returns {number}
 */
function runSyncOrDiff(cmd, rootDir, parsed, config, stdout) {
  const discovered = discoverRuleFiles(rootDir);
  let targets = resolveEffectiveTargets(rootDir, config, parsed.targets, discovered);

  // For `sync`, if no config targets and no managed files yet, fall back to other discovered rule files
  if (cmd === "sync" && targets.length === 0) {
    targets = discovered
      .filter((f) => f !== config.source)
      .map((f) => ({ path: f }));
  }

  if (targets.length === 0) {
    throw new Error(
      `No targets configured or detected. Run "agent-rules-sync init" or pass "--targets claude,copilot,cursor".`,
    );
  }

  const plans = buildSyncPlan(rootDir, config, targets);

  if (cmd === "diff") {
    const changed = plans.filter((p) => p.action !== "unchanged");
    const diffs = changed.map((p) => ({
      path: p.path,
      action: p.action,
      diff: formatLineDiff(p.path, p.currentContent, p.nextContent),
    }));

    if (parsed.json) {
      stdout(JSON.stringify({
        ok: changed.length === 0,
        source: config.source,
        changedCount: changed.length,
        diffs,
      }, null, 2));
    } else if (changed.length === 0) {
      stdout(`agent-rules-sync: all ${plans.length} target(s) are up to date with ${config.source}.`);
    } else {
      for (const item of diffs) {
        stdout(item.diff);
      }
    }
    return changed.length === 0 ? 0 : 1;
  }

  applySyncPlan(rootDir, plans, parsed.dryRun);

  if (parsed.json) {
    stdout(JSON.stringify({
      ok: true,
      dryRun: parsed.dryRun,
      source: config.source,
      results: plans.map((p) => ({ path: p.path, mode: p.mode, action: p.action })),
    }, null, 2));
  } else {
    const prefix = parsed.dryRun ? "[dry-run] " : "";
    for (const p of plans) {
      const label = p.action === "unchanged" ? "unchanged" : `${p.action}d`;
      stdout(`${prefix}${p.path}: ${label} (${p.mode})`);
    }
  }
  return 0;
}

/**
 * Run `check` or `status`.
 * @param {"check" | "status"} cmd
 * @param {string} rootDir
 * @param {ParsedArgs} parsed
 * @param {AgentRulesConfig} config
 * @param {(msg: string) => void} stdout
 * @returns {number}
 */
function runCheckOrStatus(cmd, rootDir, parsed, config, stdout) {
  const discovered = discoverRuleFiles(rootDir);
  const targets = resolveEffectiveTargets(rootDir, config, parsed.targets, discovered);

  const sourceAbs = safeResolveInside(rootDir, config.source);
  const sourceExists = fs.existsSync(sourceAbs);

  /** @type {Array<{ path: string, status: "in-sync" | "drifted" | "missing", mode: SyncMode }>} */
  const targetStates = [];
  if (targets.length > 0) {
    if (!sourceExists) {
      for (const t of targets) {
        targetStates.push({
          path: t.path,
          status: fs.existsSync(safeResolveInside(rootDir, t.path)) ? "drifted" : "missing",
          mode: t.mode ?? config.mode,
        });
      }
    } else {
      const plans = buildSyncPlan(rootDir, config, targets);
      for (const p of plans) {
        targetStates.push({
          path: p.path,
          status: p.action === "unchanged" ? "in-sync" : p.action === "create" ? "missing" : "drifted",
          mode: p.mode,
        });
      }
    }
  }

  const allKnownFiles = [...new Set([
    ...discovered,
    ...(sourceExists ? [config.source] : []),
    ...targets
      .map((t) => t.path)
      .filter((p) => fs.existsSync(safeResolveInside(rootDir, p))),
  ])].sort();

  const metrics = measureRuleFiles(rootDir, allKnownFiles, config.maxTokens);
  const brokenRefs = config.checkLinks ? findBrokenReferences(rootDir, allKnownFiles) : [];

  // Only inspect contradictions across files that are NOT purely identical managed copies
  const unmanagedOrDistinct = allKnownFiles.filter((file) => {
    const tState = targetStates.find((t) => t.path === file);
    return !tState || tState.status !== "in-sync";
  });
  const contradictions = config.checkContradictions
    ? findContradictions(rootDir, unmanagedOrDistinct.length > 1 ? unmanagedOrDistinct : allKnownFiles)
    : [];

  const targetPathsSet = new Set(targets.map((t) => t.path));
  const unmanagedFiles = discovered.filter(
    (f) => f !== config.source && !targetPathsSet.has(f),
  );

  const driftedCount = targetStates.filter((t) => t.status !== "in-sync").length;
  const overBudgetCount = metrics.filter((m) => m.overBudget).length;
  const missingSourceError = targets.length > 0 && !sourceExists;

  const hasErrors =
    missingSourceError ||
    driftedCount > 0 ||
    brokenRefs.length > 0 ||
    overBudgetCount > 0 ||
    (config.strict && (contradictions.length > 0 || (targets.length > 0 && unmanagedFiles.length > 0)));

  const ok = cmd === "status" ? true : !hasErrors;

  if (parsed.json) {
    stdout(JSON.stringify({
      ok,
      command: cmd,
      source: { path: config.source, exists: sourceExists },
      configFile: config.configFile,
      strict: config.strict,
      maxTokens: config.maxTokens,
      targets: targetStates,
      unmanagedFiles,
      files: metrics,
      totalEstimatedTokens: metrics.reduce((acc, m) => acc + m.estimatedTokens, 0),
      brokenRefs,
      contradictions,
    }, null, 2));
    return ok ? 0 : 1;
  }

  stdout(`agent-rules-sync (${cmd}): ${allKnownFiles.length} instruction file(s) found`);

  if (missingSourceError) {
    stdout(`Error: canonical source "${config.source}" does not exist, but ${targets.length} target(s) are configured.`);
  }

  if (targetStates.length > 0) {
    stdout("");
    stdout(`Sync status (source: ${config.source}):`);
    for (const t of targetStates) {
      stdout(`  [${t.status}] ${t.path} (${t.mode})`);
    }
  }

  if (metrics.length > 0) {
    stdout("");
    stdout("Instruction files & token estimates:");
    for (const m of metrics) {
      const budgetNote = m.overBudget ? ` OVER BUDGET (>${config.maxTokens})` : "";
      stdout(`  ${m.file}: ~${m.estimatedTokens} tokens (${m.lines} lines, ${m.bytes} bytes)${budgetNote}`);
    }
  }

  if (brokenRefs.length > 0) {
    stdout("");
    stdout(`Broken references (${brokenRefs.length}):`);
    for (const b of brokenRefs) {
      stdout(`  ${b.file}:${b.line} -> ${b.ref} (${b.kind})`);
    }
  }

  if (contradictions.length > 0) {
    stdout("");
    stdout(`Warnings - Contradictions (${contradictions.length}):`);
    for (const c of contradictions) {
      stdout(`  ${c.message}`);
      for (const occ of c.occurrences) {
        stdout(`    - ${occ.file}:${occ.line} (${occ.value})`);
      }
    }
  }

  if (unmanagedFiles.length > 0) {
    stdout("");
    stdout(`Unmanaged instruction files (${unmanagedFiles.length}): ${unmanagedFiles.join(", ")}`);
  }

  if (cmd === "check") {
    stdout("");
    stdout(ok ? "All checks passed." : "Problems found.");
  }

  return ok ? 0 : 1;
}

/**
 * Execute the CLI and return exit code (0 = ok, 1 = issues found, 2 = usage/config error).
 * @param {string[]} argv
 * @param {{ stdout?: (msg: string) => void, stderr?: (msg: string) => void }} [io]
 * @returns {Promise<number>}
 */
export async function run(argv, io = {}) {
  const stdout = io.stdout ?? ((msg) => console.log(msg));
  const stderr = io.stderr ?? ((msg) => console.error(msg));

  /** @type {ParsedArgs} */
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    stderr(`Error: ${err instanceof Error ? err.message : String(err)}`);
    stderr("Run with --help for usage.");
    return 2;
  }

  if (parsed.help) {
    stdout(helpText());
    return 0;
  }

  if (parsed.version) {
    stdout(readVersion());
    return 0;
  }

  const rootDir = path.resolve(parsed.dir);
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    stderr(`Error: directory not found: ${toPosix(parsed.dir)}`);
    return 2;
  }

  /** @type {AgentRulesConfig} */
  let config;
  try {
    config = loadConfig(rootDir);
    if (parsed.source !== null) {
      const norm = toPosix(parsed.source);
      safeResolveInside(rootDir, norm);
      config.source = norm;
    }
    if (parsed.mode !== null) {
      config.mode = parsed.mode;
    }
    if (parsed.maxTokens !== null) {
      config.maxTokens = parsed.maxTokens;
    }
    if (parsed.strict) {
      config.strict = true;
    }
    if (parsed.checkLinks !== null) {
      config.checkLinks = parsed.checkLinks;
    }
    if (parsed.checkContradictions !== null) {
      config.checkContradictions = parsed.checkContradictions;
    }
  } catch (err) {
    stderr(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  try {
    if (parsed.command === "init") {
      return runInit(rootDir, parsed, config, stdout);
    }
    if (parsed.command === "sync" || parsed.command === "diff") {
      return runSyncOrDiff(parsed.command, rootDir, parsed, config, stdout);
    }
    return runCheckOrStatus(parsed.command, rootDir, parsed, config, stdout);
  } catch (err) {
    stderr(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}
