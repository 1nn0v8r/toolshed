// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp } from "../../modules/db-schema/app.js";
import { callTool, clampInt, resolveTable, ToolError, TOOLS } from "../../modules/db-schema/tools.js";

const PW = "pw" + "x".repeat(6);
const URL_WITH_PW = `postgres://user:${PW}@db.example.com:5432/app`;
/** @type {import("../../modules/db-schema/config.js").Config} */
const config = { kind: "postgres", url: URL_WITH_PW, schema: "public", maxRows: 3, timeoutMs: 1234 };

/** Fake database recording queries. */
function fakeDb(overrides = {}) {
  /** @type {{ sql: string, opts: any }[]} */
  const calls = [];
  /** @type {import("../../modules/db-schema/db.js").Database} */
  const db = {
    kind: "postgres",
    schema: "public",
    quoteIdent: (n) => `"${n.replace(/"/g, '""')}"`,
    async runReadOnly(sql, opts) {
      calls.push({ sql, opts });
      return {
        columns: ["id", "password_hash", "note"],
        rows: [[1, "abc", "x".repeat(300)], [2, null, "n"]],
        truncated: false,
      };
    },
    async listTables() {
      return [
        { name: "customers", kind: "table", estRows: 10, comment: "people" },
        { name: "Orders", kind: "table", estRows: null, comment: null },
        { name: 'we"ird', kind: "view", estRows: null, comment: null },
      ];
    },
    async foreignKeys() {
      return [{ name: "f", table: "orders", columns: ["customer_id"], refTable: "customers", refColumns: ["id"] }];
    },
    async describeTable(name) {
      return {
        name, kind: "table", comment: null, estRows: 1, columns: [{ name: "id", type: "int", nullable: false, default: null, comment: null }],
        primaryKey: ["id"], foreignKeys: [], incoming: [], unique: [], indexes: [],
      };
    },
    async connectionInfo() {
      return { kind: "postgres", version: "PostgreSQL 17.0", database: "app", schema: "public", readOnly: true };
    },
    async close() {},
    ...overrides,
  };
  return { db, calls };
}

/** @param {import("../../modules/db-schema/db.js").Database} db */
async function connect(db) {
  const app = createApp(config, () => db);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([app.server.connect(a), client.connect(b)]);
  return { client, app };
}

/** @param {any} res */
const text = (res) => res.content[0].text;

test("clampInt", () => {
  assert.equal(clampInt(undefined, 5, 1, 20), 5);
  assert.equal(clampInt("7", 5, 1, 20), 7);
  assert.equal(clampInt("", 5, 1, 20), 5);
  assert.equal(clampInt(99, 5, 1, 20), 20);
  assert.equal(clampInt(0, 5, 1, 20), 1);
  assert.equal(clampInt(2.9, 5, 1, 20), 2);
  assert.equal(clampInt(NaN, 5, 1, 20), 5);
  assert.equal(clampInt({}, 5, 1, 20), 5);
});

test("resolveTable: exact, case-insensitive, schema prefix and not found", async () => {
  const { db } = fakeDb();
  assert.equal((await resolveTable(db, "customers")).name, "customers");
  assert.equal((await resolveTable(db, "orders")).name, "Orders");
  assert.equal((await resolveTable(db, "public.customers")).name, "customers");
  await assert.rejects(() => resolveTable(db, "nope"), /table not found: nope\. Available: customers, Orders/);
  await assert.rejects(() => resolveTable(db, ""), ToolError);
  await assert.rejects(() => resolveTable(db, 5), /required/);
  const many = fakeDb({ listTables: async () => Array.from({ length: 25 }, (_, i) => ({ name: `t${i}`, kind: "table", estRows: 0, comment: null })) });
  await assert.rejects(() => resolveTable(many.db, "zzz"), /and 5 more/);
});

test("server lists all six tools with schemas", async () => {
  const { client, app } = await connect(fakeDb().db);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["connection_info", "describe_table", "list_relationships", "list_tables", "run_select", "sample_rows"]
  );
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.description && t.description.length > 10);
  }
  assert.equal(TOOLS.length, 6);
  await client.close();
  await app.close();
});

