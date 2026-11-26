// @ts-check
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { scanInjectionAndExfil, scanUnicode } from "./rules.js";

/**
 * @typedef {import("./rules.js").Finding} Finding
 * @typedef {{
 *   name: string,
 *   command?: string,
 *   args?: string[],
 *   env?: Record<string, string>,
 *   url?: string,
 * }} McpServerEntry
 */

const CANDIDATE_MCP_CONFIGS = [
  ".mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  "mcp.json",
];

const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh"]);

/**
 * Discover MCP config files inside `rootDir`.
 * @param {string} rootDir
 * @returns {string[]}
 */
export function discoverMcpConfigs(rootDir) {
  /** @type {string[]} */
  const found = [];
  for (const rel of CANDIDATE_MCP_CONFIGS) {
    const abs = path.join(rootDir, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      found.push(abs);
    }
  }
  return found;
}

/**
 * Parse a client MCP config JSON file into normalized server entries.
 * @param {string} configPath
 * @returns {McpServerEntry[]}
 */
export function parseMcpConfig(configPath) {
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid MCP config in ${configPath}: expected JSON object`);
  }
  const bag = raw.mcpServers ?? raw.servers ?? raw.context_servers ?? {};
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) {
    return [];
  }

  /** @type {McpServerEntry[]} */
  const entries = [];
  for (const [name, val] of Object.entries(bag)) {
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    entries.push({
      name,
      command: typeof val.command === "string" ? val.command : undefined,
      args: Array.isArray(val.args) ? val.args.map(String) : undefined,
      env: val.env && typeof val.env === "object" && !Array.isArray(val.env) ? val.env : undefined,
      url: typeof val.url === "string" ? val.url : undefined,
    });
  }
  return entries;
}

/**
 * Check if a package spec like "@org/pkg@1.2.3" or "pkg==1.0" has an explicit version pin.
 * @param {string} pkgSpec
 * @returns {boolean}
 */
function hasVersionPin(pkgSpec) {
  if (pkgSpec.startsWith("@")) {
    const slash = pkgSpec.indexOf("/");
    if (slash === -1) return false;
    return pkgSpec.slice(slash + 1).includes("@");
  }
  return pkgSpec.includes("@") || pkgSpec.includes("==");
}

/**
 * Check if an HTTP URL points to localhost / loopback.
 * @param {string} rawUrl
 * @returns {boolean}
 */
function isLocalHttpUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1" || u.hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Statically audit an MCP config file and its server entries.
 * @param {string} configPath
 * @param {string} fileLabel
 * @param {{ strictUnicode?: boolean }} [opts]
 * @returns {{ entries: McpServerEntry[], findings: Finding[] }}
 */
export function auditMcpConfigStatic(configPath, fileLabel, opts = {}) {
  const rawText = fs.readFileSync(configPath, "utf8");
  const entries = parseMcpConfig(configPath);
  /** @type {Finding[]} */
  const findings = [
    ...scanUnicode(rawText, fileLabel, { strictUnicode: opts.strictUnicode }),
    ...scanInjectionAndExfil(rawText, fileLabel, { checkMcpShadowing: true }),
  ];

  for (const entry of entries) {
    if (entry.url && entry.url.startsWith("http://") && !isLocalHttpUrl(entry.url)) {
      findings.push({
        ruleId: "mcp.untrusted-command",
        category: "mcp",
        severity: "warn",
        file: fileLabel,
        line: 1,
        column: 1,
        message: `MCP server "${entry.name}" uses plaintext http:// remote endpoint (${entry.url})`,
      });
    }

    if (entry.command) {
      const cmdBase = path.basename(entry.command).toLowerCase();
      const args = entry.args ?? [];
      if (SHELL_WRAPPERS.has(cmdBase) && args.some((a) => /^(-c|\/c|-command)$/i.test(a))) {
        findings.push({
          ruleId: "mcp.untrusted-command",
          category: "mcp",
          severity: "warn",
          file: fileLabel,
          line: 1,
          column: 1,
          message: `MCP server "${entry.name}" launches via shell wrapper (${entry.command} ${args.join(" ")})`,
        });
      }

      if (cmdBase === "npx" || cmdBase === "npx.cmd" || cmdBase === "uvx") {
        const pkgArg = args.find((a) => !a.startsWith("-"));
        const autoYes = args.includes("-y") || args.includes("--yes");
        if (pkgArg && !hasVersionPin(pkgArg) && (autoYes || cmdBase === "uvx")) {
          findings.push({
            ruleId: "mcp.untrusted-command",
            category: "mcp",
            severity: "warn",
            file: fileLabel,
            line: 1,
            column: 1,
            message: `MCP server "${entry.name}" runs unpinned remote package (${cmdBase} ${pkgArg})`,
          });
        }
      }
    }
  }

  return { entries, findings };
}

