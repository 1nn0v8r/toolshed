// @ts-check
import { assertReadOnlySql, GuardError } from "./guard.js";
import { formatResult, formatTable, formatTableDescription, formatRelationships } from "./format.js";
import { isSecretColumn, REDACTED, redactSecrets } from "./redact.js";
import { HARD_MAX_ROWS } from "./config.js";

/** @typedef {{ config: import("./config.js").Config, getDb: () => import("./db.js").Database }} Context */

export const SAMPLE_DEFAULT = 5;
export const SAMPLE_MAX = 20;
const MAX_LIST = 500;

/** A user-facing error whose message is safe to return as is. */
export class ToolError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * @param {unknown} v
 * @param {number} def
 * @param {number} min
 * @param {number} max
 */
export function clampInt(v, def, min, max) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Map a requested table name to the real catalog name (exact, then unique case-insensitive).
 * @param {import("./db.js").Database} db
 * @param {unknown} input
 */
export async function resolveTable(db, input) {
  if (typeof input !== "string" || input.trim() === "") throw new ToolError("argument 'table' is required");
  let name = input.trim();
  if (db.kind === "postgres" && name.startsWith(db.schema + ".")) name = name.slice(db.schema.length + 1);
  const tables = await db.listTables();
  const exact = tables.find((t) => t.name === name);
  if (exact) return exact;
  const ci = tables.filter((t) => t.name.toLowerCase() === name.toLowerCase());
  if (ci.length === 1) return ci[0];
  const names = tables.map((t) => t.name);
  const shown = names.slice(0, 20).join(", ");
  throw new ToolError(`table not found: ${name}. Available: ${shown || "(none)"}${names.length > 20 ? `, and ${names.length - 20} more` : ""}`);
}

/** @type {{ name: string, description: string, inputSchema: Record<string, unknown>, handler: (args: Record<string, unknown>, ctx: Context) => Promise<string> }[]} */
export const TOOLS = [
  {
    name: "list_tables",
    description: "List tables and views with estimated row counts and comments.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler(_args, ctx) {
      const tables = await ctx.getDb().listTables();
      if (tables.length === 0) return "No tables or views found.";
      const shown = tables.slice(0, MAX_LIST);
      const body = formatTable(
        ["name", "kind", "est_rows", "comment"],
        shown.map((t) => [t.name, t.kind, t.estRows === null ? "?" : t.estRows, t.comment ?? ""])
      );
      return `${body}\n(${tables.length} table${tables.length === 1 ? "" : "s"}${tables.length > MAX_LIST ? `, first ${MAX_LIST} shown` : ""})`;
    },
  },
  {
    name: "describe_table",
    description: "Describe one table: columns, primary key, outgoing and incoming foreign keys, unique constraints and indexes.",
    inputSchema: {
      type: "object",
      properties: { table: { type: "string", description: "Table or view name" } },
      required: ["table"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const db = ctx.getDb();
      const t = await resolveTable(db, args.table);
      return formatTableDescription(await db.describeTable(t.name), db.schema);
    },
  },
  {
    name: "list_relationships",
    description: "List all foreign keys as 'orders.customer_id -> customers.id'.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler(_args, ctx) {
      const db = ctx.getDb();
      return formatRelationships(await db.foreignKeys(), db.schema);
    },
  },
  {
    name: "sample_rows",
    description: `Sample rows from a table (default ${SAMPLE_DEFAULT}, max ${SAMPLE_MAX}). Values of secret-looking columns (password, token, hash, ...) are masked and long values are truncated.`,
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table or view name" },
        limit: { type: "integer", description: `Rows to return (1 to ${SAMPLE_MAX}, default ${SAMPLE_DEFAULT})` },
      },
      required: ["table"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const db = ctx.getDb();
      const t = await resolveTable(db, args.table);
      const limit = clampInt(args.limit, SAMPLE_DEFAULT, 1, SAMPLE_MAX);
      const qualified = db.kind === "postgres" ? `${db.quoteIdent(db.schema)}.${db.quoteIdent(t.name)}` : db.quoteIdent(t.name);
      const res = await db.runReadOnly(`SELECT * FROM ${qualified} LIMIT ${limit}`, { maxRows: limit });
      const secret = res.columns.map(isSecretColumn);
      return formatResult(res, {
        maxRows: limit,
        mask: (i, v) => (secret[i] && v !== null && v !== undefined ? REDACTED : v),
      });
    },
  },
  {
    name: "run_select",
    description: `Run one read-only query (SELECT, WITH, SHOW, EXPLAIN without ANALYZE). Rejected if it contains write keywords; always executed in a read-only transaction with a timeout. Rows are capped (default from DB_MAX_ROWS, hard max ${HARD_MAX_ROWS}).`,
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single read-only SQL statement" },
        maxRows: { type: "integer", description: `Row cap (1 to ${HARD_MAX_ROWS})` },
      },
      required: ["sql"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const db = ctx.getDb();
      const sql = assertReadOnlySql(args.sql, db.kind);
      const maxRows = clampInt(args.maxRows, ctx.config.maxRows, 1, HARD_MAX_ROWS);
      const res = await db.runReadOnly(sql, { maxRows });
      return formatResult(res, { maxRows });
    },
  },
  {
    name: "connection_info",
    description: "Database kind, server version, current database and schema, and whether queries run read-only. Never includes credentials.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler(_args, ctx) {
      const info = await ctx.getDb().connectionInfo();
      return [
        `kind: ${info.kind}`,
        `version: ${info.version}`,
        `database: ${info.database}`,
        `schema: ${info.schema}`,
        `read-only: ${info.readOnly ? "yes (every query runs in a READ ONLY transaction that is rolled back)" : "NO"}`,
        `max rows: ${ctx.config.maxRows} default, ${HARD_MAX_ROWS} hard max`,
        `statement timeout: ${ctx.config.timeoutMs} ms`,
      ].join("\n");
    },
  },
];

/**
 * Run a tool and convert any failure to an MCP error result with secrets removed.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {Context} ctx
 * @returns {Promise<{ content: { type: "text", text: string }[], isError?: boolean }>}
 */
export async function callTool(name, args, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: [{ type: "text", text: `Error: unknown tool ${name}` }], isError: true };
  try {
    const text = await tool.handler(args ?? {}, ctx);
    return { content: [{ type: "text", text }] };
  } catch (e) {
    const err = /** @type {any} */ (e);
    let msg = err && err.message ? String(err.message) : String(err);
    if (!(err instanceof ToolError) && !(err instanceof GuardError)) {
      const code = err && err.code ? ` [${err.code}]` : "";
      msg = `${msg}${code}`;
    }
    return { content: [{ type: "text", text: `Error: ${redactSecrets(msg, ctx.config)}` }], isError: true };
  }
}
