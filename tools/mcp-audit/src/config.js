// @ts-check
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * @typedef {'error' | 'warn' | 'info'} Severity
 * @typedef {{
 *   rule: string,
 *   severity: Severity,
 *   server: string,
 *   tool?: string,
 *   message: string,
 * }} Finding
 * @typedef {{
 *   name: string,
 *   transport: 'stdio' | 'remote',
 *   command?: string,
 *   args?: string[],
 *   env?: Record<string, string>,
 *   cwd?: string,
 *   url?: string,
 *   disabled: boolean,
 * }} ServerEntry
 * @typedef {{
 *   budget: number | null,
 *   maxToolTokens: number,
 *   warnToolTokens: number,
 *   maxDescriptionChars: number,
 *   maxSchemaDepth: number,
 *   maxSchemaProps: number,
 *   timeoutMs: number,
 *   ignoreRules: string[],
 *   ignoreServers: string[],
 * }} AuditOptions
 */

/** @type {AuditOptions} */
export const DEFAULT_OPTIONS = {
  budget: null,
  maxToolTokens: 600,
  warnToolTokens: 300,
  maxDescriptionChars: 300,
  maxSchemaDepth: 4,
  maxSchemaProps: 12,
  timeoutMs: 8000,
  ignoreRules: [],
  ignoreServers: [],
};

const DEFAULT_CONFIG_CANDIDATES = [
  ".mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  "mcp.json",
];

