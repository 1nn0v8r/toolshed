// @ts-check
// Rule definitions. Content rules scan one line at a time; file rules look at the path and size.

/**
 * @typedef {{ index: number, text: string, message: string }} Match
 * @typedef {'error' | 'warn'} Severity
 * @typedef {{
 *   id: string,
 *   description: string,
 *   severity: Severity,
 *   enabled: boolean,
 *   kind: 'line' | 'file',
 *   scan?: (line: string) => Match[],
 * }} Rule
 */

export const EM_DASH = String.fromCharCode(0x2014);
export const EN_DASH = String.fromCharCode(0x2013);
export const ELLIPSIS = String.fromCharCode(0x2026);

/**
 * Replace typography characters with ASCII equivalents:
 * - Em dash (U+2014) -> "--"
 * - En dash (U+2013) -> "-"
 * - Ellipsis (U+2026) -> "..."
 * @param {string} text
 * @returns {string}
 */
export function fixTypography(text) {
  return text
    .replaceAll(EM_DASH, "--")
    .replaceAll(EN_DASH, "-")
    .replaceAll(ELLIPSIS, "...");
}

/**
 * Show the first 4 characters then "***". Never returns the full value.
 * @param {string} s
 */
export function mask(s) {
  return s.slice(0, 4) + "***";
}

/**
 * @param {RegExp} re must have the g flag
 * @param {string} label
 * @param {(text: string, m: RegExpMatchArray) => boolean} [accept]
 * @returns {(line: string) => Match[]}
 */
function regexScan(re, label, accept) {
  return (line) => {
    /** @type {Match[]} */
    const out = [];
    for (const m of line.matchAll(re)) {
      const text = m[0];
      if (accept && !accept(text, m)) continue;
      out.push({ index: m.index ?? 0, text, message: `${label} (${mask(text)})` });
    }
    return out;
  };
}

const PLACEHOLDER_RE = new RegExp(
  [
    "changeme",
    "change[-_ ]me",
    "replace[-_ ]?(?:me|with)",
    "^<.*>$",
    "\\$\\{.*\\}",
    "\\{\\{.*\\}\\}",
    "xxx",
    "example",
    "your[-_ ]",
    "placeholder",
    "dummy",
    "sample",
    "\\*{3,}",
    "^\\.{3,}$",
  ].join("|"),
  "i",
);

/**
 * True for obvious placeholder values.
 * @param {string} value
 */
export function isPlaceholder(value) {
  return PLACEHOLDER_RE.test(value);
}

/** @param {string} v */
function charClasses(v) {
  let n = 0;
  if (/[a-z]/.test(v)) n++;
  if (/[A-Z]/.test(v)) n++;
  if (/[0-9]/.test(v)) n++;
  if (/[^A-Za-z0-9]/.test(v)) n++;
  return n;
}

const GENERIC_RE = new RegExp(
  "(api[_-]?key|secret|token|passw(?:or)?d|pwd|private[_-]?key|access[_-]?key|auth[_-]?key|credentials?)" +
    "(?:[_-][A-Za-z0-9_-]*|key)?" +
    "[\"']?\\s*(?:=>|:=|=|:)\\s*" +
    "([\"'`])([^\"'`\\s]{12,})\\2",
  "gi",
);

/** @param {string} line @returns {Match[]} */
function scanGeneric(line) {
  /** @type {Match[]} */
  const out = [];
  if (!/(?:key|secret|token|pass|pwd|credential)/i.test(line)) return out;
  for (const m of line.matchAll(GENERIC_RE)) {
    const value = m[3];
    if (isPlaceholder(value)) continue;
    const classes = charClasses(value);
    const hasDigit = /[0-9]/.test(value);
    const hasLetter = /[A-Za-z]/.test(value);
    if (!hasDigit || !hasLetter) continue;
    if (!(classes >= 3 || (classes >= 2 && value.length >= 20))) continue;
    const start = (m.index ?? 0) + m[0].indexOf(value);
    out.push({ index: start, text: value, message: `Hardcoded ${m[1].toLowerCase()} assignment (${mask(value)})` });
  }
  return out;
}

const PATH_NAME = "([^\\\\/\\s\"'`<>:*?|%$(){}\\[\\]]+)";
const WIN_PATH_RE = new RegExp("(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]+Users[\\\\/]+" + PATH_NAME + "[\\\\/]", "gi");
const UNIX_PATH_RE = new RegExp("(?<![A-Za-z0-9_.~$}:\\-])/(?:Users|home)/" + PATH_NAME + "/", "g");
const PLACEHOLDER_NAMES = new Set([
  "you", "user", "username", "example", "...", "name", "yourname", "your-name", "your_name",
  "me", "foo", "bar", "public", "default", "shared", "runner", "all users", "someone",
]);

