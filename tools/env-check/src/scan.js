// @ts-check
import path from "node:path";

/**
 * @typedef {{ name: string, line: number }} Use
 * @typedef {{ line: number }} DynamicUse
 * @typedef {{ uses: Use[], dynamic: DynamicUse[] }} ScanResult
 */

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
/** A string literal holding a plain variable name (quotes: double, single, backtick). */
const LIT = `(?:"(${NAME})"|'(${NAME})'|\`(${NAME})\`)`;
/** Same as LIT but for languages where only double quotes are common. */
const DQ = `"(${NAME})"`;

const LANG_EXTS = /** @type {Record<string, string[]>} */ ({
  js: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte", ".astro"],
  py: [".py"],
  go: [".go"],
  rb: [".rb", ".rake"],
  php: [".php"],
  rs: [".rs"],
});

/** Variables Vite always defines on import.meta.env. They are not user settings. */
const VITE_BUILTINS = new Set(["MODE", "DEV", "PROD", "SSR", "BASE_URL"]);

/**
 * @typedef {{ re: RegExp, skip?: Set<string> }} Rule
 */

/** @param {string} source @param {Set<string>=} skip @returns {Rule} */
function rule(source, skip) {
  return { re: new RegExp(source, "g"), skip };
}

/** @type {Record<string, { uses: Rule[], dynamic: Rule[] }>} */
const RULES = {
  js: {
    uses: [
      rule(`\\bprocess\\.env\\.(${NAME})`),
      rule(`\\bprocess\\.env\\s*\\[\\s*${LIT}\\s*\\]`),
      rule(`\\bimport\\.meta\\.env\\.(${NAME})`, VITE_BUILTINS),
      rule(`\\bimport\\.meta\\.env\\s*\\[\\s*${LIT}\\s*\\]`, VITE_BUILTINS),
      rule(`\\bBun\\.env\\.(${NAME})`),
      rule(`\\bBun\\.env\\s*\\[\\s*${LIT}\\s*\\]`),
      rule(`\\bDeno\\.env\\.get\\(\\s*${LIT}`),
    ],
    dynamic: [
      rule(`\\bprocess\\.env\\s*\\[(?!\\s*${LIT}\\s*\\])`),
      rule(`\\bimport\\.meta\\.env\\s*\\[(?!\\s*${LIT}\\s*\\])`),
      rule(`\\bBun\\.env\\s*\\[(?!\\s*${LIT}\\s*\\])`),
      rule(`\\bDeno\\.env\\.get\\((?!\\s*${LIT})`),
    ],
  },
  py: {
    uses: [
      rule(`\\bos\\.environ\\s*\\[\\s*${LIT}\\s*\\]`),
      rule(`\\bos\\.environ\\.get\\(\\s*${LIT}`),
      rule(`\\bos\\.getenv\\(\\s*${LIT}`),
      rule(`(?<![\\w.])environ\\s*\\[\\s*${LIT}\\s*\\]`),
      rule(`(?<![\\w.])environ\\.get\\(\\s*${LIT}`),
      rule(`(?<![\\w.])getenv\\(\\s*${LIT}`),
    ],
    dynamic: [
      rule(`\\bos\\.environ\\s*\\[(?!\\s*${LIT}\\s*\\])`),
      rule(`\\bos\\.environ\\.get\\((?!\\s*${LIT})`),
      rule(`\\bos\\.getenv\\((?!\\s*${LIT})`),
    ],
  },
  go: {
    uses: [rule(`\\bos\\.(?:Getenv|LookupEnv)\\(\\s*${DQ}`)],
    dynamic: [rule(`\\bos\\.(?:Getenv|LookupEnv)\\((?!\\s*${DQ})`)],
  },
  rb: {
    uses: [
      rule(`(?<![\\w.$@])ENV\\s*\\[\\s*${LIT}\\s*\\]`),
      rule(`(?<![\\w.$@])ENV\\.fetch\\s*\\(?\\s*${LIT}`),
    ],
    dynamic: [
      rule(`(?<![\\w.$@])ENV\\s*\\[(?!\\s*${LIT}\\s*\\])`),
      rule(`(?<![\\w.$@])ENV\\.fetch\\s*\\((?!\\s*${LIT})`),
    ],
  },
  php: {
    uses: [
      rule(`\\bgetenv\\(\\s*${LIT}`),
      rule(`\\$_ENV\\s*\\[\\s*${LIT}\\s*\\]`),
      rule(`(?<![\\w$>:])env\\(\\s*${LIT}`),
    ],
    dynamic: [
      rule(`\\bgetenv\\((?!\\s*(?:${LIT}|\\)))`),
      rule(`\\$_ENV\\s*\\[(?!\\s*${LIT}\\s*\\])`),
    ],
  },
  rs: {
    uses: [
      rule(`\\benv::var(?:_os)?\\(\\s*${DQ}`),
      rule(`(?<![\\w])(?:option_)?env!\\(\\s*${DQ}`),
    ],
    dynamic: [rule(`\\benv::var(?:_os)?\\((?!\\s*${DQ})`)],
  },
  compose: {
    uses: [rule(`(?<!\\$)\\$\\{(${NAME})(?::?[-?+=][^}]*)?\\}`)],
    dynamic: [],
  },
};

