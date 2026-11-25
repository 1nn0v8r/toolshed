// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSql, assertReadOnlySql, GuardError, tokenize } from "../../modules/db-schema/guard.js";

/** @param {string} sql @param {"postgres" | "mysql"} kind */
const ok = (sql, kind) => assert.equal(checkSql(sql, kind).ok, true, `expected accept (${kind}): ${sql}`);
/** @param {string} sql @param {"postgres" | "mysql"} kind @param {RegExp} [re] */
const bad = (sql, kind, re) => {
  const r = checkSql(sql, kind);
  assert.equal(r.ok, false, `expected reject (${kind}): ${sql}`);
  if (re && !r.ok) assert.match(r.reason, re);
};
const both = /** @type {const} */ (["postgres", "mysql"]);

test("accepts plain reads on both dialects", () => {
  for (const k of both) {
    ok("SELECT 1", k);
    ok("select * from customers where id = 1", k);
    ok("  SELECT 1;  ", k);
    ok("SELECT 1;;", k);
    ok("(SELECT 1) UNION (SELECT 2)", k);
    ok("WITH a AS (SELECT 1 AS x) SELECT * FROM a", k);
    ok("SHOW TABLES", k);
    ok("EXPLAIN SELECT * FROM t", k);
    ok("SELECT a.b FROM a JOIN b ON a.id = b.id", k);
    ok("SELECT\r\n1\r\n", k);
    ok("-- leading comment\nSELECT 1", k);
    ok("/* block */ SELECT 1", k);
    ok("SELECT 1 -- trailing", k);
    ok("SELECT 'a;b'", k);
    ok("SELECT 'it''s'", k);
  }
  ok("TABLE customers", "postgres");
  ok("VALUES (1), (2)", "postgres");
  ok("SHOW search_path", "postgres");
  ok("SHOW CREATE TABLE customers", "mysql");
  ok("EXPLAIN (FORMAT JSON) SELECT 1", "postgres");
  ok("EXPLAIN FORMAT=JSON SELECT 1", "mysql");
  ok("SELECT pg_sleep(1)", "postgres");
  ok("SELECT sleep(1)", "mysql");
});

test("keywords inside strings, comments, quoted identifiers are allowed", () => {
  for (const k of both) {
    ok("SELECT 'DROP TABLE x; DELETE FROM y'", k);
    ok("SELECT 1 /* DROP TABLE x */", k);
    ok("SELECT 1 -- DELETE FROM x", k);
    ok("SELECT 'a' /* ; */ , 'b'", k);
  }
  ok('SELECT "delete", "update" FROM "set"', "postgres");
  ok("SELECT `delete`, `update` FROM `set`", "mysql");
  ok("SELECT $$DROP TABLE x; DELETE$$", "postgres");
  ok("SELECT $tag$ ; INSERT INTO x $tag$ AS v", "postgres");
  ok("SELECT $a$ $b$ ; DROP $b$ $a$", "postgres");
  ok("SELECT E'it\\'s; DROP TABLE x'", "postgres");
  ok("SELECT 'back\\' ; still string' ", "mysql");
  ok("SELECT \"DROP;\"", "mysql");
  ok("/* outer /* nested DROP */ still comment DELETE */ SELECT 1", "postgres");
  ok("SELECT $1", "postgres");
  ok("SELECT x.update, y.delete FROM x JOIN y ON true", "postgres");
  ok("SELECT 1 # DELETE FROM x", "mysql");
});

test("rejects multiple statements", () => {
  for (const k of both) {
    bad("SELECT 1; DROP TABLE x", k, /one statement|DROP/);
    bad("SELECT 1; SELECT 2", k, /one statement/);
    bad("SELECT 1;\nSELECT 2;", k, /one statement/);
    bad(";SELECT 1", k, /one statement/);
  }
});

test("rejects non-read statements and data-modifying keywords", () => {
  for (const k of both) {
    for (const s of [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET a = 1",
      "DELETE FROM t",
      "DROP TABLE t",
      "ALTER TABLE t ADD c int",
      "CREATE TABLE t (a int)",
      "TRUNCATE t",
      "GRANT ALL ON t TO x",
      "REVOKE ALL ON t FROM x",
      "CALL p()",
      "DO 1",
      "LOCK TABLE t",
      "SET x = 1",
      "RESET ALL",
      "MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE",
      "REPLACE INTO t VALUES (1)",
      "LOAD DATA INFILE 'x' INTO TABLE t",
      "HANDLER t OPEN",
    ]) {
      bad(s, k);
    }
    bad("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", k, /DELETE/);
    bad("WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x", k, /INSERT/);
    bad("WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x", k, /UPDATE/);
    bad("SELECT * FROM t FOR UPDATE", k, /UPDATE/);
    bad("SELECT * INTO newt FROM t", k, /INTO/);
    bad("SELECT 1 INTO OUTFILE '/tmp/x'", k, /INTO/);
    bad("SELECT 1 INTO DUMPFILE '/tmp/x'", k, /INTO/);
    bad("(INSERT INTO t VALUES (1))", k);
    bad("select 1 union select 2; delete from t", k);
  }
  bad("COPY t TO '/tmp/x'", "postgres", /COPY/);
  bad("VACUUM t", "postgres");
  bad("UPSERT INTO t VALUES (1)", "mysql");
  bad("TABLE customers", "mysql", /must start with/);
  bad("VALUES (1)", "mysql", /must start with/);
});

test("case and whitespace tricks do not bypass keywords", () => {
  for (const k of both) {
    bad("SELECT 1; dRoP TABLE x", k);
    bad("select * from t where a in (select 1) ; \n\t delete\nfrom t", k);
    bad("WITH x AS (\n  DeLeTe FROM t\n) SELECT 1", k);
    bad("SELECT 1 /* c */ ; /* c */ DROP TABLE x", k);
  }
});

