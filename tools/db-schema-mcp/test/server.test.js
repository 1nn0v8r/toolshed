// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.js");
const PW = "pw" + "y".repeat(6);

/** @param {Record<string, string>} env */
function cleanEnv(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(DATABASE_URL|DB_)/.test(k)) out[k] = v;
  }
  return { ...out, ...env };
}

test("exit code 2 and a url-free message when DATABASE_URL is missing", () => {
  const r = spawnSync(process.execPath, [SERVER], { env: cleanEnv({}), encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /DATABASE_URL is not set/);
});

test("exit code 2 for an unsupported scheme, without echoing credentials", () => {
  const r = spawnSync(process.execPath, [SERVER], {
    env: cleanEnv({ DATABASE_URL: `oracle://user:${PW}@host/db` }),
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(r.status, 2);
  assert.ok(!r.stderr.includes(PW));
  assert.ok(!r.stderr.includes("user:"));
});

test("exit code 2 for an invalid DB_MAX_ROWS", () => {
  const r = spawnSync(process.execPath, [SERVER], {
    env: cleanEnv({ DATABASE_URL: `postgres://user:${PW}@127.0.0.1:1/db`, DB_MAX_ROWS: "abc" }),
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /DB_MAX_ROWS/);
});

test("server starts over stdio without a reachable database and never leaks credentials", async () => {
  // Port 1 refuses connections quickly, so tool calls fail while listing still works.
  const url = `postgres://user:${PW}@127.0.0.1:1/db`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: cleanEnv({ DATABASE_URL: url }),
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 6);
    const res = /** @type {any} */ (await client.callTool({ name: "connection_info", arguments: {} }));
    assert.equal(res.isError, true);
    const t = res.content[0].text;
    assert.ok(!t.includes(PW));
    assert.ok(!t.includes("user:"));
    const blocked = /** @type {any} */ (await client.callTool({ name: "run_select", arguments: { sql: "DROP TABLE x" } }));
    assert.match(blocked.content[0].text, /Query rejected/);
  } finally {
    await client.close();
  }
});