/**
 * Recursively collect string fields from a JSON schema or MCP object.
 * @param {unknown} val
 * @param {string} prefix
 * @param {Array<{ fieldPath: string, text: string }>} out
 */
function collectStrings(val, prefix, out) {
  if (typeof val === "string") {
    if (val.length > 0) out.push({ fieldPath: prefix, text: val });
    return;
  }
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      collectStrings(val[i], `${prefix}[${i}]`, out);
    }
    return;
  }
  if (val && typeof val === "object") {
    for (const [k, v] of Object.entries(val)) {
      collectStrings(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
}

/**
 * Scan a parsed MCP tools/list, prompts/list, or resources/list payload for poisoning & smuggling.
 * @param {unknown} payload
 * @param {string} sourceLabel
 * @param {{ strictUnicode?: boolean }} [opts]
 * @returns {{ itemCount: number, findings: Finding[] }}
 */
export function scanMcpPayload(payload, sourceLabel, opts = {}) {
  /** @type {Finding[]} */
  const findings = [];
  let itemCount = 0;

  /** @type {Record<string, unknown>} */
  const root =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? /** @type {Record<string, unknown>} */ (
          "result" in payload && payload.result && typeof payload.result === "object"
            ? payload.result
            : payload
        )
      : { tools: Array.isArray(payload) ? payload : [] };

  const sections = ["tools", "prompts", "resources"];
  for (const section of sections) {
    const arr = root[section];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      itemCount += 1;
      const itemName =
        item && typeof item === "object" && "name" in item && typeof item.name === "string"
          ? item.name
          : `#${itemCount}`;
      const label = `${sourceLabel}:${section}/${itemName}`;
      /** @type {Array<{ fieldPath: string, text: string }>} */
      const strings = [];
      collectStrings(item, "", strings);
      for (const s of strings) {
        const fieldLabel = s.fieldPath ? `${label}.${s.fieldPath}` : label;
        findings.push(
          ...scanUnicode(s.text, fieldLabel, { strictUnicode: opts.strictUnicode }),
          ...scanInjectionAndExfil(s.text, fieldLabel, { checkMcpShadowing: true }),
        );
      }
    }
  }

  return { itemCount, findings };
}

/**
 * Spawn a stdio MCP server, query tools/prompts/resources, and scan returned schemas.
 * @param {string} serverName
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: Record<string, string>, cwd?: string, timeoutMs?: number, strictUnicode?: boolean }} [opts]
 * @returns {Promise<{ itemCount: number, findings: Finding[], error?: string }>}
 */
export async function inspectStdioMcpServer(serverName, command, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 8000;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    /** @type {Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void }>} */
    const pending = new Map();
    let nextId = 1;
    let buf = "";
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // ignore
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve({
        itemCount: 0,
        findings: [],
        error: `Timed out after ${timeoutMs}ms waiting for MCP server "${serverName}"`,
      });
    }, timeoutMs);

    child.on("error", (err) => {
      cleanup();
      resolve({
        itemCount: 0,
        findings: [],
        error: `Failed to start MCP server "${serverName}": ${err.message}`,
      });
    });

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try {
            const msg = JSON.parse(line);
            if (typeof msg.id === "number" && pending.has(msg.id)) {
              const p = pending.get(msg.id);
              pending.delete(msg.id);
              if (msg.error) {
                p?.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              } else {
                p?.resolve(msg.result);
              }
            }
          } catch {
            // ignore non-JSON stdout noise
          }
        }
        nl = buf.indexOf("\n");
      }
    });

    /** @param {string} method @param {unknown} params */
    const request = (method, params) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    (async () => {
      try {
        await request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "prompt-shield", version: "0.1.0" },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

        /** @type {Record<string, unknown>} */
        const combined = {};
        for (const [method, key] of [
          ["tools/list", "tools"],
          ["prompts/list", "prompts"],
          ["resources/list", "resources"],
        ]) {
          try {
            const res = /** @type {Record<string, unknown> | undefined} */ (await request(method, {}));
            if (res && Array.isArray(res[key])) {
              combined[key] = res[key];
            }
          } catch {
            // Server may not implement optional capabilities like prompts or resources
          }
        }

        cleanup();
        const scanned = scanMcpPayload(combined, `mcp:${serverName}`, {
          strictUnicode: opts.strictUnicode,
        });
        resolve(scanned);
      } catch (err) {
        cleanup();
        resolve({
          itemCount: 0,
          findings: [],
          error: `MCP handshake failed for "${serverName}": ${/** @type {Error} */ (err).message}`,
        });
      }
    })();
  });
}
