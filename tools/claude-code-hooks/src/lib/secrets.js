// @ts-check

/**
 * @typedef {{ name: string, line: number, masked: string }} Finding
 */

/** Marker that silences a finding on its line. */
const ALLOW_MARKERS = ["claude-hooks:allow", "gitleaks:allow"];

// Built from pieces so this source file never contains a literal key header.
const PRIVATE_KEY_RE = new RegExp("-----BEGIN " + "(?:[A-Z0-9]+ )*PRIVATE KEY" + "(?: BLOCK)?-----");

/** @type {{ name: string, re: RegExp }[]} */
export const SECRET_PATTERNS = [
  { name: "AWS access key id", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { name: "Private key block", re: new RegExp(PRIVATE_KEY_RE.source, "g") },
  { name: "Slack token", re: /\bxox[abprso]-[A-Za-z0-9-]{10,}\b/g },
  { name: "Stripe live key", re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g },
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "OpenAI API key", re: /\bsk-proj-[A-Za-z0-9_-]{20,}/g },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
];

const GENERIC_RE =
  /([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|passwd|password|pwd|auth[_-]?key|private[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)["']?\s*[:=]>?\s*(["'`])?([^\s"'`,;)(}{]{8,})/gi;

const PLACEHOLDER_WORDS = [
  "example",
  "your",
  "placeholder",
  "changeme",
  "change_me",
  "change-me",
  "dummy",
  "sample",
  "xxxx",
  "redacted",
  "fake",
  "todo",
  "insert",
  "replace",
  "secret_here",
  "token_here",
  "key_here",
  "password_here",
  "notasecret",
  "test",
  "foobar",
];

/**
 * Mask a secret for display: first four characters, then stars.
 * @param {string} s
 */
export function mask(s) {
  const t = s.trim();
  if (t.length <= 8) return "****";
  return t.slice(0, 4) + "****";
}

/**
 * True when a value looks like a placeholder, a variable reference or a
 * trivial string rather than a real secret.
 * @param {string} value
 */
export function isPlaceholder(value) {
  const v = value.trim();
  const lower = v.toLowerCase();
  if (/^[$%<{[@]/.test(v)) return true;
  if (/^(?:x+|\*+|\.+|-+|_+|0+)$/i.test(v)) return true;
  if (/^(?:null|undefined|none|true|false|nil)$/i.test(v)) return true;
  if (/^(?:process|os|env|config|settings|secrets|self|this)[.:[]/i.test(v)) return true;
  if (/^(?:12345678|abcdef|qwerty|password|letmein)/i.test(v)) return true;
  if (/^https?:\/\//i.test(v)) return true;
  for (const w of PLACEHOLDER_WORDS) if (lower.includes(w)) return true;
  if (new Set(v).size < 5) return true;
  return false;
}

/**
 * Whether a value found next to a secret-like name is plausibly real.
 * @param {string} value
 * @param {boolean} quoted
 */
function looksReal(value, quoted) {
  if (isPlaceholder(value)) return false;
  if (quoted) {
    if (value.length < 10) return false;
    return /\d/.test(value) || /[!@#$%^&*+/=]/.test(value);
  }
  if (value.length < 16) return false;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(value)) return false;
  return /\d/.test(value) && /[A-Za-z]/.test(value);
}

/**
 * Scan text for secrets. Findings carry masked values only.
 * @param {string} text
 * @param {{ extraPatterns?: { name: string, re: RegExp }[] }} [opts]
 * @returns {Finding[]}
 */
export function findSecrets(text, opts = {}) {
  /** @type {Finding[]} */
  const out = [];
  if (!text) return out;
  const lines = text.split(/\r?\n/);
  const patterns = SECRET_PATTERNS.concat(opts.extraPatterns || []);
  lines.forEach((line, idx) => {
    if (ALLOW_MARKERS.some((m) => line.includes(m))) return;
    /** @type {Set<string>} */
    const seen = new Set();
    for (const p of patterns) {
      const re = new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : p.re.flags + "g");
      for (const m of line.matchAll(re)) {
        if (/EXAMPLE/.test(m[0])) continue;
        const key = p.name + m.index;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name: p.name, line: idx + 1, masked: p.name === "Private key block" ? "-----BEGIN ****" : mask(m[0]) });
      }
    }
    for (const m of line.matchAll(GENERIC_RE)) {
      const value = m[3];
      const quoted = Boolean(m[2]);
      if (!looksReal(value, quoted)) continue;
      out.push({ name: `Hard-coded secret assigned to "${m[1].slice(0, 40)}"`, line: idx + 1, masked: mask(value) });
    }
  });
  return out;
}