/**
 * Which language group a file belongs to, or null when env-check does not scan it.
 * @param {string} file
 * @returns {string | null}
 */
export function languageOf(file) {
  const base = path.basename(file).toLowerCase();
  if (/^(?:docker-)?compose(?:[._-].+)?\.ya?ml$/.test(base) || /^docker-compose.*\.ya?ml$/.test(base)) {
    return "compose";
  }
  const ext = path.extname(base);
  for (const [lang, exts] of Object.entries(LANG_EXTS)) {
    if (exts.includes(ext)) return lang;
  }
  return null;
}

/**
 * Blank out whole-line comments (keeping offsets and newlines) so commented-out reads are ignored.
 * @param {string} content
 * @param {string} lang
 */
function maskComments(content, lang) {
  /** @type {RegExp} */
  let re;
  if (lang === "compose" || lang === "py" || lang === "rb") re = /^[ \t]*#.*$/gm;
  else if (lang === "php") re = /^[ \t]*(?:\/\/|#|\/\*|\*).*$/gm;
  else re = /^[ \t]*(?:\/\/|\/\*|\*).*$/gm;
  return content.replace(re, (m) => " ".repeat(m.length));
}

/** @param {string} content @returns {number[]} offsets where each line starts */
function lineStarts(content) {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** @param {number[]} starts @param {number} index @returns {number} 1-based line */
function lineAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** @param {RegExpExecArray} m @returns {string | undefined} */
function captured(m) {
  return m.slice(1).find((g) => typeof g === "string" && g.length > 0);
}

/**
 * Names pulled out of destructuring such as `const { A, B = 1 } = process.env`.
 * @param {string} text masked source
 * @param {number[]} starts
 * @returns {Use[]}
 */
function destructured(text, starts) {
  /** @type {Use[]} */
  const out = [];
  const re = /\{([^{}]*)\}\s*=\s*(?:process\.env|import\.meta\.env|Bun\.env)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1];
    const innerStart = m.index + 1;
    // Blank string literals so commas inside default values do not split parts.
    const masked = inner.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, (s) => " ".repeat(s.length));
    let offset = 0;
    for (const part of masked.split(",")) {
      const pm = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)/.exec(part);
      if (pm) out.push({ name: pm[2], line: lineAt(starts, innerStart + offset + pm[1].length) });
      offset += part.length + 1;
    }
  }
  return out;
}

/**
 * Find environment variable reads in one file's content.
 * @param {string} file path or name, used only to pick the language
 * @param {string} content
 * @returns {ScanResult}
 */
export function scanContent(file, content) {
  const lang = languageOf(file);
  if (!lang) return { uses: [], dynamic: [] };
  const text = maskComments(content, lang);
  const starts = lineStarts(text);
  const rules = RULES[lang];
  /** @type {Use[]} */
  const uses = [];
  /** @type {DynamicUse[]} */
  const dynamic = [];
  for (const { re, skip } of rules.uses) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = captured(m);
      if (name && !(skip && skip.has(name))) uses.push({ name, line: lineAt(starts, m.index) });
    }
  }
  if (lang === "js") uses.push(...destructured(text, starts));
  for (const { re } of rules.dynamic) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      dynamic.push({ line: lineAt(starts, m.index) });
    }
  }
  return { uses: dedupe(uses), dynamic };
}

/** @param {Use[]} uses */
function dedupe(uses) {
  const seen = new Set();
  /** @type {Use[]} */
  const out = [];
  for (const u of uses) {
    const key = `${u.name}:${u.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}
