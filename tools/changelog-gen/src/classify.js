// @ts-check

/**
 * @typedef {"Added" | "Changed" | "Fixed" | "Removed" | "Documentation"} Category
 * @typedef {{
 *   hash: string, short: string, subject: string, category: Category,
 *   hidden: boolean, breaking: boolean, breakingNote: string | null, type: string | null
 * }} Entry
 */

export const CONVENTIONAL_TYPES = ["feat", "fix", "perf", "refactor", "docs", "revert", "chore", "test", "ci", "build", "style"];
export const HIDDEN_TYPES = new Set(["chore", "test", "ci", "build", "style"]);

/** @type {Record<string, Category>} */
const TYPE_CATEGORY = {
  feat: "Added",
  fix: "Fixed",
  perf: "Changed",
  refactor: "Changed",
  docs: "Documentation",
  revert: "Removed",
};

/** @type {Record<string, Category>} */
const WORD_CATEGORY = {};
for (const [cat, words] of /** @type {[Category, string[]][]} */ ([
  ["Added", ["add", "create", "introduce"]],
  ["Fixed", ["fix", "correct", "repair"]],
  ["Removed", ["remove", "drop", "delete"]],
])) {
  for (const w of words) {
    WORD_CATEGORY[w] = cat;
    WORD_CATEGORY[`${w}s`] = cat;
    WORD_CATEGORY[`${w.replace(/e$/, "")}ed`] = cat;
  }
}
WORD_CATEGORY.added = "Added";
WORD_CATEGORY.dropped = "Removed";

const TRAILER_RE =
  /^(co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|helped-by|cc|change-id|reviewed-on)\s*:/i;
const BREAKING_RE = /^BREAKING[ -]CHANGE\s*:\s*(.*)$/;

/**
 * Remove trailer lines (Co-Authored-By, Signed-off-by, ...) from a commit body.
 * @param {string} body
 * @returns {string}
 */
export function stripTrailers(body) {
  return body
    .split(/\r?\n/)
    .filter((l) => !TRAILER_RE.test(l.trim()))
    .join("\n")
    .trim();
}

/**
 * Find a BREAKING CHANGE footer in a body that has already had trailers stripped.
 * @param {string} body
 * @returns {{ found: boolean, note: string | null }}
 */
export function findBreakingFooter(body) {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = BREAKING_RE.exec(lines[i]);
    if (!m) continue;
    const parts = [m[1].trim()];
    for (let j = i + 1; j < lines.length && lines[j].trim() !== ""; j++) parts.push(lines[j].trim());
    const note = parts.filter(Boolean).join(" ");
    return { found: true, note: note || null };
  }
  return { found: false, note: null };
}

/**
 * @param {string} subject
 * @returns {Category}
 */
export function categoryFromFirstWord(subject) {
  const word = (/^[A-Za-z]+/.exec(subject.trim()) || [""])[0].toLowerCase();
  return WORD_CATEGORY[word] || "Changed";
}

/**
 * Classify one commit.
 * @param {{ hash: string, short: string, subject: string, body: string }} commit
 * @param {{ names: string[] }} ctx names: folder or scope names whose `name:` prefix may be stripped
 * @returns {Entry}
 */
export function classify(commit, ctx) {
  const body = stripTrailers(commit.body || "");
  const footer = findBreakingFooter(body);
  const subject = commit.subject.trim();
  const names = ctx.names.map((n) => n.toLowerCase());

  const conv = /^([A-Za-z]+)(?:\(([^()\r\n]*)\))?(!)?:\s+(.+)$/.exec(subject);
  if (conv && CONVENTIONAL_TYPES.includes(conv[1].toLowerCase())) {
    const type = conv[1].toLowerCase();
    const scope = conv[2] ? conv[2].trim() : "";
    let text = conv[4].trim();
    if (scope && !names.includes(scope.toLowerCase())) text = `**${scope}:** ${text}`;
    const breaking = Boolean(conv[3]) || footer.found;
    const hiddenType = HIDDEN_TYPES.has(type);
    return {
      hash: commit.hash,
      short: commit.short,
      subject: text,
      category: TYPE_CATEGORY[type] || "Changed",
      hidden: hiddenType && !breaking,
      breaking,
      breakingNote: footer.note,
      type,
    };
  }

  let text = subject;
  const repo = /^([A-Za-z0-9_./-]+):\s+(.+)$/.exec(subject);
  if (repo && names.includes(repo[1].toLowerCase())) text = repo[2].trim();
  return {
    hash: commit.hash,
    short: commit.short,
    subject: text,
    category: categoryFromFirstWord(text),
    hidden: false,
    breaking: footer.found,
    breakingNote: footer.note,
    type: null,
  };
}
