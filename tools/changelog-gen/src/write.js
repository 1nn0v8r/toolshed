// @ts-check
import fs from "node:fs";

/**
 * Insert a rendered section into a changelog (or replace its Unreleased section), operating on
 * bytes so the rest of the file is preserved exactly.
 * @param {Buffer | null} existing current file bytes, or null for a new file
 * @param {string} section markdown with LF newlines, no trailing newline
 * @param {string} label version label of the new section
 * @returns {{ output: Buffer, action: "created" | "inserted" | "replaced" | "appended" }}
 */
export function applySection(existing, section, label) {
  if (existing === null) {
    return { output: Buffer.from(`# Changelog\n\n${section}\n`, "utf8"), action: "created" };
  }
  const text = existing.toString("latin1"); // one char per byte, so string indexes are byte offsets
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = Buffer.from(section.replace(/\n/g, eol) + eol + eol, "utf8");

  /** @type {{ start: number, unreleased: boolean }[]} */
  const headings = [];
  const re = /^## .*$/gm;
  let m;
  while ((m = re.exec(text))) {
    headings.push({ start: m.index, unreleased: /^##\s+\[?unreleased\]?(\s|$|-)/i.test(m[0]) });
  }

  if (/^unreleased$/i.test(label)) {
    const i = headings.findIndex((h) => h.unreleased);
    if (i !== -1) {
      const start = headings[i].start;
      const end = i + 1 < headings.length ? headings[i + 1].start : text.length;
      const tail = existing.subarray(end);
      // Last section in the file: do not leave a trailing blank line.
      const blk = tail.length === 0 ? block.subarray(0, block.length - Buffer.byteLength(eol)) : block;
      return { output: Buffer.concat([existing.subarray(0, start), blk, tail]), action: "replaced" };
    }
  }

  if (headings.length) {
    const at = headings[0].start;
    return {
      output: Buffer.concat([existing.subarray(0, at), block, existing.subarray(at)]),
      action: "inserted",
    };
  }

  // No version headings yet: append at the end, separated by a blank line.
  let prefix = "";
  if (text.length && !text.endsWith("\n")) prefix = eol + eol;
  else if (text.length && !/(\r?\n){2}$/.test(text)) prefix = eol;
  const tail = Buffer.from(section.replace(/\n/g, eol) + eol, "utf8");
  return { output: Buffer.concat([existing, Buffer.from(prefix, "utf8"), tail]), action: "appended" };
}

/**
 * @param {string} file
 * @param {string} section
 * @param {string} label
 * @returns {"created" | "inserted" | "replaced" | "appended"}
 */
export function writeSection(file, section, label) {
  /** @type {Buffer | null} */
  let existing = null;
  try {
    existing = fs.readFileSync(file);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e;
  }
  const { output, action } = applySection(existing, section, label);
  fs.writeFileSync(file, output);
  return action;
}
