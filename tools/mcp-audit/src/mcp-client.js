// @ts-check
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

/**
 * @typedef {{
 *   name: string,
 *   description?: string,
 *   inputSchema?: Record<string, unknown>,
 *   annotations?: Record<string, unknown>,
 *   [key: string]: unknown,
 * }} McpTool
 * @typedef {{
 *   name: string,
 *   description?: string,
 *   arguments?: unknown[],
 *   [key: string]: unknown,
 * }} McpPrompt
 * @typedef {{
 *   uri: string,
 *   name?: string,
 *   description?: string,
 *   mimeType?: string,
 *   [key: string]: unknown,
 * }} McpResource
 * @typedef {{
 *   serverInfo: { name?: string, version?: string },
 *   protocolVersion?: string,
 *   capabilities: Record<string, unknown>,
 *   tools: McpTool[],
 *   prompts: McpPrompt[],
 *   resources: McpResource[],
 * }} InspectResult
 */

const MAX_PAGES = 50;

/**
 * Expand `${VAR}` references in config env strings using baseEnv.
 * @param {Record<string, string> | undefined} envConfig
 * @param {NodeJS.ProcessEnv} baseEnv
 * @returns {NodeJS.ProcessEnv}
 */
export function buildChildEnv(envConfig, baseEnv = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const merged = { ...baseEnv };
  if (!envConfig) return merged;
  for (const [k, raw] of Object.entries(envConfig)) {
    merged[k] = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => baseEnv[name] ?? "");
  }
  return merged;
}

/**
 * On Windows, resolve bare commands (e.g. `npx`, `uvx`) via PATH/PATHEXT so `.cmd`/`.bat`
 * wrappers work without `shell: true` (avoids Node DEP0190 warnings).
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ command: string, args: string[] }}
 */
export function resolveCommand(command, args, env = process.env) {
  if (process.platform !== "win32") {
    return { command, args };
  }

  let resolved = command;
  const hasSep = command.includes("\\") || command.includes("/");
  const hasExt = path.extname(command) !== "";

  if (!hasSep && !hasExt) {
    const pathDirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
    const pathext = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    outer: for (const dir of pathDirs) {
      for (const ext of pathext) {
        const candidate = path.join(dir, `${command}${ext.toLowerCase()}`);
        const candidateOrig = path.join(dir, `${command}${ext}`);
        if (existsSync(candidate)) {
          resolved = candidate;
          break outer;
        }
        if (existsSync(candidateOrig)) {
          resolved = candidateOrig;
          break outer;
        }
      }
    }
  }

  const lower = resolved.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    const comspec = env.ComSpec ?? "cmd.exe";
    return { command: comspec, args: ["/d", "/c", resolved, ...args] };
  }
  return { command: resolved, args };
}

/**
 * Connect to an MCP stdio server, initialize, and collect tools, prompts, and resources.
 * @param {{
 *   command: string,
 *   args?: string[],
 *   env?: Record<string, string>,
 *   cwd?: string,
 *   timeoutMs?: number,
 * }} spec
 * @returns {Promise<InspectResult>}
 */
