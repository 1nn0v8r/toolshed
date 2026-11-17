// @ts-check

/** @typedef {import("./classify.js").Entry} Entry */

export const SECTION_ORDER = /** @type {const} */ (["Added", "Changed", "Fixed", "Removed", "Documentation"]);

/**
 * @param {Entry[]} entries already filtered for visibility
 * @returns {{ sections: Record<string, Entry[]>, breaking: Entry[] }}
 */
export function group(entries) {
  /** @type {Record<string, Entry[]>} */
  const sections = {};
  for (const name of SECTION_ORDER) sections[name] = [];
  /** @type {Entry[]} */
  const breaking = [];
  for (const e of entries) {
    sections[e.category].push(e);
    if (e.breaking) breaking.push(e);
  }
  return { sections, breaking };
}

/**
 * @param {Entry} e
 * @param {boolean} hash
 * @param {boolean} useNote
 */
function line(e, hash, useNote) {
  const text = useNote && e.breakingNote ? `${e.subject}: ${e.breakingNote}` : e.subject;
  return `- ${text}${hash ? ` (${e.short})` : ""}`;
}

/**
 * Render the markdown section (LF newlines, no trailing newline).
 * @param {{ label: string, date: string, entries: Entry[], hash: boolean }} opts
 * @returns {string}
 */
export function renderMarkdown(opts) {
  const { sections, breaking } = group(opts.entries);
  const out = [`## ${opts.label} - ${opts.date}`];
  for (const name of SECTION_ORDER) {
    if (!sections[name].length) continue;
    out.push("", `### ${name}`, "", ...sections[name].map((e) => line(e, opts.hash, false)));
  }
  if (breaking.length) {
    out.push("", "### Breaking", "", ...breaking.map((e) => line(e, opts.hash, true)));
  }
  return out.join("\n");
}
