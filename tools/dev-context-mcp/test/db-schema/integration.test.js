// @ts-check
// Integration tests against real databases. They run only when TEST_PG_URL and/or
// TEST_MYSQL_URL are set (see the README for the Docker commands); otherwise each
// suite is skipped with a message saying which variable to set.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import mysql from "mysql2/promise";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseConfig } from "../../modules/db-schema/config.js";
import { createDatabase } from "../../modules/db-schema/db.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "modules", "db-schema", "server.js");
const PG_SCHEMA = "dbschema_it";

// Secret-looking fixture values are assembled at runtime so no literal secret is in this file.
const HASH_VALUE = "$2b$" + "10$" + "abc".repeat(12);
const API_KEY_VALUE = "AKIA" + "X".repeat(16);
const LONG_BIO = "b".repeat(500);

/** @returns {Record<string, string>} */
function baseEnv() {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(DATABASE_URL|DB_)/.test(k)) out[k] = v;
  }
  return out;
}

/**
 * @param {Record<string, string>} env
 * @returns {Promise<Client>}
 */
async function connectClient(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...baseEnv(), ...env }, stderr: "pipe" });
  const client = new Client({ name: "integration", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

/**
 * @param {Client} client
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {Promise<{ text: string, isError: boolean }>}
 */
async function call(client, name, args = {}) {
  const res = /** @type {any} */ (await client.callTool({ name, arguments: args }));
  return { text: res.content[0].text, isError: Boolean(res.isError) };
}

/**
 * @param {{ label: string, kind: "postgres" | "mysql", urlVar: string, setup: (url: string) => Promise<() => Promise<void>>, schema?: string, countRows: (url: string) => Promise<number>, versionRe: RegExp }} d
 */
function suite(d) {
  const url = process.env[d.urlVar];
  describe(`integration: ${d.label}`, { skip: url ? false : `set ${d.urlVar} to run the ${d.label} integration tests (see README)` }, () => {
    /** @type {() => Promise<void>} */
    let teardown = async () => {};
    /** @type {Client} */
    let client;
    const dbUrl = /** @type {string} */ (url);
    const env = { DATABASE_URL: dbUrl, ...(d.schema ? { DB_SCHEMA: d.schema } : {}) };

    before(async () => {
      teardown = await d.setup(dbUrl);
      client = await connectClient(env);
    });
    after(async () => {
      if (client) await client.close();
      await teardown();
    });

    test("connection_info reports version, database and read-only without credentials", async () => {
      const r = await call(client, "connection_info");
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, new RegExp(`kind: ${d.kind}`));
      assert.match(r.text, d.versionRe);
      assert.match(r.text, /database: \S+/);
      assert.match(r.text, /read-only: yes/);
      const u = new URL(dbUrl);
      assert.ok(!r.text.includes(`${u.username}:${u.password}`));
      assert.ok(!r.text.includes("@"));
    });

    test("list_tables shows tables, views, comments and estimates", async () => {
      const r = await call(client, "list_tables");
      assert.equal(r.isError, false, r.text);
      for (const n of ["customers", "orders", "users", "customer_orders"]) assert.ok(r.text.includes(n), `${n} missing:\n${r.text}`);
      assert.ok(r.text.includes("Customer accounts"));
      assert.match(r.text, /customer_orders\s+view/);
      assert.match(r.text, /\(4 tables\)/);
    });

    test("describe_table shows columns, keys, incoming and outgoing foreign keys, indexes", async () => {
      const o = await call(client, "describe_table", { table: "orders" });
      assert.equal(o.isError, false, o.text);
      assert.match(o.text, /customer_id/);
      assert.ok(o.text.includes("Order total"));
      assert.match(o.text, /primary key: \(id\)/);
      assert.match(o.text, /orders\.customer_id -> customers\.id \(on delete cascade\)/);
      assert.match(o.text, /orders_customer_idx/);
      assert.match(o.text, /NOT NULL/);

      const c = await call(client, "describe_table", { table: "customers" });
      assert.equal(c.isError, false, c.text);
      assert.match(c.text, /foreign keys \(incoming\):\n\s+\S+: orders\.customer_id -> customers\.id/);
      assert.match(c.text, /unique constraints:\n\s+\S+: \(email\)/);
      assert.ok(c.text.includes("Customer accounts"));

      const ci = await call(client, "describe_table", { table: "CUSTOMERS" });
      assert.equal(ci.isError, false, "case-insensitive lookup");

      const v = await call(client, "describe_table", { table: "customer_orders" });
      assert.equal(v.isError, false, v.text);
      assert.match(v.text, /\(view/);

      const missing = await call(client, "describe_table", { table: "nope" });
      assert.equal(missing.isError, true);
      assert.match(missing.text, /table not found: nope\. Available: .*customers/);
    });

    test("list_relationships lists foreign keys", async () => {
      const r = await call(client, "list_relationships");
      assert.equal(r.isError, false, r.text);
      assert.ok(r.text.includes("orders.customer_id -> customers.id"));
      assert.ok(r.text.includes("(1 foreign key)"));
    });

    test("sample_rows masks secret columns, truncates long values and clamps the limit", async () => {
      const r = await call(client, "sample_rows", { table: "users" });
      assert.equal(r.isError, false, r.text);
      assert.ok(r.text.includes("alice"));
      assert.ok(r.text.includes("[redacted]"));
      assert.ok(!r.text.includes(HASH_VALUE));
      assert.ok(!r.text.includes(API_KEY_VALUE));
      assert.ok(r.text.includes("b".repeat(200) + "..."));
      assert.ok(!r.text.includes("b".repeat(201)));
      assert.ok(r.text.endsWith("(3 rows)"));

      const one = await call(client, "sample_rows", { table: "orders", limit: 1 });
      assert.ok(one.text.endsWith("(1 row)"), one.text);
      const big = await call(client, "sample_rows", { table: "orders", limit: 1000 });
      assert.ok(big.text.endsWith("(20 rows)"), big.text);
      const def = await call(client, "sample_rows", { table: "orders" });
      assert.ok(def.text.endsWith("(5 rows)"), def.text);
    });

    test("run_select returns rows, caps results and reports truncation", async () => {
      const r = await call(client, "run_select", { sql: "SELECT id, email FROM customers ORDER BY id" });
      assert.equal(r.isError, false, r.text);
      assert.ok(r.text.includes("a@example.test"));
      assert.ok(r.text.endsWith("(2 rows)"));

      const cut = await call(client, "run_select", { sql: "SELECT id FROM orders ORDER BY id", maxRows: 10 });
      assert.ok(cut.text.endsWith("(10 rows, truncated at maxRows=10; more rows exist)"), cut.text);

      const dflt = await call(client, "run_select", { sql: "SELECT id FROM orders" });
      assert.ok(dflt.text.includes("(50 rows, truncated at maxRows=50"), dflt.text);

      const all = await call(client, "run_select", { sql: "SELECT id FROM orders", maxRows: 500 });
      assert.ok(all.text.endsWith("(120 rows)"), all.text.slice(-80));

      const join = await call(client, "run_select", {
        sql: "SELECT c.name, COUNT(*) AS n FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.name ORDER BY c.name",
      });
      assert.ok(join.text.includes("alice") && join.text.includes("n"));

      const cte = await call(client, "run_select", { sql: "WITH t AS (SELECT 1 AS x) SELECT x FROM t;" });
      assert.equal(cte.isError, false, cte.text);

      const explain = await call(client, "run_select", { sql: "EXPLAIN SELECT * FROM orders" });
      assert.equal(explain.isError, false, explain.text);

      const wide = await call(client, "run_select", { sql: "SELECT bio FROM users WHERE username = 'carol'" });
      assert.ok(wide.text.includes("b".repeat(200) + "..."));

      const strLit = await call(client, "run_select", { sql: "SELECT 'DROP TABLE x; -- DELETE' AS s" });
      assert.equal(strLit.isError, false, strLit.text);
      assert.ok(strLit.text.includes("DROP TABLE x"));
    });

    test("run_select rejects writes and multi-statements and leaves data untouched", async () => {
      const before = await d.countRows(dbUrl);
      for (const sql of [
        "SELECT 1; DROP TABLE customers",
        "DELETE FROM orders",
        "INSERT INTO customers (email) VALUES ('z@example.test')",
        "UPDATE orders SET total = 0",
        "EXPLAIN ANALYZE SELECT 1",
        "WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x",
      ]) {
        const r = await call(client, "run_select", { sql });
        assert.equal(r.isError, true, sql);
        assert.match(r.text, /Query rejected/, sql);
      }
      assert.equal(await d.countRows(dbUrl), before);
    });

    test("statement timeout cancels long-running queries", async () => {
      const slow = await connectClient({ ...env, DB_STATEMENT_TIMEOUT_MS: "500" });
      try {
        const started = Date.now();
        const r = await call(slow, "run_select", { sql: d.kind === "postgres" ? "SELECT pg_sleep(8)" : "SELECT SLEEP(8)" });
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 6000, `query ran ${elapsed} ms`);
        if (d.kind === "postgres") {
          assert.equal(r.isError, true);
          assert.match(r.text, /statement timeout/);
        }
      } finally {
        await slow.close();
      }
    });

    test("layer b: a write that bypasses the guard fails inside the read-only transaction", async () => {
      const config = parseConfig(env);
      const db = createDatabase(config);
      try {
        const before = await d.countRows(dbUrl);
        await assert.rejects(
          () => db.runReadOnly("INSERT INTO customers (email, name) VALUES ('hack@example.test', 'x')"),
          /read[- ]only/i
        );
        await assert.rejects(() => db.runReadOnly("DELETE FROM orders"), /read[- ]only/i);
        await assert.rejects(() => db.runReadOnly("UPDATE users SET username = 'x'"), /read[- ]only/i);
        await assert.rejects(() => db.runReadOnly("CREATE TABLE sneaky (id int)"), /read[- ]only/i);
        await assert.rejects(() => db.runReadOnly("DROP TABLE users"), /read[- ]only/i);
        assert.equal(await d.countRows(dbUrl), before, "no row may have been written");

        // The connection is still usable afterwards and sees no leftover transaction state.
        const ok = await db.runReadOnly("SELECT COUNT(*) FROM customers");
        assert.equal(Number(ok.rows[0][0]), 2);
        const tables = await db.listTables();
        assert.ok(!tables.some((t) => t.name === "sneaky"));
      } finally {
        await db.close();
      }
    });

    test("layer b: a successful query is rolled back too (no state leaks between calls)", async () => {
      const db = createDatabase(parseConfig(env));
      try {
        for (let i = 0; i < 5; i++) {
          const r = await db.runReadOnly("SELECT COUNT(*) FROM orders", { maxRows: 5 });
          assert.equal(Number(r.rows[0][0]), 120);
        }
        const capped = await db.runReadOnly("SELECT id FROM orders", { maxRows: 3 });
        assert.equal(capped.rows.length, 3);
        assert.equal(capped.truncated, true);
        const after = await db.runReadOnly("SELECT COUNT(*) FROM orders");
        assert.equal(Number(after.rows[0][0]), 120);
      } finally {
        await db.close();
      }
    });

    test("connection failures never leak the password", async () => {
      const u = new URL(dbUrl);
      const bad = "wrong" + "pw" + "9".repeat(5);
      u.password = bad;
      const c = await connectClient({ ...env, DATABASE_URL: u.toString() });
      try {
        const r = await call(c, "list_tables");
        assert.equal(r.isError, true);
        assert.ok(!r.text.includes(bad), r.text);
        assert.ok(!r.text.includes(u.toString()));
      } finally {
        await c.close();
      }
    });
  });
}

/** @param {string} url */
async function pgSetup(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const S = PG_SCHEMA;
  const orders = Array.from({ length: 120 }, (_, i) => `(${(i % 2) + 1}, ${i + 1}.50)`).join(",");
  await c.query(`
    DROP SCHEMA IF EXISTS ${S} CASCADE;
    CREATE SCHEMA ${S};
    CREATE TABLE ${S}.customers (id bigserial PRIMARY KEY, email text NOT NULL UNIQUE, name text);
    COMMENT ON TABLE ${S}.customers IS 'Customer accounts';
    CREATE TABLE ${S}.orders (
      id bigserial PRIMARY KEY,
      customer_id bigint NOT NULL REFERENCES ${S}.customers(id) ON DELETE CASCADE,
      total numeric(10,2) DEFAULT 0,
      placed_at timestamptz DEFAULT now());
    COMMENT ON COLUMN ${S}.orders.total IS 'Order total';
    CREATE INDEX orders_customer_idx ON ${S}.orders (customer_id);
    CREATE TABLE ${S}.users (id serial PRIMARY KEY, username text, password_hash text, api_key text, bio text);
    CREATE VIEW ${S}.customer_orders AS SELECT c.name, o.total FROM ${S}.orders o JOIN ${S}.customers c ON c.id = o.customer_id;
    INSERT INTO ${S}.customers (email, name) VALUES ('a@example.test', 'alice'), ('b@example.test', 'bob');
    INSERT INTO ${S}.orders (customer_id, total) VALUES ${orders};
    ANALYZE ${S}.customers; ANALYZE ${S}.orders;
  `);
  await c.query(
    `INSERT INTO ${S}.users (username, password_hash, api_key, bio) VALUES ('alice', $1, $2, 'hi'), ('bob', $1, $2, 'yo'), ('carol', $1, $2, $3)`,
    [HASH_VALUE, API_KEY_VALUE, LONG_BIO]
  );
  return async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await c.end();
  };
}