const PLACEHOLDER_RE = /^(?:<.*>|\$\{.*\}|\{\{.*\}\}|\$[A-Z_][A-Z0-9_]*)$|changeme|placeholder|example|your[-_]|dummy|sample|xxx|\*{3,}/i;
const KNOWN_SECRET_PREFIX_RE = /^(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|glpat-[A-Za-z0-9_-]{16,})/;
const SENSITIVE_ENV_KEY_RE = /(?:key|secret|token|passw(?:or)?d|pwd|auth|credential|dsn|connection_string)/i;
const PERSONAL_PATH_RE = /(?:^|[\s"'=])((?:[A-Za-z]:\\Users\\[^\\/\s"']+|\/Users\/[^/\s"']+|\/home\/[^/\s"']+))/;

/**
 * Find the first standard MCP config file in dir.
 * @param {string} dir
 * @returns {string | null}
 */
export function discoverMcpConfig(dir) {
  for (const rel of DEFAULT_CONFIG_CANDIDATES) {
    const candidate = path.join(dir, rel);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Load `.mcp-audit.json` or `"mcp-audit"` from `package.json` in dir.
 * @param {string} dir
 * @returns {Partial<AuditOptions>}
 */
export function loadAuditRc(dir) {
  const rcPath = path.join(dir, ".mcp-audit.json");
  if (existsSync(rcPath)) {
    const raw = readJsonFile(rcPath, ".mcp-audit.json");
    return validateRc(raw, ".mcp-audit.json");
  }
  const pkgPath = path.join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg && typeof pkg === "object" && pkg["mcp-audit"] && typeof pkg["mcp-audit"] === "object") {
        return validateRc(pkg["mcp-audit"], "package.json#mcp-audit");
      }
    } catch {
      // Ignore malformed package.json when looking for optional config
    }
  }
  return {};
}

/**
 * @param {string} filePath
 * @param {string} label
 * @returns {unknown}
 */
export function readJsonFile(filePath, label) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UsageError(`Could not read ${label}: ${msg}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UsageError(`Invalid JSON in ${label}: ${msg}`);
  }
}

/**
 * @param {unknown} raw
 * @param {string} source
 * @returns {Partial<AuditOptions>}
 */
function validateRc(raw, source) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError(`Invalid config in ${source}: expected a JSON object`);
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);
  /** @type {Partial<AuditOptions>} */
  const out = {};

  const numFields = /** @type {const} */ ([
    "budget",
    "maxToolTokens",
    "warnToolTokens",
    "maxDescriptionChars",
    "maxSchemaDepth",
    "maxSchemaProps",
    "timeoutMs",
  ]);
  for (const key of numFields) {
    if (obj[key] !== undefined && obj[key] !== null) {
      if (typeof obj[key] !== "number" || !Number.isFinite(obj[key]) || obj[key] < 0) {
        throw new UsageError(`Invalid "${key}" in ${source}: expected a non-negative number`);
      }
      out[key] = obj[key];
    }
  }
  if (obj.ignoreRules !== undefined) {
    if (!Array.isArray(obj.ignoreRules) || obj.ignoreRules.some((x) => typeof x !== "string")) {
      throw new UsageError(`Invalid "ignoreRules" in ${source}: expected an array of strings`);
    }
    out.ignoreRules = obj.ignoreRules;
  }
  if (obj.ignoreServers !== undefined) {
    if (!Array.isArray(obj.ignoreServers) || obj.ignoreServers.some((x) => typeof x !== "string")) {
      throw new UsageError(`Invalid "ignoreServers" in ${source}: expected an array of strings`);
    }
    out.ignoreServers = obj.ignoreServers;
  }
  return out;
}

/**
 * Parse an MCP client config object (`.mcp.json`, `.vscode/mcp.json`, etc.).
 * @param {unknown} raw
 * @param {string} label
 * @returns {ServerEntry[]}
 */
export function parseMcpConfig(raw, label) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError(`Invalid MCP config in ${label}: expected a JSON object`);
  }
  const root = /** @type {Record<string, unknown>} */ (raw);
  const map = root.mcpServers ?? root.servers;
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    throw new UsageError(`Invalid MCP config in ${label}: expected "mcpServers" or "servers" object`);
  }

  /** @type {ServerEntry[]} */
  const entries = [];
  for (const [name, value] of Object.entries(/** @type {Record<string, unknown>} */ (map))) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new UsageError(`Invalid server entry "${name}" in ${label}: expected an object`);
    }
    const cfg = /** @type {Record<string, unknown>} */ (value);
    const disabled = cfg.disabled === true;
    const isRemote =
      cfg.type === "http" ||
      cfg.type === "sse" ||
      cfg.type === "streamable-http" ||
      (typeof cfg.url === "string" && typeof cfg.command !== "string");

    if (isRemote) {
      entries.push({
        name,
        transport: "remote",
        url: typeof cfg.url === "string" ? cfg.url : undefined,
        disabled,
      });
      continue;
    }

    if (typeof cfg.command !== "string" || cfg.command.trim() === "") {
      throw new UsageError(`Server "${name}" in ${label} is missing a "command" string`);
    }
    /** @type {string[]} */
    const args = [];
    if (cfg.args !== undefined) {
      if (!Array.isArray(cfg.args) || cfg.args.some((a) => typeof a !== "string")) {
        throw new UsageError(`Server "${name}" in ${label} has invalid "args" (expected string[])`);
      }
      args.push(...cfg.args);
    }
    /** @type {Record<string, string> | undefined} */
    let env;
    if (cfg.env !== undefined) {
      if (!cfg.env || typeof cfg.env !== "object" || Array.isArray(cfg.env)) {
        throw new UsageError(`Server "${name}" in ${label} has invalid "env" (expected object)`);
      }
      env = {};
      for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (cfg.env))) {
        env[k] = String(v);
      }
    }
    entries.push({
      name,
      transport: "stdio",
      command: cfg.command,
      args,
      env,
      cwd: typeof cfg.cwd === "string" ? cfg.cwd : undefined,
      disabled,
    });
  }
  return entries;
}

/**
 * Audit a server config entry statically (no process spawn).
 * @param {ServerEntry} entry
 * @returns {Finding[]}
 */
export function auditServerConfig(entry) {
  /** @type {Finding[]} */
  const findings = [];

  if (entry.transport === "stdio") {
    const cmd = entry.command ?? "";
    const args = entry.args ?? [];

    // 1. Unpinned npx / bunx / pnpx / uvx packages
    const unpinned = findUnpinnedPackage(cmd, args);
    if (unpinned) {
      findings.push({
        rule: "config.unpinned-npx",
        severity: "warn",
        server: entry.name,
        message: `Unpinned package "${unpinned}" in ${path.basename(cmd)} invocation; pin an explicit version to prevent dependency drift`,
      });
    }

    // 2. Machine-specific personal home paths
    const toCheck = [cmd, ...args, ...(entry.cwd ? [entry.cwd] : [])];
    for (const val of toCheck) {
      const m = PERSONAL_PATH_RE.exec(val);
      if (m) {
        findings.push({
          rule: "config.personal-path",
          severity: "warn",
          server: entry.name,
          message: `Machine-specific home path "${m[1]}" makes shared configs non-portable`,
        });
        break;
      }
    }

    // 3. Hardcoded secrets in env
    if (entry.env) {
      for (const [k, v] of Object.entries(entry.env)) {
        if (isLikelyHardcodedSecret(k, v)) {
          findings.push({
            rule: "config.hardcoded-secret",
            severity: "error",
            server: entry.name,
            message: `Env var "${k}" appears to hold a literal secret (${v.slice(0, 4)}***); use \${${k}} or a runtime env var instead`,
          });
        }
      }
    }
  }

  return findings;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {string | null}
 */
function findUnpinnedPackage(command, args) {
  const base = path.basename(command).toLowerCase().replace(/\.(?:cmd|exe|bat)$/, "");
  if (base === "npx" || base === "pnpx" || base === "bunx") {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-p" || arg === "--package") {
        const pkg = args[i + 1];
        if (pkg && !isNpmPackagePinned(pkg)) return pkg;
        i++;
        continue;
      }
      if (arg.startsWith("-")) continue;
      if (!isNpmPackagePinned(arg)) return arg;
      return null;
    }
  } else if (base === "uvx") {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--from") {
        const pkg = args[i + 1];
        if (pkg && !isPythonPackagePinned(pkg)) return pkg;
        i++;
        continue;
      }
      if (arg.startsWith("-")) continue;
      if (!isPythonPackagePinned(arg)) return arg;
      return null;
    }
  }
  return null;
}

/**
 * @param {string} pkg
 * @returns {boolean}
 */
function isNpmPackagePinned(pkg) {
  if (pkg.startsWith(".") || pkg.startsWith("/") || pkg.includes("://")) return true;
  if (pkg.startsWith("@")) {
    const slash = pkg.indexOf("/");
    if (slash === -1) return false;
    const at = pkg.indexOf("@", slash + 1);
    if (at === -1) return false;
    const ver = pkg.slice(at + 1);
    return ver.length > 0 && ver !== "latest";
  }
  const at = pkg.indexOf("@");
  if (at === -1) return false;
  const ver = pkg.slice(at + 1);
  return ver.length > 0 && ver !== "latest";
}

/**
 * @param {string} pkg
 * @returns {boolean}
 */
function isPythonPackagePinned(pkg) {
  if (pkg.startsWith(".") || pkg.startsWith("/") || pkg.includes("://")) return true;
  return /(?:==|===|@)/.test(pkg);
}

/**
 * @param {string} key
 * @param {string} value
 * @returns {boolean}
 */
function isLikelyHardcodedSecret(key, value) {
  if (!value || value.length < 12) return false;
  if (PLACEHOLDER_RE.test(value)) return false;
  if (KNOWN_SECRET_PREFIX_RE.test(value)) return true;
  if (!SENSITIVE_ENV_KEY_RE.test(key)) return false;
  // Require mixed character classes for generic sensitive env keys to avoid false positives on paths/modes
  const hasLetter = /[A-Za-z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  return hasLetter && hasDigit && value.length >= 16;
}

export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}
