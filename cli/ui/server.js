// @ts-check
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CLI_TOOLS, MCP_MODULES, MCP_ENTRY } from "../catalog.js";
import {
  buildServerEntry,
  connectClient,
  detectClientStatuses,
  disconnectClient,
  toPosixPath,
} from "../clients.js";
import { ensureCliToolReady, ensureMcpReady, getInstallStatus } from "../installer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = path.join(here, "index.html");

/**
 * Read JSON body from an HTTP request (capped at 256 KB).
 * @param {http.IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * Guard against cross-origin browser requests (DNS rebinding / CSRF).
 * @param {http.IncomingMessage} req
 */
function isLocalOriginAllowed(req) {
  const host = String(req.headers.host || "");
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) return false;
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
    return false;
  }
  return true;
}

/**
 * Open a URL in the user's default browser (best-effort, non-blocking).
 * @param {string} url
 */
function openUrlInBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Best-effort only; URL is always printed to the terminal.
  }
}

/**
 * Build the HTTP server instance (exported separately for testing).
 * @param {{ homeDir?: string, cwd?: string }} [opts]
 */
export function createUiServer(opts = {}) {
  const clientOpts = {
    homeDir: opts.homeDir,
    cwd: opts.cwd ?? process.cwd(),
  };

  return http.createServer(async (req, res) => {
    if (!isLocalOriginAllowed(req)) {
      sendJson(res, 403, { ok: false, error: "Forbidden host or origin" });
      return;
    }

    const url = new URL(req.url || "/", "http://127.0.0.1");
    const method = req.method || "GET";

    try {
      if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = fs.readFileSync(INDEX_HTML_PATH, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
        return;
      }

      if (method === "GET" && url.pathname === "/api/state") {
        const install = getInstallStatus();
        const clients = detectClientStatuses(clientOpts);
        sendJson(res, 200, {
          ok: true,
          cwd: toPosixPath(clientOpts.cwd),
          mcpEntry: toPosixPath(MCP_ENTRY),
          install,
          modules: MCP_MODULES,
          clients,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/preview-config") {
        const body = await readJsonBody(req);
        const modules = Array.isArray(body.modules) ? body.modules.map(String) : undefined;
        const databaseUrl = typeof body.databaseUrl === "string" ? body.databaseUrl : undefined;
        const repoRoot = typeof body.repoRoot === "string" ? body.repoRoot : undefined;
        const entry = buildServerEntry({ modules, databaseUrl, repoRoot });
        sendJson(res, 200, {
          ok: true,
          snippet: { mcpServers: { "dev-context": entry } },
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/build-mcp") {
        const body = await readJsonBody(req);
        const result = await ensureMcpReady({ force: Boolean(body.force) });
        sendJson(res, result.ok ? 200 : 500, { ...result, install: getInstallStatus() });
        return;
      }

      if (method === "POST" && url.pathname === "/api/connect") {
        const body = await readJsonBody(req);
        const clientId = String(body.clientId || "");
        const modules = Array.isArray(body.modules) ? body.modules.map(String) : undefined;
        const databaseUrl = typeof body.databaseUrl === "string" ? body.databaseUrl : undefined;
        const repoRoot = typeof body.repoRoot === "string" ? body.repoRoot : undefined;

        const buildRes = await ensureMcpReady();
        if (!buildRes.ok) {
          sendJson(res, 500, { ok: false, error: "Failed to build dev-context-mcp", output: buildRes.output });
          return;
        }

        const result = connectClient(clientId, {
          ...clientOpts,
          modules,
          databaseUrl,
          repoRoot,
        });
        sendJson(res, 200, {
          ok: true,
          result,
          clients: detectClientStatuses(clientOpts),
          install: getInstallStatus(),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/disconnect") {
        const body = await readJsonBody(req);
        const clientId = String(body.clientId || "");
        const result = disconnectClient(clientId, clientOpts);
        sendJson(res, 200, {
          ok: true,
          result,
          clients: detectClientStatuses(clientOpts),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/install-cli") {
        const body = await readJsonBody(req);
        const toolId = String(body.toolId || "");
        const result = await ensureCliToolReady(toolId);
        sendJson(res, result.ok ? 200 : 500, { ...result, install: getInstallStatus() });
        return;
      }

      if (method === "POST" && url.pathname === "/api/run-cli-help") {
        const body = await readJsonBody(req);
        const toolId = String(body.toolId || "");
        const tool = CLI_TOOLS.find((t) => t.id === toolId);
        if (!tool) {
          sendJson(res, 404, { ok: false, error: `Unknown CLI tool: ${toolId}` });
          return;
        }
        const out = await new Promise((resolve) => {
          const child = spawn(process.execPath, [tool.entry, "--help"], {
            cwd: clientOpts.cwd,
            windowsHide: true,
          });
          let text = "";
          child.stdout.on("data", (d) => { text += d.toString("utf8"); });
          child.stderr.on("data", (d) => { text += d.toString("utf8"); });
          child.on("close", (code) => resolve({ ok: code === 0, code, output: text.trim() }));
          child.on("error", (err) => resolve({ ok: false, code: 1, output: err.message }));
        });
        sendJson(res, 200, out);
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * Start the local Web UI dashboard.
 * @param {{ port?: number, host?: string, openBrowser?: boolean }} [opts]
 */
export async function startUiServer(opts = {}) {
  const port = opts.port ?? (Number(process.env.TOOLSHED_UI_PORT) || 4317);
  const host = opts.host ?? process.env.TOOLSHED_UI_HOST ?? "127.0.0.1";
  const server = createUiServer();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(undefined));
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const url = `http://${displayHost}:${actualPort}`;

  console.log(`\ntoolshed Web UI running at ${url} (listening on ${host}:${actualPort})`);
  console.log("Press Ctrl+C to stop.\n");

  if (opts.openBrowser !== false) {
    openUrlInBrowser(url);
  }

  return { server, url, port: actualPort };
}
