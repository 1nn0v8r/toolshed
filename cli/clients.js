// @ts-check
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MCP_ENTRY } from "./catalog.js";

export const SERVER_KEY = "dev-context";

/**
 * Normalize a path to forward slashes so configs stay clean on Windows, macOS, and Linux.
 * @param {string} p
 */
export function toPosixPath(p) {
  return path.resolve(p).replace(/\\/g, "/");
}

/**
 * Resolve VS Code User config directory per platform.
 * @param {string} home
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.ProcessEnv} env
 */
function vscodeUserDir(home, platform, env) {
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Code", "User");
}

/**
 * Return supported MCP clients with their config paths, format, and root key.
 * @param {{ homeDir?: string, cwd?: string, platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv }} [opts]
 */
export function getClients(opts = {}) {
  const home = opts.homeDir ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? (opts.homeDir ? {} : process.env);

  const appData =
    platform === "win32"
      ? env.APPDATA || path.join(home, "AppData", "Roaming")
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : env.XDG_CONFIG_HOME || path.join(home, ".config");

  const vscodeUser = vscodeUserDir(home, platform, env);
  const zedConfig =
    platform === "win32"
      ? path.join(appData, "Zed", "settings.json")
      : path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "zed", "settings.json");

  return [
    {
      id: "antigravity",
      name: "Antigravity",
      description: "Antigravity global MCP config (~/.gemini/config/mcp_config.json)",
      configPath: path.join(home, ".gemini", "config", "mcp_config.json"),
      format: "json",
      rootKey: "mcpServers",
      needsRepoRoot: false,
      scope: "user",
    },
    {
      id: "claude-code",
      name: "Claude Code (User)",
      description: "Global Claude Code config (~/.claude.json)",
      configPath: path.join(home, ".claude.json"),
      format: "json",
      rootKey: "mcpServers",
      needsRepoRoot: false,
      scope: "user",
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      description: "Claude Desktop app config",
      configPath: path.join(appData, "Claude", "claude_desktop_config.json"),
      format: "json",
      rootKey: "mcpServers",
      needsRepoRoot: true,
      scope: "user",
    },
    {
      id: "codex",
      name: "OpenAI Codex CLI",
      description: "Codex CLI config (~/.codex/config.toml)",
      configPath: path.join(home, ".codex", "config.toml"),
      format: "toml",
      rootKey: "mcp_servers",
      needsRepoRoot: false,
      scope: "user",
    },
    {
      id: "cursor",
      name: "Cursor (User)",
      description: "Global Cursor MCP config (~/.cursor/mcp.json)",
      configPath: path.join(home, ".cursor", "mcp.json"),
      format: "json",
      rootKey: "mcpServers",
      needsRepoRoot: false,
      scope: "user",
    },
    {
      id: "gemini-cli",
      name: "Gemini CLI",
      description: "Gemini CLI settings (~/.gemini/settings.json)",
      configPath: path.join(home, ".gemini", "settings.json"),
      format: "json",
      rootKey: "mcpServers",
      needsRepoRoot: false,
      scope: "user",
    },
    {
      id: "windsurf",
      name: "Windsurf",
      description: "Windsurf MCP config (~/.codeium/windsurf/mcp_config.json)",
      configPath: path.join(home, ".codeium", "windsurf", "mcp_config.json"),
      format: "json",
      rootKey: "mcpServers",
      needsRepoRoot: false,
      scope: "user",
    },
    {
      id: "vscode",
      name: "VS Code (Workspace)",
      description: "Current workspace .vscode/mcp.json",
      configPath: path.join(cwd, ".vscode", "mcp.json"),
      format: "json",
      rootKey: "servers",
      includeTypeStdio: true,
      needsRepoRoot: false,
      scope: "workspace",
    },
    {
      id: "project-mcp",
      name: "Project .mcp.json",
      description: "Repo-shared .mcp.json (Claude Code project scope and compatible clients)",
      configPath: path.join(cwd, ".mcp.json"),
      format: "json",
      rootKey: "mcpServers",
      needsRepoRoot: false,
      scope: "workspace",
    },
    {
      id: "cline",
      name: "Cline (VS Code)",
      description: "Cline extension global MCP settings",
      configPath: path.join(vscodeUser, "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
      format: "json",
      rootKey: "mcpServers",
      needsRepoRoot: false,
      scope: "user",
    },
    {
      id: "roo-code",
      name: "Roo Code (VS Code)",
      description: "Roo Code extension global MCP settings",
      configPath: path.join(vscodeUser, "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json"),
      format: "json",
      rootKey: "mcpServers",
      needsRepoRoot: false,
      scope: "user",
    },
    {
      id: "zed",
      name: "Zed",
      description: "Zed editor context_servers config",
      configPath: zedConfig,
      format: "json",
      rootKey: "context_servers",
      zedFormat: true,
      needsRepoRoot: false,
      scope: "user",
    },
  ];
}

