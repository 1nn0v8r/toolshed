// @ts-check
// Parse `git diff -U0` output into added lines with real new-file line numbers.

/**
 * @typedef {{ line: number, text: string }} AddedLine
 * @typedef {{ path: string, added: AddedLine[] }} FileDiff
 */

/** @param {string} s */
function unquote(s) {
  if (!(s.startsWith('"') && s.endsWith('"') && s.length >= 2)) return s;
  const inner = s.slice(1, -1);
  /** @type {number[]} */
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = inner[++i];
    const oct = /^[0-7]{3}/.exec(inner.slice(i, i + 3));
    if (oct) {
      bytes.push(parseInt(oct[0], 8));
      i += 2;
    } else if (n === "n") bytes.push(10);
    else if (n === "t") bytes.push(9);
    else bytes.push(...Buffer.from(n ?? "", "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * @param {string} diff raw diff text (LF or CRLF line ends)
 * @returns {FileDiff[]}
 */
export function parseDiff(diff) {
  /** @type {FileDiff[]} */
  const files = [];
  /** @type {FileDiff | null} */
  let cur = null;
  let inHunk = false;
  let next = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      cur = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && raw.startsWith("+++ ")) {
      let p = raw.slice(4).replace(/\t.*$/, "").replace(/\r$/, "");
      if (p === "/dev/null") {
        cur = null;
      } else {
        p = unquote(p);
        cur = { path: p.replace(/^b\//, ""), added: [] };
        files.push(cur);
      }
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      inHunk = true;
      next = Number(h[1]);
      continue;
    }
    if (inHunk && cur && raw.startsWith("+")) {
      cur.added.push({ line: next++, text: raw.slice(1).replace(/\r$/, "") });
    }
  }
  return files;
}
