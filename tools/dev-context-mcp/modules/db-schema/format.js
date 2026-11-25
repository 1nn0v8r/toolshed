// @ts-check
// Compact text output: aligned tables, TSV for wide results, and the
// describe_table / relationship renderers.

export const MAX_CELL = 200;
const MAX_TABLE_WIDTH = 160;

/**
 * @param {unknown} v
 * @param {number} [maxLen]
 */
export function formatValue(v, maxLen = MAX_CELL) {
  let s;
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") s = v;
  else if (typeof v === "bigint") s = v.toString();
  else if (v instanceof Date) s = Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
  else if (Buffer.isBuffer(v)) s = `<${v.length} bytes>`;
  else if (typeof v === "object") {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  } else s = String(v);
  s = s.replace(/\r\n|\r|\n/g, "\\n");
  if (s.length > maxLen) s = s.slice(0, maxLen) + "...";
  return s;
}

/**
 * @param {string[]} columns
 * @param {unknown[][]} rows
 * @param {{ maxWidth?: number, maxCell?: number, mask?: (colIndex: number, value: unknown) => unknown }} [opts]
 * @returns {string} aligned table, or TSV when wider than maxWidth (no footer)
 */
export function formatTable(columns, rows, opts = {}) {
  const maxWidth = opts.maxWidth ?? MAX_TABLE_WIDTH;
  const maxCell = opts.maxCell ?? MAX_CELL;
  const cells = rows.map((r) =>
    columns.map((_, i) => {
      const raw = opts.mask ? opts.mask(i, r[i]) : r[i];
      return formatValue(raw, maxCell);
    })
  );
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
  const total = widths.reduce((a, b) => a + b, 0) + 2 * Math.max(0, columns.length - 1);
  if (total > maxWidth) {
    const tsv = (/** @type {string[]} */ arr) => arr.map((s) => s.replace(/\t/g, " ")).join("\t");
    return [tsv(columns), ...cells.map(tsv)].join("\n");
  }
  const line = (/** @type {string[]} */ arr) =>
    arr.map((s, i) => (i === arr.length - 1 ? s : s.padEnd(widths[i]))).join("  ").trimEnd();
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(columns), sep, ...cells.map(line)].join("\n");
}

/**
 * Full query result with a row-count footer.
 * @param {{ columns: string[], rows: unknown[][], truncated: boolean }} result
 * @param {{ maxRows: number, mask?: (colIndex: number, value: unknown) => unknown }} opts
 */
export function formatResult(result, opts) {
  const { columns, rows, truncated } = result;
  const shown = rows.slice(0, opts.maxRows);
  if (columns.length === 0) return "(no result columns)";
  const body = formatTable(columns, shown, { mask: opts.mask });
  const count = `${shown.length} row${shown.length === 1 ? "" : "s"}`;
  const footer = truncated ? `(${count}, truncated at maxRows=${opts.maxRows}; more rows exist)` : `(${count})`;
  return `${body}\n${footer}`;
}

/**
 * @typedef {{ name: string, schema?: string, table: string, columns: string[], refSchema?: string, refTable: string, refColumns: string[], onUpdate?: string, onDelete?: string }} ForeignKey
 */

/**
 * @param {string} table
 * @param {string[]} cols
 */
function side(table, cols) {
  return cols.length === 1 ? `${table}.${cols[0]}` : `${table}.(${cols.join(", ")})`;
}

/**
 * @param {ForeignKey} fk
 * @param {string} defaultSchema
 */
export function formatForeignKey(fk, defaultSchema) {
  const src = fk.schema && fk.schema !== defaultSchema ? `${fk.schema}.${fk.table}` : fk.table;
  const dst = fk.refSchema && fk.refSchema !== defaultSchema ? `${fk.refSchema}.${fk.refTable}` : fk.refTable;
  const extras = [];
  if (fk.onDelete && fk.onDelete !== "NO ACTION" && fk.onDelete !== "RESTRICT") extras.push(`on delete ${fk.onDelete.toLowerCase()}`);
  if (fk.onUpdate && fk.onUpdate !== "NO ACTION" && fk.onUpdate !== "RESTRICT") extras.push(`on update ${fk.onUpdate.toLowerCase()}`);
  return `${side(src, fk.columns)} -> ${side(dst, fk.refColumns)}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

/**
 * @param {ForeignKey[]} fks
 * @param {string} defaultSchema
 */
export function formatRelationships(fks, defaultSchema) {
  if (fks.length === 0) return "No foreign keys found.";
  return fks.map((f) => formatForeignKey(f, defaultSchema)).join("\n") + `\n(${fks.length} foreign key${fks.length === 1 ? "" : "s"})`;
}

/**
 * @typedef {{ name: string, type: string, nullable: boolean, default: string | null, comment: string | null, extra?: string | null }} ColumnInfo
 * @typedef {{ name: string, kind: string, comment: string | null, estRows: number | null, columns: ColumnInfo[], primaryKey: string[], foreignKeys: ForeignKey[], incoming: ForeignKey[], unique: { name: string, columns: string[] }[], indexes: { name: string, unique: boolean, primary: boolean, definition: string }[] }} TableDescription
 */

/** @param {string} s */
function indent(s) {
  return s.split("\n").map((l) => "  " + l).join("\n");
}

/**
 * @param {TableDescription} t
 * @param {string} defaultSchema
 */
export function formatTableDescription(t, defaultSchema) {
  const out = [];
  const rows = t.estRows === null ? "" : `, ~${t.estRows} rows`;
  out.push(`${t.name} (${t.kind}${rows})`);
  if (t.comment) out.push(`comment: ${formatValue(t.comment)}`);
  out.push("columns:");
  const colRows = t.columns.map((c) => [
    c.name,
    c.type,
    c.nullable ? "NULL" : "NOT NULL",
    [c.default !== null && c.default !== undefined ? `default ${c.default}` : "", c.extra || ""].filter(Boolean).join(" "),
    c.comment ? `-- ${c.comment}` : "",
  ]);
  out.push(indent(formatTable(["name", "type", "null", "default", "comment"], colRows, { maxWidth: 400 })));
  out.push(`primary key: ${t.primaryKey.length ? `(${t.primaryKey.join(", ")})` : "none"}`);
  out.push("foreign keys (outgoing):");
  out.push(t.foreignKeys.length ? indent(t.foreignKeys.map((f) => `${f.name}: ${formatForeignKey(f, defaultSchema)}`).join("\n")) : "  none");
  out.push("foreign keys (incoming):");
  out.push(t.incoming.length ? indent(t.incoming.map((f) => `${f.name}: ${formatForeignKey(f, defaultSchema)}`).join("\n")) : "  none");
  out.push("unique constraints:");
  out.push(t.unique.length ? indent(t.unique.map((u) => `${u.name}: (${u.columns.join(", ")})`).join("\n")) : "  none");
  out.push("indexes:");
  out.push(
    t.indexes.length
      ? indent(t.indexes.map((x) => `${x.name}: ${x.primary ? "PRIMARY " : x.unique ? "UNIQUE " : ""}${x.definition}`).join("\n"))
      : "  none"
  );
  return out.join("\n");
}
