// @ts-check
import mysql from "mysql2";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("./db.js").Database} Database */

/**
 * @param {Config} config
 * @returns {Database}
 */
export function connectMysql(config) {
  const pool = mysql.createPool({
    uri: config.url,
    connectionLimit: 2,
    connectTimeout: 10000,
    multipleStatements: false,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  pool.on("error", () => {
    // Pool-level errors must not crash the process.
  });

  /** @returns {Promise<import("mysql2").PoolConnection>} */
  const getConnection = () =>
    new Promise((resolve, reject) => pool.getConnection((err, conn) => (err ? reject(err) : resolve(conn))));

  /**
   * @param {import("mysql2").PoolConnection} conn
   * @param {string} sql
   */
  const exec = (conn, sql) =>
    new Promise((resolve, reject) => conn.query(sql, (err, res) => (err ? reject(err) : resolve(res))));

  /**
   * @param {string} sql
   * @param {{ params?: unknown[], maxRows?: number, timeoutMs?: number }} [opts]
   * @returns {Promise<{ columns: string[], rows: unknown[][], truncated: boolean }>}
   */
  async function runReadOnly(sql, opts = {}) {
    const maxRows = opts.maxRows ?? config.maxRows;
    const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? config.timeoutMs));
    const conn = await getConnection();
    let discard = false;
    let started = false;
    try {
      // Make sure the lexical assumptions of the SQL guard hold for this session.
      await exec(conn, "SET SESSION sql_mode = REPLACE(REPLACE(@@sql_mode, 'NO_BACKSLASH_ESCAPES', ''), 'ANSI_QUOTES', '')");
      await exec(conn, `SET SESSION MAX_EXECUTION_TIME = ${timeoutMs}`);
      // The session default matters: DDL implicitly commits, which would end a
      // READ ONLY transaction and let CREATE/DROP/ALTER through.
      await exec(conn, "SET SESSION transaction_read_only = 1");
      await exec(conn, "START TRANSACTION READ ONLY");
      started = true;
      /** @type {string[]} */
      let columns = [];
      /** @type {unknown[][]} */
      const rows = [];
      let truncated = false;
      await new Promise((resolve, reject) => {
        // Safety net for statements MAX_EXECUTION_TIME does not cover (it only applies to SELECT).
        const timer = setTimeout(() => {
          discard = true;
          conn.destroy();
          reject(new Error(`query exceeded ${timeoutMs} ms and was cancelled`));
        }, timeoutMs + 2000);
        const q = conn.query({ sql: opts.params ? mysql.format(sql, /** @type {any[]} */ (opts.params)) : sql, rowsAsArray: true });
        q.on("fields", (/** @type {{ name: string }[]} */ f) => {
          columns = f.map((x) => x.name);
        });
        q.on("result", (/** @type {unknown[]} */ row) => {
          if (truncated) return;
          if (rows.length >= maxRows) {
            // One row past the cap proves truncation; drop the connection to stop the stream.
            truncated = true;
            discard = true;
            clearTimeout(timer);
            conn.destroy();
            resolve(undefined);
            return;
          }
          rows.push(row);
        });
        q.on("error", (/** @type {Error} */ e) => {
          clearTimeout(timer);
          if (truncated) resolve(undefined);
          else reject(e);
        });
        q.on("end", () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
      return { columns, rows, truncated };
    } finally {
      // A destroyed connection has already been removed from the pool.
      if (!discard) {
        if (started) {
          try {
            await exec(conn, "ROLLBACK");
          } catch {
            conn.destroy();
            discard = true;
          }
        }
        conn.release();
      }
    }
  }

  /** @param {string} sql @param {unknown[]} [params] */
  const meta = (sql, params) => runReadOnly(sql, { params, maxRows: 5000 }).then((r) => r.rows);

  /** @param {unknown[][]} rows */
  function groupFks(rows) {
    /** @type {Map<string, import("./format.js").ForeignKey>} */
    const map = new Map();
    for (const r of rows) {
      const key = `${r[0]}\u0000${r[1]}`;
      let fk = map.get(key);
      if (!fk) {
        fk = {
          name: String(r[0]),
          table: String(r[1]),
          columns: [],
          refSchema: String(r[3]) === String(r[8]) ? undefined : String(r[3]),
          refTable: String(r[4]),
          refColumns: [],
          onUpdate: String(r[6]),
          onDelete: String(r[7]),
        };
        map.set(key, fk);
      }
      fk.columns.push(String(r[2]));
      fk.refColumns.push(String(r[5]));
    }
    return [...map.values()];
  }

  const FK_SQL = `SELECT k.CONSTRAINT_NAME, k.TABLE_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA,
      k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE, DATABASE()
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
    WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
    ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`;

  return {
    kind: "mysql",
    schema: "",
    runReadOnly,
    quoteIdent: (name) => "`" + name.replace(/`/g, "``") + "`",

    async listTables() {
      const rows = await meta(
        `SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`
      );
      return rows.map((r) => {
        const isView = String(r[1]) === "VIEW";
        return {
          name: String(r[0]),
          kind: isView ? "view" : "table",
          estRows: isView || r[2] === null ? null : Number(r[2]),
          comment: isView || r[3] === null || String(r[3]) === "" ? null : String(r[3]),
        };
      });
    },

    async foreignKeys() {
      return groupFks(await meta(FK_SQL));
    },

    async describeTable(name) {
      const head = await meta(
        `SELECT TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [name]
      );
      if (head.length === 0) throw new Error(`table not found: ${name}`);
      const isView = String(head[0][0]) === "VIEW";
      const cols = await meta(
        `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT, EXTRA
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [name]
      );
      const stats = await meta(
        `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        [name]
      );
      const fks = groupFks(await meta(FK_SQL));
      /** @type {Map<string, { unique: boolean, type: string, cols: string[] }>} */
      const indexes = new Map();
      for (const s of stats) {
        const key = String(s[0]);
        let ix = indexes.get(key);
        if (!ix) {
          ix = { unique: Number(s[1]) === 0, type: String(s[3]), cols: [] };
          indexes.set(key, ix);
        }
        ix.cols.push(String(s[2]));
      }
      const pk = indexes.get("PRIMARY");
      return {
        name,
        kind: isView ? "view" : "table",
        comment: isView || head[0][2] === null || String(head[0][2]) === "" ? null : String(head[0][2]),
        estRows: isView || head[0][1] === null ? null : Number(head[0][1]),
        columns: cols.map((c) => ({
          name: String(c[0]),
          type: String(c[1]),
          nullable: String(c[2]) === "YES",
          default: c[3] === null ? null : String(c[3]),
          comment: c[4] === null || String(c[4]) === "" ? null : String(c[4]),
          extra: c[5] === null ? "" : String(c[5]),
        })),
        primaryKey: pk ? pk.cols : [],
        foreignKeys: fks.filter((f) => f.table === name),
        incoming: fks.filter((f) => f.refTable === name),
        unique: [...indexes.entries()].filter(([n, i]) => i.unique && n !== "PRIMARY").map(([n, i]) => ({ name: n, columns: i.cols })),
        indexes: [...indexes.entries()].map(([n, i]) => ({
          name: n,
          unique: i.unique,
          primary: n === "PRIMARY",
          definition: `${i.type} (${i.cols.join(", ")})`,
        })),
      };
    },

    async connectionInfo() {
      const r = await runReadOnly("SELECT VERSION(), DATABASE()", { maxRows: 1 });
      const row = r.rows[0];
      return {
        kind: "mysql",
        version: String(row[0]),
        database: row[1] === null ? "(none)" : String(row[1]),
        schema: row[1] === null ? "(none)" : String(row[1]),
        // Enforced per query with START TRANSACTION READ ONLY.
        readOnly: true,
      };
    },

    async close() {
      await new Promise((resolve) => pool.end(() => resolve(undefined)));
    },
  };
}