/** @param {string} url */
async function pgCount(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query(
      `SELECT (SELECT count(*) FROM ${PG_SCHEMA}.customers) + (SELECT count(*) FROM ${PG_SCHEMA}.orders) + (SELECT count(*) FROM ${PG_SCHEMA}.users) AS n,
              (SELECT count(*) FROM pg_tables WHERE schemaname = '${PG_SCHEMA}') AS t`
    );
    assert.equal(Number(r.rows[0].t), 3, "no tables may be created or dropped");
    return Number(r.rows[0].n);
  } finally {
    await c.end();
  }
}

/** @param {string} url */
async function mysqlSetup(url) {
  const c = await mysql.createConnection({ uri: url, multipleStatements: true });
  const orders = Array.from({ length: 120 }, (_, i) => `(${(i % 2) + 1}, ${i + 1}.50)`).join(",");
  await c.query(`
    DROP VIEW IF EXISTS customer_orders;
    DROP TABLE IF EXISTS orders, users, customers, sneaky;
    CREATE TABLE customers (id BIGINT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(255) NOT NULL, name VARCHAR(100),
      UNIQUE KEY customers_email_uq (email)) ENGINE=InnoDB COMMENT='Customer accounts';
    CREATE TABLE orders (id BIGINT AUTO_INCREMENT PRIMARY KEY, customer_id BIGINT NOT NULL,
      total DECIMAL(10,2) DEFAULT 0 COMMENT 'Order total', placed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      KEY orders_customer_idx (customer_id),
      CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE) ENGINE=InnoDB;
    CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(50), password_hash VARCHAR(255), api_key VARCHAR(255), bio TEXT) ENGINE=InnoDB;
    CREATE VIEW customer_orders AS SELECT c.name, o.total FROM orders o JOIN customers c ON c.id = o.customer_id;
    INSERT INTO customers (email, name) VALUES ('a@example.test', 'alice'), ('b@example.test', 'bob');
    INSERT INTO orders (customer_id, total) VALUES ${orders};
    ANALYZE TABLE customers, orders, users;
  `);
  await c.query("INSERT INTO users (username, password_hash, api_key, bio) VALUES ('alice', ?, ?, 'hi'), ('bob', ?, ?, 'yo'), ('carol', ?, ?, ?)", [
    HASH_VALUE, API_KEY_VALUE, HASH_VALUE, API_KEY_VALUE, HASH_VALUE, API_KEY_VALUE, LONG_BIO,
  ]);
  return async () => {
    await c.query("DROP VIEW IF EXISTS customer_orders; DROP TABLE IF EXISTS orders, users, customers, sneaky;");
    await c.end();
  };
}

/** @param {string} url */
async function mysqlCount(url) {
  const c = await mysql.createConnection({ uri: url });
  try {
    const [rows] = /** @type {any[]} */ (
      await c.query(
        "SELECT (SELECT COUNT(*) FROM customers) + (SELECT COUNT(*) FROM orders) + (SELECT COUNT(*) FROM users) AS n, (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE') AS t"
      )
    );
    assert.equal(Number(rows[0].t), 3, "no tables may be created or dropped");
    return Number(rows[0].n);
  } finally {
    await c.end();
  }
}

suite({ label: "PostgreSQL", kind: "postgres", urlVar: "TEST_PG_URL", setup: pgSetup, schema: PG_SCHEMA, countRows: pgCount, versionRe: /version: PostgreSQL \d+/ });
suite({ label: "MySQL", kind: "mysql", urlVar: "TEST_MYSQL_URL", setup: mysqlSetup, countRows: mysqlCount, versionRe: /version: \d+\.\d+/ });
