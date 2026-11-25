// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatValue,
  formatTable,
  formatResult,
  formatForeignKey,
  formatRelationships,
  formatTableDescription,
} from "../../modules/db-schema/format.js";
import { isSecretColumn, redactUrl, redactSecrets, REDACTED } from "../../modules/db-schema/redact.js";
import { parseConfig, ConfigError } from "../../modules/db-schema/config.js";

test("formatValue handles every value type", () => {
  assert.equal(formatValue(null), "NULL");
  assert.equal(formatValue(undefined), "NULL");
  assert.equal(formatValue("a\nb\r\nc"), "a\\nb\\nc");
  assert.equal(formatValue(12n), "12");
  assert.equal(formatValue(3.5), "3.5");
  assert.equal(formatValue(true), "true");
  assert.equal(formatValue(new Date("2020-01-02T03:04:05Z")), "2020-01-02T03:04:05.000Z");
  assert.equal(formatValue(new Date("nope")), "Invalid Date");
  assert.equal(formatValue(Buffer.from("abc")), "<3 bytes>");
  assert.equal(formatValue({ a: 1 }), '{"a":1}');
  assert.equal(formatValue([1, 2]), "[1,2]");
  const cyc = /** @type {any} */ ({});
  cyc.self = cyc;
  assert.equal(formatValue(cyc), "[object Object]");
  assert.equal(formatValue("h\u00e9llo \u{1F600}"), "h\u00e9llo \u{1F600}");
});

test("formatValue truncates long values to 200 characters", () => {
  const s = formatValue("x".repeat(500));
  assert.equal(s, "x".repeat(200) + "...");
  assert.equal(formatValue("y".repeat(200)), "y".repeat(200));
  assert.equal(formatValue("abcdef", 3), "abc...");
});

test("formatTable aligns columns", () => {
  const out = formatTable(["id", "name"], [[1, "alice"], [22, "bob"]]);
  assert.equal(out, ["id  name", "--  -----", "1   alice", "22  bob"].join("\n"));
});

test("formatTable switches to TSV when wide", () => {
  const out = formatTable(["a", "b"], [["x".repeat(100), "y\tz".padEnd(100, "q")]]);
  const lines = out.split("\n");
  assert.equal(lines[0], "a\tb");
  assert.ok(lines[1].includes("\t"));
  assert.equal(lines[1].split("\t").length, 2);
  assert.ok(!lines[1].includes("y\tz"));
  assert.equal(formatTable(["a", "b"], [["x".repeat(100), "y"]], { maxWidth: 1000 }).split("\n").length, 3);
});

test("formatTable applies mask and cell limit", () => {
  const out = formatTable(["pw", "n"], [["secret", "v".repeat(300)]], {
    maxWidth: 1000,
    mask: (i, v) => (i === 0 ? REDACTED : v),
  });
  assert.ok(out.includes(REDACTED));
  assert.ok(!out.includes("secret"));
  assert.ok(out.includes("v".repeat(200) + "..."));
  assert.ok(!out.includes("v".repeat(201)));
});

test("formatResult reports row counts and truncation", () => {
  const one = formatResult({ columns: ["a"], rows: [[1]], truncated: false }, { maxRows: 5 });
  assert.ok(one.endsWith("(1 row)"));
  const many = formatResult({ columns: ["a"], rows: [[1], [2]], truncated: false }, { maxRows: 5 });
  assert.ok(many.endsWith("(2 rows)"));
  const zero = formatResult({ columns: ["a"], rows: [], truncated: false }, { maxRows: 5 });
  assert.ok(zero.endsWith("(0 rows)"));
  const cut = formatResult({ columns: ["a"], rows: [[1], [2], [3]], truncated: true }, { maxRows: 2 });
  assert.ok(cut.includes("(2 rows, truncated at maxRows=2; more rows exist)"));
  assert.ok(!cut.includes("\n3\n"));
  assert.equal(formatResult({ columns: [], rows: [], truncated: false }, { maxRows: 2 }), "(no result columns)");
});

test("foreign key and relationship formatting", () => {
  const fk = { name: "f", table: "orders", columns: ["customer_id"], refTable: "customers", refColumns: ["id"] };
  assert.equal(formatForeignKey(fk, "public"), "orders.customer_id -> customers.id");
  assert.equal(
    formatForeignKey({ ...fk, onDelete: "CASCADE", onUpdate: "NO ACTION" }, "public"),
    "orders.customer_id -> customers.id (on delete cascade)"
  );
  assert.equal(
    formatForeignKey({ ...fk, columns: ["a", "b"], refColumns: ["x", "y"], schema: "s1", refSchema: "s2", onUpdate: "SET NULL" }, "public"),
    "s1.orders.(a, b) -> s2.customers.(x, y) (on update set null)"
  );
  assert.equal(formatRelationships([], "public"), "No foreign keys found.");
  assert.equal(formatRelationships([fk], "public"), "orders.customer_id -> customers.id\n(1 foreign key)");
  assert.ok(formatRelationships([fk, fk], "public").endsWith("(2 foreign keys)"));
});