test("tool outputs through a real client", async () => {
  const { db, calls } = fakeDb();
  const { client, app } = await connect(db);

  const lt = text(await client.callTool({ name: "list_tables", arguments: {} }));
  assert.ok(lt.includes("customers") && lt.includes("people") && lt.includes("?"));
  assert.ok(lt.endsWith("(3 tables)"));

  const dt = text(await client.callTool({ name: "describe_table", arguments: { table: "orders" } }));
  assert.ok(dt.startsWith("Orders (table"));

  const rel = text(await client.callTool({ name: "list_relationships", arguments: {} }));
  assert.ok(rel.startsWith("orders.customer_id -> customers.id"));

  const ci = text(await client.callTool({ name: "connection_info", arguments: {} }));
  assert.ok(ci.includes("kind: postgres") && ci.includes("read-only: yes") && ci.includes("statement timeout: 1234 ms"));
  assert.ok(!ci.includes(PW) && !ci.includes("user"));

  const sr = text(await client.callTool({ name: "sample_rows", arguments: { table: "customers", limit: 100 } }));
  assert.equal(calls.at(-1)?.sql, 'SELECT * FROM "public"."customers" LIMIT 20');
  assert.ok(sr.includes("[redacted]") && !sr.includes("abc"));
  assert.ok(sr.includes("x".repeat(200) + "...") && !sr.includes("x".repeat(201)));
  assert.ok(sr.includes("NULL"));

  await client.callTool({ name: "sample_rows", arguments: { table: 'we"ird' } });
  assert.equal(calls.at(-1)?.sql, 'SELECT * FROM "public"."we""ird" LIMIT 5');
  await client.callTool({ name: "sample_rows", arguments: { table: "customers", limit: 0 } });
  assert.ok(calls.at(-1)?.sql.endsWith("LIMIT 1"));

  await client.close();
  await app.close();
});

test("run_select applies the guard before touching the database and caps rows", async () => {
  const { db, calls } = fakeDb();
  const { client, app } = await connect(db);

  const bad = /** @type {any} */ (await client.callTool({ name: "run_select", arguments: { sql: "SELECT 1; DROP TABLE x" } }));
  assert.equal(bad.isError, true);
  assert.match(text(bad), /Query rejected/);
  assert.equal(calls.length, 0, "guard must reject before any database call");

  const good = text(await client.callTool({ name: "run_select", arguments: { sql: "SELECT 1;" } }));
  assert.ok(good.includes("password_hash"));
  assert.deepEqual(calls[0], { sql: "SELECT 1", opts: { maxRows: 3 } });

  await client.callTool({ name: "run_select", arguments: { sql: "SELECT 1", maxRows: 100000 } });
  assert.equal(calls[1].opts.maxRows, 500);
  await client.callTool({ name: "run_select", arguments: { sql: "SELECT 1", maxRows: 7 } });
  assert.equal(calls[2].opts.maxRows, 7);

  const missing = /** @type {any} */ (await client.callTool({ name: "run_select", arguments: {} }));
  assert.equal(missing.isError, true);
  await client.close();
  await app.close();
});

test("errors are returned as isError results with credentials removed", async () => {
  const { db } = fakeDb({
    async listTables() {
      const e = /** @type {any} */ (new Error(`connect failed for ${URL_WITH_PW} using password ${PW}`));
      e.code = "ECONNREFUSED";
      throw e;
    },
  });
  const { client, app } = await connect(db);
  const res = /** @type {any} */ (await client.callTool({ name: "list_tables", arguments: {} }));
  assert.equal(res.isError, true);
  const t = text(res);
  assert.ok(t.includes("ECONNREFUSED"));
  assert.ok(!t.includes(PW));
  assert.ok(!t.includes("user:"));

  const unknown = /** @type {any} */ (await callTool("nope", {}, { config, getDb: () => db }));
  assert.equal(unknown.isError, true);
  assert.match(text(unknown), /unknown tool/);

  const nonError = /** @type {any} */ (await callTool("list_tables", {}, { config, getDb: () => { throw "plain string"; } }));
  assert.match(text(nonError), /plain string/);
  await client.close();
  await app.close();
});

test("database is created lazily and closed once", async () => {
  let created = 0;
  let closed = 0;
  const { db } = fakeDb({ close: async () => { closed++; } });
  const app = createApp(config, () => {
    created++;
    return db;
  });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([app.server.connect(a), client.connect(b)]);
  await client.listTools();
  assert.equal(created, 0);
  await client.callTool({ name: "list_tables", arguments: {} });
  await client.callTool({ name: "list_tables", arguments: {} });
  assert.equal(created, 1);
  await app.close();
  await app.close();
  assert.equal(closed, 1);
  await client.close();
});

test("createApp without a factory reports a clear error", async () => {
  const app = createApp(config);
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([app.server.connect(a), client.connect(b)]);
  const res = /** @type {any} */ (await client.callTool({ name: "list_tables", arguments: {} }));
  assert.equal(res.isError, true);
  await client.close();
});