export async function inspectStdioServer(spec) {
  const timeoutMs = spec.timeoutMs ?? 8000;
  const childEnv = buildChildEnv(spec.env);
  const resolved = resolveCommand(spec.command, spec.args ?? [], childEnv);

  const child = spawn(resolved.command, resolved.args, {
    cwd: spec.cwd || process.cwd(),
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  /** @type {string[]} */
  const stderrChunks = [];
  child.stderr.on("data", (chunk) => {
    if (stderrChunks.length < 40) {
      stderrChunks.push(String(chunk));
    }
  });

  /** @type {Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void }>} */
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  /** @type {Error | null} */
  let spawnError = null;

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    /** @type {Record<string, unknown>} */
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      if (!waiter) return;
      if (msg.error && typeof msg.error === "object") {
        const errObj = /** @type {{ code?: number, message?: string }} */ (msg.error);
        const err = new RpcError(errObj.message ?? "MCP JSON-RPC error", errObj.code ?? -32000);
        waiter.reject(err);
      } else {
        waiter.resolve(msg.result);
      }
    }
  });

  const rejectAllPending = (/** @type {Error} */ err) => {
    for (const [, waiter] of pending) {
      waiter.reject(err);
    }
    pending.clear();
  };

  child.on("error", (err) => {
    spawnError = err;
    closed = true;
    rejectAllPending(new Error(`Failed to spawn "${spec.command}": ${err.message}`));
  });

  child.on("exit", (code, signal) => {
    closed = true;
    if (pending.size > 0 && !spawnError) {
      const stderrTail = stderrChunks.join("").trim().split(/\r?\n/).slice(-3).join(" | ");
      const detail = stderrTail ? ` (${stderrTail})` : "";
      rejectAllPending(
        new Error(`Server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})${detail}`),
      );
    }
  });

  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for MCP server "${spec.command}"`));
    }, timeoutMs);
    timer.unref();
  });

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  const request = (method, params = {}) => {
    if (closed) {
      return Promise.reject(new Error(`Cannot send "${method}": server process already exited`));
    }
    const id = nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(payload, (err) => {
        if (err && pending.has(id)) {
          pending.delete(id);
          reject(err);
        }
      });
    });
  };

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   */
  const notify = (method, params) => {
    if (closed) return;
    /** @type {Record<string, unknown>} */
    const msg = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    child.stdin.write(JSON.stringify(msg) + "\n");
  };

  /**
   * @template T
   * @param {string} method
   * @param {string} resultKey
   * @returns {Promise<T[]>}
   */
  const listPaginated = async (method, resultKey) => {
    /** @type {T[]} */
    const all = [];
    /** @type {string | undefined} */
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = cursor ? { cursor } : {};
      const res = await request(method, params);
      if (res && Array.isArray(res[resultKey])) {
        all.push(...res[resultKey]);
      }
      if (!res || typeof res.nextCursor !== "string" || res.nextCursor === "") {
        break;
      }
      cursor = res.nextCursor;
    }
    return all;
  };

  const runSession = async () => {
    const init = await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mcp-audit", version: "0.1.0" },
    });
    notify("notifications/initialized");

    const capabilities =
      init && typeof init.capabilities === "object" && init.capabilities !== null
        ? /** @type {Record<string, unknown>} */ (init.capabilities)
        : {};
    const serverInfo =
      init && typeof init.serverInfo === "object" && init.serverInfo !== null
        ? /** @type {{ name?: string, version?: string }} */ (init.serverInfo)
        : {};

    /** @type {McpTool[]} */
    let tools = [];
    if (capabilities.tools !== undefined || Object.keys(capabilities).length === 0) {
      try {
        tools = await listPaginated("tools/list", "tools");
      } catch (err) {
        if (!(err instanceof RpcError && err.code === -32601)) throw err;
      }
    }

    /** @type {McpPrompt[]} */
    let prompts = [];
    if (capabilities.prompts !== undefined) {
      try {
        prompts = await listPaginated("prompts/list", "prompts");
      } catch (err) {
        if (!(err instanceof RpcError && err.code === -32601)) throw err;
      }
    }

    /** @type {McpResource[]} */
    let resources = [];
    if (capabilities.resources !== undefined) {
      try {
        resources = await listPaginated("resources/list", "resources");
      } catch (err) {
        if (!(err instanceof RpcError && err.code === -32601)) throw err;
      }
    }

    return {
      serverInfo,
      protocolVersion: typeof init?.protocolVersion === "string" ? init.protocolVersion : undefined,
      capabilities,
      tools,
      prompts,
      resources,
    };
  };

  try {
    return /** @type {InspectResult} */ (await Promise.race([runSession(), timeoutPromise]));
  } finally {
    if (timer) clearTimeout(timer);
    rl.close();
    await terminateChild(child, () => closed);
  }
}

/**
 * Gracefully close stdin, wait briefly, then kill if needed.
 * @param {import('node:child_process').ChildProcessWithoutNullStreams} child
 * @param {() => boolean} isClosed
 */
async function terminateChild(child, isClosed) {
  try {
    if (!child.stdin.destroyed) child.stdin.end();
  } catch {
    // ignore
  }
  if (isClosed()) return;
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 150);
    t.unref();
    child.once("exit", () => {
      clearTimeout(t);
      resolve(undefined);
    });
  });
  if (!isClosed()) {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
}

export class RpcError extends Error {
  /**
   * @param {string} message
   * @param {number} code
   */
  constructor(message, code) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}
