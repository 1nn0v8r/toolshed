// Smoke test for dev-context-mcp.
//
// Drives the server as a real MCP child across all transports/capabilities:
//   1. stdio (full power) — root auto-detection + the core read/shell/search tools
//   2. stdio — search + fetch_url (against a local HTTP fixture)
//   3. http (hardened) — auth, capability filtering, opt-in via MCP_ALLOW_EXEC
//
// Run with:  npm test   (uses tsx; no build required)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tsxCli = path.join(here, "node_modules", "tsx", "dist", "cli.mjs");
const serverScript = path.join(here, "src", "server.ts");

// Auto-detect fixture: a throwaway git repo with a nested dist/ dir, so the
// test proves root detection climbs to the git root on any OS and machine.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-smoke-"));
fs.mkdirSync(path.join(fixtureRoot, ".git"));
fs.mkdirSync(path.join(fixtureRoot, "dist"));
const SPAWN_CWD = path.join(fixtureRoot, "dist");
const EXPECTED_DETECTED_ROOT = fs.realpathSync.native(fixtureRoot);

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => typeof v === "string"),
);

let failures = 0;
function check(label, cond, extra = "") {
  if (!cond) failures++;
  console.log(`[${cond ? "PASS" : "FAIL"}] ${label}${extra ? `  — ${extra}` : ""}`);
}

function text(res) {
  return (res.content ?? []).map((c) => c.text ?? "").join("\n");
}

async function stdioClient({ cwd = here, args = [], env = {} } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, serverScript, ...args],
    cwd,
    env: { ...cleanEnv, ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "smoke-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

function startHttp(port, env = {}) {
  return spawn(process.execPath, [tsxCli, serverScript, "--http"], {
    env: { ...cleanEnv, MCP_HTTP_PORT: String(port), REPO_ROOT: here, ...env },
    stdio: ["ignore", "ignore", "ignore"],
  });
}

async function waitHealth(port) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 125));
  }
  return false;
}

async function httpClient(port, token) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  const client = new Client({ name: "smoke-http", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function main() {
  // ── 1. stdio: auto-detect + core tools ─────────────────────────────────────
  const c = await stdioClient({ cwd: SPAWN_CWD });
  const names = (await c.listTools()).tools.map((t) => t.name);
  for (const t of ["set_repo_root", "run_command", "grep", "fetch_url", "web_search"]) {
    check(`tool registered: ${t}`, names.includes(t));
  }

  const root1 = text(await c.callTool({ name: "get_project_tree", arguments: { depth: 1 } }))
    .split("\n")[0].replace("Repo root:", "").trim();
  check("auto-detect climbs out of dist to git root", fs.realpathSync.native(root1).toLowerCase() === EXPECTED_DETECTED_ROOT.toLowerCase(), root1);

  check("get_git_status returns a branch", /Branch:/.test(text(await c.callTool({ name: "get_git_status", arguments: { commits: 3 } }))));

  const setOut = text(await c.callTool({ name: "set_repo_root", arguments: { path: here } }));
  check("set_repo_root switches root", setOut.includes("Active repo root set to"));

  check("run_command echo", text(await c.callTool({ name: "run_command", arguments: { command: "echo hello-shell" } })).includes("hello-shell"));
  check("list_directory finds server.ts", text(await c.callTool({ name: "list_directory", arguments: { path: "src" } })).includes("server.ts"));
  check("find_files matches src/server.ts", text(await c.callTool({ name: "find_files", arguments: { pattern: "**/*.ts" } })).includes("src/server.ts"));
  check("grep finds createServer", text(await c.callTool({ name: "grep", arguments: { pattern: "export function createServer" } })).includes("createServer"));

  // ── 2. stdio: search + fetch_url (local fixture) ────────────────────────────
  check("search_code finds a symbol", text(await c.callTool({ name: "search_code", arguments: { query: "resolveCapabilities" } })).includes("resolveCapabilities"));
  // find_exports now uses a real regex (the old substring form could never match).
  check("find_exports finds an export", text(await c.callTool({ name: "find_exports", arguments: { name: "getToolDefinitions" } })).includes("getToolDefinitions"));

  const fixture = http.createServer((_q, r) => { r.setHeader("content-type", "text/html"); r.end("<html><body><p>Fixture-OK-42</p><script>1</script></body></html>"); });
  await new Promise((r) => fixture.listen(39581, "127.0.0.1", r));
  const fetched = text(await c.callTool({ name: "fetch_url", arguments: { url: "http://127.0.0.1:39581/" } }));
  check("fetch_url returns page text (full power allows localhost)", fetched.includes("Fixture-OK-42"));
  check("fetch_url strips scripts/tags", !fetched.includes("<p>") && !fetched.includes("1</script"));
  fixture.close();
  await c.close();

  // ── 2b. web_search via a SearXNG fixture (hermetic) ─────────────────────────
  const sx = http.createServer((q, r) => {
    if (!(q.url ?? "").startsWith("/search")) { r.statusCode = 404; r.end("no"); return; }
    r.setHeader("content-type", "application/json");
    r.end(JSON.stringify({ results: [
      { title: "MCP", url: "https://modelcontextprotocol.io", content: "overview" },
      { title: "Second", url: "https://example.com", content: "more" },
    ] }));
  });
  await new Promise((r) => sx.listen(39584, "127.0.0.1", r));
  const cs = await stdioClient({ env: { SEARXNG_URL: "http://127.0.0.1:39584" } });
  const sres = text(await cs.callTool({ name: "web_search", arguments: { query: "model context protocol", count: 2 } }));
  check("web_search uses SearXNG backend + parses results", sres.includes("provider: searxng") && sres.includes("modelcontextprotocol.io"));
  await cs.close();
  sx.close();

  // ── 3. http: auth + capability gating ───────────────────────────────────────
  const TOKEN = "smoke-token";
  const portA = 39582;
  const a = startHttp(portA, { MCP_AUTH_TOKEN: TOKEN });
  check("http server boots", await waitHealth(portA));

  let unauth = false;
  try { await (await httpClient(portA, null)).listTools(); } catch { unauth = true; }
  check("http rejects missing token", unauth);

  const hc = await httpClient(portA, TOKEN);
  const hn = (await hc.listTools()).tools.map((t) => t.name);
  check("hardened: read tool visible", hn.includes("get_project_tree"));
  check("hardened: web tool visible", hn.includes("fetch_url"));
  check("hardened: exec tool hidden", !hn.includes("run_command"));
  check("hardened: write tool hidden", !hn.includes("write_file"));
  const denied = await hc.callTool({ name: "run_command", arguments: { command: "echo x" } });
  check("hardened: gated call denied with reason", denied.isError === true && text(denied).includes("capability"));
  await hc.close();
  a.kill();

  const portB = 39583;
  const b = startHttp(portB, { MCP_AUTH_TOKEN: TOKEN, MCP_ALLOW_EXEC: "1" });
  await waitHealth(portB);
  const hc2 = await httpClient(portB, TOKEN);
  const hn2 = (await hc2.listTools()).tools.map((t) => t.name);
  check("MCP_ALLOW_EXEC reveals run_command", hn2.includes("run_command"));
  await hc2.close();
  b.kill();

  console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