test("EXPLAIN ANALYZE is rejected in every form", () => {
  bad("EXPLAIN ANALYZE SELECT 1", "postgres", /ANALYZE/);
  bad("EXPLAIN ANALYZE SELECT 1", "mysql", /ANALYZE/);
  bad("EXPLAIN (ANALYZE) SELECT 1", "postgres", /ANALYZE/);
  bad("EXPLAIN (ANALYZE true, BUFFERS) SELECT 1", "postgres", /ANALYZE/);
  bad("explain analyse select 1", "postgres", /ANALYZE/);
  bad("EXPLAIN /* x */ ANALYZE DELETE FROM t", "postgres");
  bad("EXPLAIN DELETE FROM t", "postgres", /DELETE/);
});

test("dangerous functions are rejected", () => {
  for (const f of [
    "pg_terminate_backend(1)",
    "pg_cancel_backend(1)",
    "lo_import('/etc/passwd')",
    "lo_export(1, '/tmp/x')",
    "dblink('host=x', 'select 1')",
    "dblink_exec('x', 'drop table t')",
    "set_config('role', 'x', false)",
    "pg_read_file('/etc/passwd')",
    "pg_advisory_lock(1)",
    "pg_catalog.pg_terminate_backend(1)",
    "nextval('s')",
    "setval('s', 1)",
  ]) {
    bad(`SELECT ${f}`, "postgres", /not allowed/);
  }
  bad('SELECT "pg_terminate_backend"(1)', "postgres", /not allowed/);
  bad("SELECT * FROM dblink('x', 'y') AS t(a int)", "postgres", /not allowed/);
  bad("SELECT LOAD_FILE('/etc/passwd')", "mysql", /not allowed/);
  bad("SELECT GET_LOCK('a', 1)", "mysql", /not allowed/);
  bad("SELECT `load_file`('/x')", "mysql", /not allowed/);
});

test("tokenizer edge cases: lexical differences between dialects", () => {
  // MySQL: "--" without trailing whitespace is NOT a comment, so the semicolon is real.
  bad("SELECT 1 --1; DROP TABLE x", "mysql");
  bad("SELECT 1--1; SELECT 2", "mysql", /one statement/);
  // PostgreSQL: "--" is always a comment.
  ok("SELECT 1--1; DROP TABLE x", "postgres");
  // "#" is a comment in MySQL only.
  ok("SELECT 1 # ; DROP TABLE x", "mysql");
  bad("SELECT 1 # x\n; DROP TABLE x", "mysql");
  bad("SELECT 1 #\n; DROP TABLE x", "mysql");
  // Backslash escapes: MySQL always, PostgreSQL only for E'..'.
  bad("SELECT 'a\\'; DROP TABLE x; --'", "postgres", /DROP|one statement/);
  ok("SELECT E'a\\'; DROP TABLE x; --'", "postgres");
  ok("SELECT 'a\\'; DROP TABLE x; --'", "mysql");
  // MySQL executable comments run their content.
  bad("SELECT 1 /*! ; DROP TABLE x */", "mysql", /executable/);
  bad("SELECT 1 /*M! DROP TABLE x */", "mysql", /executable/);
  ok("SELECT 1 /*+ MAX_EXECUTION_TIME(10) */", "mysql");
  ok("SELECT /*+ SET_VAR(x=1) */ 1", "mysql");
  // Quoting differences.
  ok("SELECT 'DROP' FROM `a``b`", "mysql");
  ok('SELECT "a""b; DROP" FROM t', "postgres");
});

test("unterminated constructs are rejected", () => {
  for (const k of both) {
    bad("SELECT 'abc", k, /unterminated/);
    bad("SELECT 1 /* x", k, /unterminated/);
  }
  bad('SELECT "abc', "postgres", /unterminated/);
  bad("SELECT `abc", "mysql", /unterminated/);
  bad("SELECT $$abc", "postgres", /unterminated/);
  bad("SELECT $t$abc$x$", "postgres", /unterminated/);
});

test("empty and invalid input", () => {
  for (const k of both) {
    bad("", k, /empty/);
    bad("   \n ", k, /empty/);
    bad(";", k, /no statement/);
    bad("-- only a comment", k, /no statement/);
    bad("/* c */", k, /no statement/);
    bad("SELECT 1\0", k, /NUL/);
    bad("SELECT " + "1,".repeat(60000) + "1", k, /longer than/);
    bad("1 + 1", k, /must start/);
    bad("'SELECT'", k, /must start/);
    bad("EXEC x", k, /must start/);
  }
  assert.equal(checkSql(undefined, "postgres").ok, false);
  assert.equal(checkSql(42, "mysql").ok, false);
});

test("assertReadOnlySql returns the statement without trailing semicolons and comments", () => {
  assert.equal(assertReadOnlySql("SELECT 1;;  ", "postgres"), "SELECT 1");
  assert.equal(assertReadOnlySql("SELECT 1 -- hi\n;", "mysql"), "SELECT 1");
  assert.throws(() => assertReadOnlySql("DROP TABLE x", "postgres"), GuardError);
  assert.throws(() => assertReadOnlySql("DROP TABLE x", "postgres"), /Query rejected/);
});

test("tokenize reports token types", () => {
  const r = tokenize("SELECT a, 'x', \"q\", 12 FROM t", "postgres");
  assert.ok("tokens" in r);
  if ("tokens" in r) {
    assert.deepEqual(
      r.tokens.map((t) => t.type),
      ["word", "word", "punct", "string", "punct", "ident", "punct", "other", "word", "word"]
    );
  }
  const m = tokenize("SELECT \"x\"", "mysql");
  assert.ok("tokens" in m && m.tokens[1].type === "string");
});
