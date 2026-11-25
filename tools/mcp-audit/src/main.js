// @ts-check
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReport, formatHumanReport } from "./analyzer.js";
import {
  auditServerConfig,
  DEFAULT_OPTIONS,
  discoverMcpConfig,
  loadAuditRc,
  parseMcpConfig,
  readJsonFile,
  UsageError,
} from "./config.js";
import { inspectStdioServer } from "./mcp-client.js";

/**
 * @typedef {import('./analyzer.js').ServerAuditInput} ServerAuditInput
 * @typedef {import('./config.js').AuditOptions} AuditOptions
 * @typedef {import('./mcp-client.js').McpTool} McpTool
 * @typedef {import('./mcp-client.js').McpPrompt} McpPrompt
 * @typedef {import('./mcp-client.js').McpResource} McpResource
 */

const HELP_TEXT = `mcp-audit - Audit MCP servers and client configs for upfront token tax and schema bloat

Usage:
  mcp-audit [dir | config-file] [options]
  mcp-audit [options] -- <command> [args...]
  mcp-audit --from-json <file | -> [options]

Options:
  --config <file>            MCP config file (.mcp.json, .cursor/mcp.json, .vscode/mcp.json)
  --from-json <file>         Audit a saved tools/list JSON payload (or "-" for stdin)
  --server <name>            Only audit the named server (repeatable)
  --budget <tokens>          Fail (exit 1) when total estimated tokens exceed <tokens>
  --max-tool-tokens <n>      Error threshold per tool (default: 600)
  --warn-tool-tokens <n>     Warning threshold per tool (default: 300)
  --top <n>                  Show top N largest tools in text output (default: 10, 0 = all)
  --timeout <ms>             Per-server stdio handshake timeout in ms (default: 8000)
  --no-connect, --static     Audit config statically without spawning MCP servers
  --ignore-rule <rule>       Suppress a lint rule ID (repeatable)
  --strict                   Treat warnings as errors (exit 1)
  --verbose                  Include info-level findings in text output
  --json                     Print the full report as JSON
  -h, --help                 Show this help message
  -v, --version              Show version
`;

/**
 * Read package.json version.
 * @returns {string}
 */
function readVersion() {
  const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const dashDash = argv.indexOf("--");
  const flagArgs = dashDash === -1 ? argv : argv.slice(0, dashDash);
  const directCommand = dashDash === -1 ? [] : argv.slice(dashDash + 1);

  /** @type {{
   *   help: boolean,
   *   version: boolean,
   *   target?: string,
   *   config?: string,
   *   fromJson?: string,
   *   servers: string[],
   *   budget?: number,
   *   maxToolTokens?: number,
   *   warnToolTokens?: number,
   *   top: number,
   *   timeoutMs?: number,
   *   noConnect: boolean,
   *   ignoreRules: string[],
   *   strict: boolean,
   *   verbose: boolean,
   *   json: boolean,
   *   directCommand: string[],
   * }} */
  const parsed = {
    help: false,
    version: false,
    servers: [],
    top: 10,
    noConnect: false,
    ignoreRules: [],
    strict: false,
    verbose: false,
    json: false,
    directCommand,
  };

  /** @param {string} flag @param {string | undefined} val */
  const requireStr = (flag, val) => {
    if (val === undefined) throw new UsageError(`Option ${flag} requires a value`);
    return val;
  };

  /** @param {string} flag @param {string | undefined} val */
  const requireInt = (flag, val) => {
    const s = requireStr(flag, val);
    if (!/^\d+$/.test(s)) throw new UsageError(`Option ${flag} expects a non-negative integer, got "${s}"`);
    return Number.parseInt(s, 10);
  };

  for (let i = 0; i < flagArgs.length; i++) {
    const arg = flagArgs[i];
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
    } else if (arg === "-v" || arg === "--version") {
      parsed.version = true;
    } else if (arg === "--config") {
      parsed.config = requireStr(arg, flagArgs[++i]);
    } else if (arg.startsWith("--config=")) {
      parsed.config = arg.slice("--config=".length);
    } else if (arg === "--from-json") {
      parsed.fromJson = requireStr(arg, flagArgs[++i]);
    } else if (arg.startsWith("--from-json=")) {
      parsed.fromJson = arg.slice("--from-json=".length);
    } else if (arg === "--server") {
      parsed.servers.push(requireStr(arg, flagArgs[++i]));
    } else if (arg.startsWith("--server=")) {
      parsed.servers.push(arg.slice("--server=".length));
    } else if (arg === "--budget") {
      parsed.budget = requireInt(arg, flagArgs[++i]);
    } else if (arg.startsWith("--budget=")) {
      parsed.budget = requireInt("--budget", arg.slice("--budget=".length));
    } else if (arg === "--max-tool-tokens") {
      parsed.maxToolTokens = requireInt(arg, flagArgs[++i]);
    } else if (arg.startsWith("--max-tool-tokens=")) {
      parsed.maxToolTokens = requireInt("--max-tool-tokens", arg.slice("--max-tool-tokens=".length));
    } else if (arg === "--warn-tool-tokens") {
      parsed.warnToolTokens = requireInt(arg, flagArgs[++i]);
    } else if (arg.startsWith("--warn-tool-tokens=")) {
      parsed.warnToolTokens = requireInt("--warn-tool-tokens", arg.slice("--warn-tool-tokens=".length));
    } else if (arg === "--top") {
      parsed.top = requireInt(arg, flagArgs[++i]);
    } else if (arg.startsWith("--top=")) {
      parsed.top = requireInt("--top", arg.slice("--top=".length));
    } else if (arg === "--timeout") {
      parsed.timeoutMs = requireInt(arg, flagArgs[++i]);
    } else if (arg.startsWith("--timeout=")) {
      parsed.timeoutMs = requireInt("--timeout", arg.slice("--timeout=".length));
    } else if (arg === "--no-connect" || arg === "--static") {
      parsed.noConnect = true;
    } else if (arg === "--ignore-rule") {
      parsed.ignoreRules.push(requireStr(arg, flagArgs[++i]));
    } else if (arg.startsWith("--ignore-rule=")) {
      parsed.ignoreRules.push(arg.slice("--ignore-rule=".length));
    } else if (arg === "--strict") {
      parsed.strict = true;
    } else if (arg === "--verbose") {
      parsed.verbose = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else {
      if (parsed.target !== undefined) {
        throw new UsageError(`Unexpected positional argument: ${arg}`);
      }
      parsed.target = arg;
    }
  }

  if (dashDash !== -1 && directCommand.length === 0) {
    throw new UsageError(`Expected a command after "--"`);
  }

  return parsed;
}

