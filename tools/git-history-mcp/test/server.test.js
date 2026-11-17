// @ts-check
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanup, EMAIL_RE, makeRepo, tmp } from "./helpers.js";

const BAD_CHARS = new RegExp("[\u2014\u2013\u2026]");

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.js");

/**
 * @param {string} cwd
 * @param {Record<string, string>} [env]
 */
async function connect(cwd, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd,
    env: /** @type {Record<string, string>} */ ({ ...process.env, ...env }),
    stderr: "ignore",
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

/**
 * @param {Client} client
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {Promise<{ text: string, isError: boolean }>}
 */
async function call(client, name, args) {
  const res = /** @type {{ content: { type: string, text: string }[], isError?: boolean }} */ (
    await client.callTool({ name, arguments: args })
  );
  return { text: res.content.map((c) => c.text).join("\n"), isError: Boolean(res.isError) };
}

/** @type {{ dir: string, shas: Record<string, string> }} */
let repo;
/** @type {Client} */
let client;
before(async () => {
  repo = makeRepo();
  client = await connect(repo.dir, { REPO_ROOT: repo.dir });
});
after(async () => {
  await client.close();
  cleanup(repo.dir);
});

test("lists the seven tools over stdio", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "blame_range",
    "churn",
    "commit_details",
    "contributors",
    "file_history",
    "line_origin",
    "search_commits",
  ]);
  for (const t of tools) assert.ok(t.description && t.inputSchema.type === "object");
});

test("every tool works end to end", async () => {
  const checks = /** @type {[string, Record<string, unknown>, RegExp][]} */ ([
    ["file_history", { path: "src/app.js" }, /init project/],
    ["blame_range", { path: "src/app.js", startLine: 1, endLine: 5 }, /L1 {2}[0-9a-f]{7}/],
    ["line_origin", { path: "src/app.js", line: 3 }, /Last changed by: .*Bob Baker/],
    ["commit_details", { sha: repo.shas.change, includePatch: true }, /\+line two changed/],
    ["search_commits", { query: "rename" }, /rename main to app/],
    ["search_commits", { query: "two changed", pickaxe: true }, /Change line two/],
    ["churn", { since: "10 years ago" }, /Most changed files/],
    ["contributors", {}, /Alice Anders/],
  ]);
  for (const [name, args, re] of checks) {
    const r = await call(client, name, args);
    assert.equal(r.isError, false, `${name}: ${r.text}`);
    assert.match(r.text, re, name);
    assert.doesNotMatch(r.text, EMAIL_RE, name);
    assert.doesNotMatch(r.text, BAD_CHARS, name);
  }
});

test("errors come back as isError results", async () => {
  const esc = await call(client, "file_history", { path: "../x" });
  assert.equal(esc.isError, true);
  assert.match(esc.text, /escapes the repo root/);
  const unknownSha = await call(client, "commit_details", { sha: "0123456789abcdef" });
  assert.equal(unknownSha.isError, true);
  assert.match(unknownSha.text, /Unknown commit/);
  const unknownTool = await call(client, "nope", {});
  assert.equal(unknownTool.isError, true);
  assert.match(unknownTool.text, /Unknown tool/);
  const noArgs = await client.callTool({ name: "contributors" });
  assert.notEqual(noArgs.isError, true);
});

test("non-git root gives a clear error and repoRoot override recovers", async () => {
  const dir = tmp();
  const c = await connect(dir, { REPO_ROOT: dir });
  try {
    const bad = await call(c, "contributors", {});
    assert.equal(bad.isError, true);
    assert.match(bad.text, /Not a git repository/);
    const ok = await call(c, "contributors", { repoRoot: repo.dir });
    assert.equal(ok.isError, false);
    assert.match(ok.text, /Bob Baker/);
  } finally {
    await c.close();
    cleanup(dir);
  }
});

test("without REPO_ROOT the server roots at the nearest git root above cwd", async () => {
  const env = { ...process.env };
  delete env.REPO_ROOT;
  const sub = path.join(repo.dir, "src");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: sub,
    env: /** @type {Record<string, string>} */ (env),
    stderr: "ignore",
  });
  const c = new Client({ name: "test-client", version: "0.0.0" });
  await c.connect(transport);
  try {
    const r = await call(c, "file_history", { path: "README.md" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /update readme/);
  } finally {
    await c.close();
  }
});
