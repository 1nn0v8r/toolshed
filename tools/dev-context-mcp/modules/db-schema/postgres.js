// @ts-check
import pg from "pg";
import Cursor from "pg-cursor";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("./db.js").Database} Database */

const ACTIONS = /** @type {Record<string, string>} */ ({
  a: "NO ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
});

const KIND = /** @type {Record<string, string>} */ ({ r: "table", p: "table", v: "view", m: "matview", f: "foreign table" });

/** @param {string} conkey @param {string} rel */
function colsOf(conkey, rel) {
  return `ARRAY(SELECT a.attname::text FROM unnest(${conkey}) WITH ORDINALITY k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = ${rel} AND a.attnum = k.attnum ORDER BY k.ord)`;
}

const FK_SQL = `
SELECT con.conname AS name, sn.nspname AS schema, sc.relname AS tbl,
  ${colsOf("con.conkey", "con.conrelid")} AS cols,
  fn.nspname AS ref_schema, fc.relname AS ref_table,
  ${colsOf("con.confkey", "con.confrelid")} AS ref_cols,
  con.confupdtype::text AS on_update, con.confdeltype::text AS on_delete
FROM pg_constraint con
JOIN pg_class sc ON sc.oid = con.conrelid JOIN pg_namespace sn ON sn.oid = sc.relnamespace
JOIN pg_class fc ON fc.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace
WHERE con.contype = 'f' AND (sn.nspname = $1 OR fn.nspname = $1)
ORDER BY sc.relname, con.conname`;

/**
 * @param {unknown[]} row
 * @returns {import("./format.js").ForeignKey}
 */
function fkFromRow(row) {
  return {
    name: String(row[0]),
    schema: String(row[1]),
    table: String(row[2]),
    columns: /** @type {string[]} */ (row[3]),
    refSchema: String(row[4]),
    refTable: String(row[5]),
    refColumns: /** @type {string[]} */ (row[6]),
    onUpdate: ACTIONS[String(row[7])] ?? String(row[7]),
    onDelete: ACTIONS[String(row[8])] ?? String(row[8]),
  };
}

/**
 * @param {Config} config
 * @returns {Database}
 */
export function connectPostgres(config) {
  const pool = new pg.Pool({
    connectionString: config.url,
    max: 2,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    application_name: "db-schema-mcp",
  });
  pool.on("error", () => {
    // Idle client errors (for example a server restart) must not crash the process.
  });

  /**
   * @param {string} sql
   * @param {{ params?: unknown[], maxRows?: number, timeoutMs?: number }} [opts]
   */
  async function runReadOnly(sql, opts = {}) {
    const maxRows = opts.maxRows ?? config.maxRows;
    const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? config.timeoutMs));
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      await client.query("SET LOCAL standard_conforming_strings = on");
      // Unqualified table names resolve in the configured schema.
      await client.query(`SET LOCAL search_path TO "${config.schema.replace(/"/g, '""')}", pg_catalog`);
      const cursor = client.query(new Cursor(sql, opts.params ?? [], { rowMode: "array" }));
      /** @type {{ rows: unknown[][], result: any }} */
      const got = await new Promise((resolve, reject) => {
        cursor.read(maxRows + 1, (err, rows, result) => (err ? reject(err) : resolve({ rows, result })));
      });
      await new Promise((resolve) => cursor.close(() => resolve(undefined)));
      const columns = (got.result && got.result.fields ? got.result.fields : []).map((/** @type {{ name: string }} */ f) => f.name);
      const truncated = got.rows.length > maxRows;
      return { columns, rows: truncated ? got.rows.slice(0, maxRows) : got.rows, truncated };
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      client.release(broken);
    }
  }

  /** @param {string} sql @param {unknown[]} params */
  const meta = (sql, params) => runReadOnly(sql, { params, maxRows: 5000 }).then((r) => r.rows);

  return {
    kind: "postgres",
    schema: config.schema,
    runReadOnly,
    quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,

    async listTables() {
      const rows = await meta(
        `SELECT c.relname, c.relkind::text, c.reltuples::float8, obj_description(c.oid, 'pg_class')
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`,
        [config.schema]
      );
      return rows.map((r) => ({
        name: String(r[0]),
        kind: KIND[String(r[1])] ?? String(r[1]),
        estRows: r[2] === null || Number(r[2]) < 0 ? null : Math.round(Number(r[2])),
        comment: r[3] === null ? null : String(r[3]),
      }));
    },

    async foreignKeys() {
      const rows = await meta(FK_SQL, [config.schema]);
      return rows.map(fkFromRow).filter((f) => f.schema === config.schema);
    },

    async describeTable(name) {
      const head = await meta(
        `SELECT c.oid::int, c.relkind::text, c.reltuples::float8, obj_description(c.oid, 'pg_class')
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p','v','m','f')`,
        [config.schema, name]
      );
      if (head.length === 0) throw new Error(`table not found: ${name}`);
      const oid = Number(head[0][0]);
      const cols = await meta(
        `SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
                pg_get_expr(d.adbin, d.adrelid), col_description(a.attrelid, a.attnum),
                a.attidentity::text, a.attgenerated::text
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [oid]
      );
      const cons = await meta(
        `SELECT con.conname, con.contype::text, ${colsOf("con.conkey", "con.conrelid")}
         FROM pg_constraint con WHERE con.conrelid = $1 AND con.contype IN ('p','u') ORDER BY con.conname`,
        [oid]
      );
      const idx = await meta(
        `SELECT ic.relname, i.indisunique, i.indisprimary, pg_get_indexdef(i.indexrelid)
         FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE i.indrelid = $1 ORDER BY ic.relname`,
        [oid]
      );
      const fks = (await meta(FK_SQL, [config.schema])).map(fkFromRow);
      const pk = cons.find((c) => c[1] === "p");
      return {
        name,
        kind: KIND[String(head[0][1])] ?? String(head[0][1]),
        comment: head[0][3] === null ? null : String(head[0][3]),
        estRows: Number(head[0][2]) < 0 ? null : Math.round(Number(head[0][2])),
        columns: cols.map((c) => {
          const extras = [];
          if (c[5] === "a") extras.push("identity always");
          else if (c[5] === "d") extras.push("identity by default");
          const generated = c[6] === "s";
          if (generated) extras.push("generated stored");
          return {
            name: String(c[0]),
            type: String(c[1]),
            nullable: Boolean(c[2]),
            default: c[3] === null ? null : String(c[3]),
            comment: c[4] === null ? null : String(c[4]),
            extra: extras.join(", "),
          };
        }),
        primaryKey: pk ? /** @type {string[]} */ (pk[2]) : [],
        foreignKeys: fks.filter((f) => f.schema === config.schema && f.table === name),
        incoming: fks.filter((f) => f.refSchema === config.schema && f.refTable === name),
        unique: cons.filter((c) => c[1] === "u").map((c) => ({ name: String(c[0]), columns: /** @type {string[]} */ (c[2]) })),
        indexes: idx.map((x) => ({
          name: String(x[0]),
          unique: Boolean(x[1]),
          primary: Boolean(x[2]),
          definition: String(x[3]).replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ /, ""),
        })),
      };
    },

    async connectionInfo() {
      const r = await runReadOnly(
        "SELECT version(), current_database(), current_setting('transaction_read_only')",
        { maxRows: 1 }
      );
      const row = r.rows[0];
      return {
        kind: "postgres",
        version: String(row[0]).split(" on ")[0],
        database: String(row[1]),
        schema: config.schema,
        readOnly: String(row[2]) === "on",
      };
    },

    async close() {
      await pool.end();
    },
  };
}
