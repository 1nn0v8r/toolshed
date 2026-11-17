// @ts-check

/**
 * @typedef {{ key: string, line: number }} EnvKey
 */

/**
 * Index of the closing quote in `s`, or -1. Double quotes and backticks honour backslash escapes.
 * @param {string} s text after the opening quote
 * @param {string} q the quote character
 */
function closeIndex(s, q) {
  for (let i = 0; i < s.length; i++) {
    if (q !== "'" && s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === q) return i;
  }
  return -1;
}

/**
 * Extract the key names from dotenv-style text. Values are never returned, so they cannot leak.
 * Handles `export KEY=`, comments, blank lines, quoted values (including multi-line) and CRLF.
 * @param {string} text
 * @returns {EnvKey[]}
 */
export function parseEnvKeys(text) {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  /** @type {EnvKey[]} */
  const keys = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/.exec(t);
    if (!m) continue;
    keys.push({ key: m[1], line: i + 1 });
    const rest = m[2].trimStart();
    const q = rest[0];
    if (q === '"' || q === "'" || q === "`") {
      let remainder = rest.slice(1);
      while (closeIndex(remainder, q) === -1 && i + 1 < lines.length) {
        i++;
        remainder = lines[i];
      }
    }
  }
  return keys;
}
