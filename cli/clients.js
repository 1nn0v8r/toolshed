// @ts-check
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MCP_ENTRY } from "./catalog.js";

export const SERVER_KEY = "dev-context";

/**
 * Normalize a path to forward slashes so JSON configs stay clean on Windows, macOS, and Linux.
 * @param {string} p
 */
export function toPosixPath(p) {
  return path.resolve(p).replace(/\\/g, "/");
}

/**
 * Return supported MCP clients with their config paths and JSON root key.
 * @param {{ homeDir?: string, cwd?: string, platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv }} [opts]
 */
export function getClients(opts = {}) {
  const home = opts.homeDir ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;

  let claudeDesktopConfig;
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    claudeDesktopConfig = path.join(appData, "Claude", "claude_desktop_config.json");
  } else if (platform === "darwin") {
    claudeDesktopConfig = path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  } else {
    const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config");
    claudeDesktopConfig = path.join(xdg, "Claude", "claude_desktop_config.json");
  }

  return [
    {
      id: "claude-code",
      name: "Claude Code (User)",
      description: "Global Claude Code config (~/.claude.json)",
      configPath: path.join(home, ".claude.json"),
      rootKey: "mcpServers",
      needsRepoRoot: false,
      scope: "user",
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      description: "Claude Desktop app config",
      configPath: claudeDesktopConfig,
      rootKey: "mcpServers",
      needsRepoRoot: true,
      scope: "user",
    },
    {
      id: "cursor",
      name: "Cursor (User)",
      description: "Global Cursor MCP config (~/.cursor/mcp.json)",
      configPath: path.join(home, ".cursor", "mcp.json"),
      rootKey: "mcpServers",
      needsRepoRoot: false,
      scope: "user",
    },
    {
      id: "vscode",
      name: "VS Code (Workspace)",
      description: "Current workspace .vscode/mcp.json",
      configPath: path.join(cwd, ".vscode", "mcp.json"),
      rootKey: "servers",
      includeTypeStdio: true,
      needsRepoRoot: false,
      scope: "workspace",
    },
    {
      id: "windsurf",
      name: "Windsurf",
      description: "Windsurf MCP config (~/.codeium/windsurf/mcp_config.json)",
      configPath: path.join(home, ".codeium", "windsurf", "mcp_config.json"),
      rootKey: "mcpServers",
      needsRepoRoot: false,
      scope: "user",
    },
    {
      id: "gemini-cli",
      name: "Gemini CLI",
      description: "Gemini CLI settings (~/.gemini/settings.json)",
      configPath: path.join(home, ".gemini", "settings.json"),
      rootKey: "mcpServers",
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

/**
 * Inspect every supported client to see whether it exists and whether dev-context is installed.
 * @param {{ homeDir?: string, cwd?: string, platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv }} [opts]
 */
export function detectClientStatuses(opts = {}) {
  return getClients(opts).map((client) => {
    const parentExists = fs.existsSync(path.dirname(client.configPath));
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
 * Write or update the dev-context MCP entry in a client's JSON config, preserving all other keys.
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

  const { data, error } = readJsonConfig(client.configPath);
  if (error) {
    throw new Error(`Cannot update ${client.configPath}: invalid JSON (${error})`);
  }

  if (!data[client.rootKey] || typeof data[client.rootKey] !== "object" || Array.isArray(data[client.rootKey])) {
    data[client.rootKey] = {};
  }

  const repoRoot = options.repoRoot || (client.needsRepoRoot ? (options.cwd ?? process.cwd()) : undefined);
  data[client.rootKey][SERVER_KEY] = buildServerEntry({
    modules: options.modules,
    repoRoot,
    databaseUrl: options.databaseUrl,
    includeTypeStdio: Boolean(client.includeTypeStdio),
    entryPath: options.entryPath,
  });

  fs.mkdirSync(path.dirname(client.configPath), { recursive: true });
  fs.writeFileSync(client.configPath, JSON.stringify(data, null, 2) + "\n", "utf8");

  return {
    clientId: client.id,
    name: client.name,
    configPath: client.configPath,
    entry: data[client.rootKey][SERVER_KEY],
  };
}

/**
 * Remove the dev-context MCP entry from a client's JSON config, preserving all other servers.
 * @param {string} clientId
 * @param {{ homeDir?: string, cwd?: string, platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv }} [options]
 */
export function disconnectClient(clientId, options = {}) {
  const client = getClients(options).find((c) => c.id === clientId);
  if (!client) throw new Error(`Unknown client: ${clientId}`);

  const { exists, data, error } = readJsonConfig(client.configPath);
  if (!exists) return { clientId: client.id, removed: false, configPath: client.configPath };
  if (error) throw new Error(`Cannot update ${client.configPath}: invalid JSON (${error})`);

  const bucket = data[client.rootKey];
  if (!bucket || typeof bucket !== "object" || !(SERVER_KEY in bucket)) {
    return { clientId: client.id, removed: false, configPath: client.configPath };
  }

  delete bucket[SERVER_KEY];
  fs.writeFileSync(client.configPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  return { clientId: client.id, removed: true, configPath: client.configPath };
}