/**
 * Build the MCP server entry object for a client config.
 * @param {{
 *   modules?: string[],
 *   repoRoot?: string,
 *   databaseUrl?: string,
 *   includeTypeStdio?: boolean,
 *   zedFormat?: boolean,
 *   entryPath?: string,
 * }} [options]
 */
export function buildServerEntry(options = {}) {
  const entry = toPosixPath(options.entryPath ?? MCP_ENTRY);
  /** @type {Record<string, string>} */
  const env = {};

  if (options.modules && options.modules.length > 0) {
    env.MCP_MODULES = options.modules.join(",");
  }
  if (options.repoRoot && options.repoRoot.trim()) {
    env.REPO_ROOT = toPosixPath(options.repoRoot.trim());
  }
  if (options.databaseUrl && options.databaseUrl.trim()) {
    env.DATABASE_URL = options.databaseUrl.trim();
  }

  /** @type {Record<string, unknown>} */
  const serverDef = {
    command: "node",
    args: [entry],
  };
  if (options.includeTypeStdio) {
    serverDef.type = "stdio";
  }
  if (options.zedFormat) {
    serverDef.source = "custom";
  }
  if (Object.keys(env).length > 0) {
    serverDef.env = env;
  }
  return serverDef;
}

/**
 * Safely read a JSON config file, returning {} if missing.
 * @param {string} filePath
 */
