// @ts-check
import { connectPostgres } from "./postgres.js";
import { connectMysql } from "./mysql.js";

/**
 * @typedef {{
 *   kind: "postgres" | "mysql",
 *   schema: string,
 *   runReadOnly: (sql: string, opts?: { params?: unknown[], maxRows?: number, timeoutMs?: number }) => Promise<{ columns: string[], rows: unknown[][], truncated: boolean }>,
 *   quoteIdent: (name: string) => string,
 *   listTables: () => Promise<{ name: string, kind: string, estRows: number | null, comment: string | null }[]>,
 *   foreignKeys: () => Promise<import("./format.js").ForeignKey[]>,
 *   describeTable: (name: string) => Promise<import("./format.js").TableDescription>,
 *   connectionInfo: () => Promise<{ kind: string, version: string, database: string, schema: string, readOnly: boolean }>,
 *   close: () => Promise<void>,
 * }} Database
 */

/**
 * Open a lazily connecting, read-only database handle. Every query made through
 * it (including internal catalog queries) runs inside a READ ONLY transaction
 * that is always rolled back.
 * @param {import("./config.js").Config} config
 * @returns {Database}
 */
export function createDatabase(config) {
  return config.kind === "postgres" ? connectPostgres(config) : connectMysql(config);
}