test("formatTableDescription renders every section", () => {
  const fk = { name: "orders_fk", table: "orders", columns: ["customer_id"], refTable: "customers", refColumns: ["id"] };
  const out = formatTableDescription(
    {
      name: "orders",
      kind: "table",
      comment: "all orders",
      estRows: 10,
      columns: [
        { name: "id", type: "bigint", nullable: false, default: null, comment: null, extra: "auto_increment" },
        { name: "customer_id", type: "bigint", nullable: true, default: "0", comment: "owner" },
      ],
      primaryKey: ["id"],
      foreignKeys: [fk],
      incoming: [{ ...fk, name: "items_fk", table: "items", refTable: "orders", columns: ["order_id"], refColumns: ["id"] }],
      unique: [{ name: "u1", columns: ["a", "b"] }],
      indexes: [
        { name: "pk", unique: true, primary: true, definition: "btree (id)" },
        { name: "u1", unique: true, primary: false, definition: "btree (a, b)" },
        { name: "i1", unique: false, primary: false, definition: "btree (c)" },
      ],
    },
    "public"
  );
  for (const frag of [
    "orders (table, ~10 rows)",
    "comment: all orders",
    "NOT NULL",
    "auto_increment",
    "default 0",
    "-- owner",
    "primary key: (id)",
    "orders_fk: orders.customer_id -> customers.id",
    "items_fk: items.order_id -> orders.id",
    "u1: (a, b)",
    "pk: PRIMARY btree (id)",
    "u1: UNIQUE btree (a, b)",
    "i1: btree (c)",
  ]) {
    assert.ok(out.includes(frag), `missing: ${frag}\n${out}`);
  }
  const empty = formatTableDescription(
    { name: "v", kind: "view", comment: null, estRows: null, columns: [], primaryKey: [], foreignKeys: [], incoming: [], unique: [], indexes: [] },
    "public"
  );
  assert.ok(empty.startsWith("v (view)"));
  assert.ok(empty.includes("primary key: none"));
  assert.equal((empty.match(/ {2}none/g) ?? []).length, 4);
});

test("isSecretColumn matches secret-like names", () => {
  for (const n of [
    "password", "password_hash", "PASSWD", "client_secret", "access_token", "api_key", "apiKey", "API-KEY",
    "apikey", "hash", "salt", "ssn", "card_number", "cvv", "iban", "otp_code", "private_key",
  ]) {
    assert.equal(isSecretColumn(n), true, n);
  }
  for (const n of ["id", "email", "name", "created_at", "total"]) assert.equal(isSecretColumn(n), false, n);
});

test("redactUrl removes credentials", () => {
  const pw = "p" + "w".repeat(5);
  assert.equal(redactUrl(`connect to postgres://user:${pw}@db.example.com:5432/app failed`), "connect to postgres://***@db.example.com:5432/app failed");
  assert.equal(redactUrl("mysql://root@localhost/x"), "mysql://***@localhost/x");
  assert.equal(redactUrl("postgres://localhost/x"), "postgres://localhost/x");
  assert.equal(redactUrl("no url here"), "no url here");
});

test("redactSecrets removes the url, the password and its decoded form", () => {
  const url = "postgres://user:p%40ss%2Fw0rd@host:5432/db";
  const out = redactSecrets(`failed ${url} and password p@ss/w0rd and p%40ss%2Fw0rd`, { url });
  assert.ok(!out.includes("p@ss"));
  assert.ok(!out.includes("p%40ss"));
  assert.ok(!out.includes("user:"));
  assert.equal(redactSecrets("plain", {}), "plain");
  assert.equal(redactSecrets("plain", undefined), "plain");
  assert.equal(redactSecrets("x://u:pw@h", { url: "not a url" }), "x://***@h");
  const bad = "postgres://u:%zz@host/db";
  assert.ok(!redactSecrets("see %zz here", { url: bad }).includes("%zz"));
});

test("parseConfig reads and validates the environment", () => {
  const c = parseConfig({ DATABASE_URL: "postgresql://u:p@h/db" });
  assert.deepEqual({ ...c, url: "" }, { kind: "postgres", url: "", schema: "public", maxRows: 50, timeoutMs: 10000 });
  assert.equal(parseConfig({ DATABASE_URL: "postgres://h/db" }).kind, "postgres");
  assert.equal(parseConfig({ DATABASE_URL: "MySQL://h/db" }).kind, "mysql");
  const full = parseConfig({ DATABASE_URL: "mysql://h/db", DB_SCHEMA: " app ", DB_MAX_ROWS: "100", DB_STATEMENT_TIMEOUT_MS: "250" });
  assert.equal(full.schema, "app");
  assert.equal(full.maxRows, 100);
  assert.equal(full.timeoutMs, 250);
  assert.equal(parseConfig({ DATABASE_URL: "mysql://h/db", DB_MAX_ROWS: "99999" }).maxRows, 500);
  assert.equal(parseConfig({ DATABASE_URL: "mysql://h/db", DB_MAX_ROWS: "" }).maxRows, 50);
});

test("parseConfig errors never contain the connection url", () => {
  const secretUrl = "oracle://user:" + "s3cr3t" + "@host/db";
  for (const env of [
    {},
    { DATABASE_URL: "   " },
    { DATABASE_URL: "not-a-url" },
    { DATABASE_URL: secretUrl },
    { DATABASE_URL: "mysql://u:" + "s3cr3t" + "@h/db", DB_MAX_ROWS: "abc" },
    { DATABASE_URL: "mysql://u:" + "s3cr3t" + "@h/db", DB_MAX_ROWS: "0" },
    { DATABASE_URL: "mysql://u:" + "s3cr3t" + "@h/db", DB_STATEMENT_TIMEOUT_MS: "-5" },
  ]) {
    assert.throws(
      () => parseConfig(env),
      (e) => e instanceof ConfigError && !String(e.message).includes("s3cr3t") && !String(e.message).includes("user:")
    );
  }
});