export function readJsonConfig(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, data: {}, error: null };
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return { exists: true, data: {}, error: null };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { exists: true, data: {}, error: "Config file is not a JSON object." };
    }
    return { exists: true, data: parsed, error: null };
  } catch (err) {
    return {
      exists: true,
      data: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Minimal, safe TOML section helpers for OpenAI Codex CLI (~/.codex/config.toml)
// ---------------------------------------------------------------------------

/** @param {string} s */
function tomlString(s) {
  return JSON.stringify(String(s));
}

/**
 * Remove [mcp_servers.dev-context] and [mcp_servers.dev-context.env] sections from TOML text.
 * Preserves all other sections and comments untouched.
 * @param {string} raw
 */
function stripCodexServerSections(raw) {
  const lines = raw.split(/\r?\n/);
  /** @type {string[]} */
  const out = [];
  let skipping = false;

  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) {
      const sec = header[1].trim();
      const isOurs =
        sec === `mcp_servers.${SERVER_KEY}` ||
        sec === `mcp_servers."${SERVER_KEY}"` ||
        sec === `mcp_servers.${SERVER_KEY}.env` ||
        sec === `mcp_servers."${SERVER_KEY}".env`;
      skipping = isOurs;
      if (isOurs) continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * Render the Codex TOML section for dev-context.
 * @param {Record<string, unknown>} entry
 */
function renderCodexTomlSection(entry) {
  const args = Array.isArray(entry.args) ? entry.args.map((a) => tomlString(String(a))).join(", ") : "";
  const lines = [
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${tomlString(String(entry.command || "node"))}`,
    `args = [${args}]`,
  ];
  const env = entry.env && typeof entry.env === "object" ? /** @type {Record<string, string>} */ (entry.env) : null;
  if (env && Object.keys(env).length > 0) {
    lines.push("", `[mcp_servers.${SERVER_KEY}.env]`);
    for (const [k, v] of Object.entries(env)) {
      lines.push(`${k} = ${tomlString(v)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Inspect Codex TOML file for an existing [mcp_servers.dev-context] block.
 * @param {string} filePath
 */
function inspectCodexToml(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, connected: false, configuredModules: null, hasDatabaseUrl: false };
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  let connected = false;
  let inEnvSection = false;
  /** @type {string[] | null} */
  let configuredModules = null;
  let hasDatabaseUrl = false;

  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) {
      const sec = header[1].trim();
      if (sec === `mcp_servers.${SERVER_KEY}` || sec === `mcp_servers."${SERVER_KEY}"`) {
        connected = true;
        inEnvSection = false;
      } else if (sec === `mcp_servers.${SERVER_KEY}.env` || sec === `mcp_servers."${SERVER_KEY}".env`) {
        inEnvSection = true;
      } else {
        inEnvSection = false;
      }
      continue;
    }
    if (inEnvSection) {
      const modMatch = line.match(/^\s*MCP_MODULES\s*=\s*"([^"]*)"/);
      if (modMatch) {
        configuredModules = modMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
      }
      if (/^\s*DATABASE_URL\s*=/.test(line)) {
        hasDatabaseUrl = true;
      }
    }
  }
  return { exists: true, connected, configuredModules, hasDatabaseUrl };
}

/**
 * Inspect every supported client to see whether it exists and whether dev-context is installed.
 * @param {{ homeDir?: string, cwd?: string, platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv }} [opts]
 */
export function detectClientStatuses(opts = {}) {
  return getClients(opts).map((client) => {
    const parentExists = fs.existsSync(path.dirname(client.configPath));

    if (client.format === "toml") {
      const info = inspectCodexToml(client.configPath);
      return {
        ...client,
        configExists: info.exists,
        detected: info.exists || parentExists,
        connected: info.connected,
        configuredModules: info.configuredModules,
        hasDatabaseUrl: info.hasDatabaseUrl,
        parseError: null,
      };
    }

    const { exists, data, error } = readJsonConfig(client.configPath);
    const bucket = data[client.rootKey];
    const currentEntry =
      bucket && typeof bucket === "object" && !Array.isArray(bucket)
        ? bucket[SERVER_KEY] ?? null
        : null;
    const configuredModules =
      currentEntry && currentEntry.env && typeof currentEntry.env.MCP_MODULES === "string"
        ? currentEntry.env.MCP_MODULES.split(",").map((s) => s.trim()).filter(Boolean)
        : null;

    return {
      ...client,
      configExists: exists,
      detected: exists || parentExists,
      connected: Boolean(currentEntry),
      configuredModules,
      hasDatabaseUrl: Boolean(currentEntry && currentEntry.env && currentEntry.env.DATABASE_URL),
      parseError: error,
    };
  });
}

/**
 * Write or update the dev-context MCP entry in a client's config, preserving all other keys.
 * @param {string} clientId
 * @param {{
 *   modules?: string[],
 *   repoRoot?: string,
 *   databaseUrl?: string,
 *   entryPath?: string,
 *   homeDir?: string,
 *   cwd?: string,
 *   platform?: NodeJS.Platform,
 *   env?: NodeJS.ProcessEnv,
 * }} [options]
 */
export function connectClient(clientId, options = {}) {
  const client = getClients(options).find((c) => c.id === clientId);
  if (!client) throw new Error(`Unknown client: ${clientId}`);

  const repoRoot = options.repoRoot || (client.needsRepoRoot ? (options.cwd ?? process.cwd()) : undefined);
  const entry = buildServerEntry({
    modules: options.modules,
    repoRoot,
    databaseUrl: options.databaseUrl,
    includeTypeStdio: Boolean(client.includeTypeStdio),
    zedFormat: Boolean(client.zedFormat),
    entryPath: options.entryPath,
  });

  fs.mkdirSync(path.dirname(client.configPath), { recursive: true });

  if (client.format === "toml") {
    const existing = fs.existsSync(client.configPath) ? fs.readFileSync(client.configPath, "utf8") : "";
    const cleaned = stripCodexServerSections(existing);
    const section = renderCodexTomlSection(entry);
    const next = cleaned ? `${cleaned}\n\n${section}\n` : `${section}\n`;
    fs.writeFileSync(client.configPath, next, "utf8");
    return { clientId: client.id, name: client.name, configPath: client.configPath, entry };
  }

  const { data, error } = readJsonConfig(client.configPath);
  if (error) {
    throw new Error(`Cannot update ${client.configPath}: invalid JSON (${error})`);
  }

  if (!data[client.rootKey] || typeof data[client.rootKey] !== "object" || Array.isArray(data[client.rootKey])) {
    data[client.rootKey] = {};
  }

  data[client.rootKey][SERVER_KEY] = entry;
  fs.writeFileSync(client.configPath, JSON.stringify(data, null, 2) + "\n", "utf8");

  return {
    clientId: client.id,
    name: client.name,
    configPath: client.configPath,
    entry,
  };
}

/**
 * Remove the dev-context MCP entry from a client's config, preserving all other servers.
 * @param {string} clientId
 * @param {{ homeDir?: string, cwd?: string, platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv }} [options]
 */
export function disconnectClient(clientId, options = {}) {
  const client = getClients(options).find((c) => c.id === clientId);
  if (!client) throw new Error(`Unknown client: ${clientId}`);

  if (!fs.existsSync(client.configPath)) {
    return { clientId: client.id, removed: false, configPath: client.configPath };
  }

  if (client.format === "toml") {
    const info = inspectCodexToml(client.configPath);
    if (!info.connected) return { clientId: client.id, removed: false, configPath: client.configPath };
    const existing = fs.readFileSync(client.configPath, "utf8");
    const cleaned = stripCodexServerSections(existing);
    fs.writeFileSync(client.configPath, cleaned ? `${cleaned}\n` : "", "utf8");
    return { clientId: client.id, removed: true, configPath: client.configPath };
  }

  const { data, error } = readJsonConfig(client.configPath);
  if (error) throw new Error(`Cannot update ${client.configPath}: invalid JSON (${error})`);

  const bucket = data[client.rootKey];
  if (!bucket || typeof bucket !== "object" || !(SERVER_KEY in bucket)) {
    return { clientId: client.id, removed: false, configPath: client.configPath };
  }

  delete bucket[SERVER_KEY];
  fs.writeFileSync(client.configPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  return { clientId: client.id, removed: true, configPath: client.configPath };
}
