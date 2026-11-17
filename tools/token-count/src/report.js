// @ts-check

/**
 * @typedef {{path: string, tokens: number, chars: number}} Row
 * @typedef {{path: string, tokens: number, files: number}} DirRow
 */

/**
 * Aggregate rows by top-level directory relative to the root.
 * Files directly in the root go under "(root)".
 * @param {Row[]} rows
 * @returns {DirRow[]}
 */
export function aggregateByDir(rows) {
  /** @type {Map<string, DirRow>} */
  const m = new Map();
  for (const r of rows) {
    const slash = r.path.indexOf("/");
    const key = slash === -1 ? "(root)" : `${r.path.slice(0, slash)}/`;
    const e = m.get(key) ?? { path: key, tokens: 0, files: 0 };
    e.tokens += r.tokens;
    e.files += 1;
    m.set(key, e);
  }
  return [...m.values()];
}

/**
 * Sort by tokens descending, ties by path.
 * @template {{path: string, tokens: number}} T
 * @param {T[]} rows
 * @returns {T[]}
 */
export function sortRows(rows) {
  return [...rows].sort((a, b) => b.tokens - a.tokens || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * @param {number} part
 * @param {number} total
 * @returns {string}
 */
export function pct(part, total) {
  if (total === 0) return "0.0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

/** @param {number} n */
export const fmt = (n) => n.toLocaleString("en-US");

/**
 * @param {{path: string, tokens: number}[]} rows
 * @param {number} total
 * @returns {string[]}
 */
export function renderTable(rows, total) {
  const cells = rows.map((r) => [fmt(r.tokens), pct(r.tokens, total), r.path]);
  const w0 = Math.max("tokens".length, ...cells.map((c) => c[0].length));
  const w1 = Math.max("share".length, ...cells.map((c) => c[1].length));
  const line = (/** @type {string[]} */ c) => `${c[0].padStart(w0)}  ${c[1].padStart(w1)}  ${c[2]}`;
  return [line(["tokens", "share", "path"]), ...cells.map(line)];
}