/**
 * Extract tools/prompts/resources from a saved JSON payload.
 * @param {unknown} raw
 * @param {string} label
 * @returns {{ tools: McpTool[], prompts: McpPrompt[], resources: McpResource[] }}
 */
function normalizeJsonPayload(raw, label) {
  if (Array.isArray(raw)) {
    return { tools: /** @type {McpTool[]} */ (raw), prompts: [], resources: [] };
  }
  if (!raw || typeof raw !== "object") {
    throw new UsageError(`Invalid JSON payload in ${label}: expected object or tool array`);
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const container =
    obj.result && typeof obj.result === "object" && !Array.isArray(obj.result)
      ? /** @type {Record<string, unknown>} */ (obj.result)
      : obj;

  const tools = Array.isArray(container.tools) ? /** @type {McpTool[]} */ (container.tools) : [];
  const prompts = Array.isArray(container.prompts) ? /** @type {McpPrompt[]} */ (container.prompts) : [];
  const resources = Array.isArray(container.resources)
    ? /** @type {McpResource[]} */ (container.resources)
    : [];

  if (!Array.isArray(container.tools) && !Array.isArray(container.prompts) && !Array.isArray(container.resources)) {
    throw new UsageError(`Invalid JSON payload in ${label}: expected "tools" array`);
  }
  return { tools, prompts, resources };
}

/**
 * Run the CLI with the given arguments and IO context.
 * @param {string[]} argv
 * @param {{
 *   cwd: string,
 *   out: (s: string) => void,
 *   err: (s: string) => void,
 *   stdinText?: string,
 *   inspectFn?: typeof inspectStdioServer,
 * }} io
 * @returns {Promise<number>}
 */
export async function run(argv, io) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      io.out(HELP_TEXT);
      return 0;
    }
    if (args.version) {
      io.out(`mcp-audit ${readVersion()}\n`);
      return 0;
    }

    const resolvedTarget = args.target ? path.resolve(io.cwd, args.target) : null;
    const baseDir =
      resolvedTarget && existsSync(resolvedTarget) && statSync(resolvedTarget).isDirectory()
        ? resolvedTarget
        : io.cwd;
    const rc = loadAuditRc(baseDir);

    /** @type {AuditOptions} */
    const options = {
      ...DEFAULT_OPTIONS,
      ...rc,
      ...(args.budget !== undefined ? { budget: args.budget } : {}),
      ...(args.maxToolTokens !== undefined ? { maxToolTokens: args.maxToolTokens } : {}),
      ...(args.warnToolTokens !== undefined ? { warnToolTokens: args.warnToolTokens } : {}),
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      ignoreRules: [...(rc.ignoreRules ?? []), ...args.ignoreRules],
      ignoreServers: rc.ignoreServers ?? [],
    };

    const inspect = io.inspectFn ?? inspectStdioServer;
    /** @type {ServerAuditInput[]} */
    const serverInputs = [];
    let sourceLabel = "";

    if (args.fromJson !== undefined) {
      let raw;
      if (args.fromJson === "-") {
        sourceLabel = "<stdin>";
        const text = io.stdinText ?? readFileSync(0, "utf8");
        try {
          raw = JSON.parse(text);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new UsageError(`Invalid JSON from stdin: ${msg}`);
        }
      } else {
        const jsonPath = path.resolve(io.cwd, args.fromJson);
        sourceLabel = path.relative(io.cwd, jsonPath).replace(/\\/g, "/") || path.basename(jsonPath);
        raw = readJsonFile(jsonPath, args.fromJson);
      }
      const payload = normalizeJsonPayload(raw, sourceLabel);
      serverInputs.push({
        name: path.basename(sourceLabel, path.extname(sourceLabel)) || "json-input",
        transport: "json",
        status: "ok",
        tools: payload.tools,
        prompts: payload.prompts,
        resources: payload.resources,
        staticFindings: [],
      });
    } else if (args.directCommand.length > 0) {
      const [command, ...cmdArgs] = args.directCommand;
      sourceLabel = `${command} ${cmdArgs.join(" ")}`.trim();
      const serverName = path.basename(command);
      try {
        const inspected = await inspect({
          command,
          args: cmdArgs,
          cwd: baseDir,
          timeoutMs: options.timeoutMs,
        });
        serverInputs.push({
          name: inspected.serverInfo?.name || serverName,
          transport: "stdio",
          status: "ok",
          serverInfo: inspected.serverInfo,
          protocolVersion: inspected.protocolVersion,
          tools: inspected.tools,
          prompts: inspected.prompts,
          resources: inspected.resources,
          staticFindings: [],
        });
      } catch (err) {
        serverInputs.push({
          name: serverName,
          transport: "stdio",
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          tools: [],
          prompts: [],
          resources: [],
          staticFindings: [],
        });
      }
    } else {
      let configPath = args.config ? path.resolve(io.cwd, args.config) : undefined;
      if (!configPath && args.target) {
        const candidate = path.resolve(io.cwd, args.target);
        if (!existsSync(candidate)) {
          throw new UsageError(`Path not found: ${args.target}`);
        }
        if (statSync(candidate).isDirectory()) {
          configPath = discoverMcpConfig(candidate) ?? undefined;
          if (!configPath) {
            throw new UsageError(`No MCP config (.mcp.json, .cursor/mcp.json, .vscode/mcp.json) found in ${args.target}`);
          }
        } else {
          configPath = candidate;
        }
      }
      if (!configPath) {
        configPath = discoverMcpConfig(io.cwd) ?? undefined;
        if (!configPath) {
          throw new UsageError(
            `No MCP config found in ${io.cwd}. Pass --config <file>, --from-json <file>, or -- <command> [args...]`,
          );
        }
      }
      if (!existsSync(configPath)) {
        throw new UsageError(`Config file not found: ${configPath}`);
      }

      sourceLabel = path.relative(io.cwd, configPath).replace(/\\/g, "/") || path.basename(configPath);
      const rawCfg = readJsonFile(configPath, sourceLabel);
      const entries = parseMcpConfig(rawCfg, sourceLabel);
      const ignoredServers = new Set(options.ignoreServers);
      const filterSet = args.servers.length > 0 ? new Set(args.servers) : null;

      for (const entry of entries) {
        if (filterSet && !filterSet.has(entry.name)) continue;
        if (ignoredServers.has(entry.name)) continue;

        const staticFindings = auditServerConfig(entry);
        if (entry.disabled) {
          serverInputs.push({
            name: entry.name,
            transport: entry.transport,
            status: "disabled",
            tools: [],
            prompts: [],
            resources: [],
            staticFindings,
          });
          continue;
        }
        if (entry.transport === "remote" || args.noConnect) {
          serverInputs.push({
            name: entry.name,
            transport: entry.transport,
            status: "skipped",
            tools: [],
            prompts: [],
            resources: [],
            staticFindings,
          });
          continue;
        }

        try {
          const inspected = await inspect({
            command: entry.command ?? "",
            args: entry.args ?? [],
            env: entry.env,
            cwd: entry.cwd ? path.resolve(path.dirname(configPath), entry.cwd) : path.dirname(configPath),
            timeoutMs: options.timeoutMs,
          });
          serverInputs.push({
            name: entry.name,
            transport: "stdio",
            status: "ok",
            serverInfo: inspected.serverInfo,
            protocolVersion: inspected.protocolVersion,
            tools: inspected.tools,
            prompts: inspected.prompts,
            resources: inspected.resources,
            staticFindings,
          });
        } catch (err) {
          serverInputs.push({
            name: entry.name,
            transport: "stdio",
            status: "error",
            error: err instanceof Error ? err.message : String(err),
            tools: [],
            prompts: [],
            resources: [],
            staticFindings,
          });
        }
      }

      if (filterSet && serverInputs.length === 0) {
        throw new UsageError(`None of the requested servers (${args.servers.join(", ")}) were found in ${sourceLabel}`);
      }
    }

    const report = buildReport({
      source: sourceLabel,
      servers: serverInputs,
      options,
      strict: args.strict,
      top: args.top,
    });

    if (args.json) {
      io.out(JSON.stringify(report, null, 2) + "\n");
    } else {
      io.out(formatHumanReport(report, { showInfo: args.verbose }));
    }

    return report.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`mcp-audit: ${err.message}\n`);
      return 2;
    }
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`mcp-audit: ${msg}\n`);
    return 2;
  }
}