/** @param {string} line @returns {Match[]} */
function scanPersonalPath(line) {
  /** @type {Match[]} */
  const out = [];
  for (const re of [WIN_PATH_RE, UNIX_PATH_RE]) {
    for (const m of line.matchAll(re)) {
      const name = m[1];
      const lower = name.toLowerCase();
      if (PLACEHOLDER_NAMES.has(lower) || lower.startsWith("your") || /^\.+$/.test(name)) continue;
      out.push({
        index: m.index ?? 0,
        text: m[0],
        message: `Machine-specific home path (user ${mask(name)})`,
      });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** @param {string} line @returns {Match[]} */
function scanTypography(line) {
  /** @type {Match[]} */
  const out = [];
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === EM_DASH) out.push({ index: i, text: ch, message: "Em dash (U+2014)" });
    else if (ch === EN_DASH) out.push({ index: i, text: ch, message: "En dash (U+2013)" });
    else if (ch === ELLIPSIS) out.push({ index: i, text: ch, message: "Ellipsis character (U+2026)" });
  }
  return out;
}

/** @type {Rule[]} */
export const RULES = [
  {
    id: "secret.aws-access-key",
    description: "AWS access key id (AKIA or ASIA followed by 16 uppercase alphanumerics)",
    severity: "error",
    enabled: true,
    kind: "line",
    scan: regexScan(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "AWS access key", (t) => !t.endsWith("EXAMPLE")),
  },
  {
    id: "secret.github-token",
    description: "GitHub token (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_)",
    severity: "error",
    enabled: true,
    kind: "line",
    scan: regexScan(/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, "GitHub token"),
  },
  {
    id: "secret.private-key",
    description: "PEM private key header",
    severity: "error",
    enabled: true,
    kind: "line",
    scan: regexScan(new RegExp("-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----", "g"), "Private key"),
  },
  {
    id: "secret.slack-token",
    description: "Slack token (xoxb-, xoxa-, xoxp-, xoxr-, xoxs-)",
    severity: "error",
    enabled: true,
    kind: "line",
    scan: regexScan(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "Slack token"),
  },
  {
    id: "secret.stripe-live",
    description: "Stripe live key (sk_live_, rk_live_)",
    severity: "error",
    enabled: true,
    kind: "line",
    scan: regexScan(/\b[sr]k_live_[A-Za-z0-9]{10,}/g, "Stripe live key"),
  },
  {
    id: "secret.anthropic-key",
    description: "Anthropic API key (sk-ant-)",
    severity: "error",
    enabled: true,
    kind: "line",
    scan: regexScan(/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "Anthropic API key"),
  },
  {
    id: "secret.openai-key",
    description: "OpenAI API key (sk- followed by 20+ characters, or sk-proj-)",
    severity: "error",
    enabled: true,
    kind: "line",
    scan: regexScan(/\bsk-(?:proj-[A-Za-z0-9_-]{16,}|(?!ant-)[A-Za-z0-9]{20,})/g, "OpenAI API key"),
  },
  {
    id: "secret.google-api-key",
    description: "Google API key (AIza followed by 35 characters)",
    severity: "error",
    enabled: true,
    kind: "line",
    scan: regexScan(/\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, "Google API key"),
  },
  {
    id: "secret.jwt",
    description: "JSON Web Token (three base64url segments starting with eyJ)",
    severity: "error",
    enabled: true,
    kind: "line",
    scan: regexScan(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "JSON Web Token"),
  },
  {
    id: "secret.generic-assignment",
    description: "api_key, secret, token or password assigned a quoted value that looks real",
    severity: "error",
    enabled: true,
    kind: "line",
    scan: scanGeneric,
  },
  {
    id: "path.personal",
    description: "Absolute home path containing a username (Windows, macOS, Linux)",
    severity: "warn",
    enabled: true,
    kind: "line",
    scan: scanPersonalPath,
  },
  {
    id: "file.env",
    description: "Staged .env or .env.* file (examples, samples and templates are allowed)",
    severity: "error",
    enabled: true,
    kind: "file",
  },
  {
    id: "file.large",
    description: "File larger than maxFileSizeKB (default 1024)",
    severity: "warn",
    enabled: true,
    kind: "file",
  },
  {
    id: "text.typography",
    description: "Em dash, en dash or ellipsis character (off by default)",
    severity: "warn",
    enabled: false,
    kind: "line",
    scan: scanTypography,
  },
];

export const RULE_IDS = RULES.map((r) => r.id);

const ENV_ALLOWED = new Set([".env.example", ".env.sample", ".env.template"]);

/**
 * @param {string} filePath
 * @returns {boolean} true when the file name is a real env file
 */
export function isEnvFile(filePath) {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  if (ENV_ALLOWED.has(base.toLowerCase())) return false;
  return base === ".env" || /^\.env\..+/.test(base);
}
