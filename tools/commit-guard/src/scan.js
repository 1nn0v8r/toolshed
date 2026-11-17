// @ts-check
import { isEnvFile } from "./rules.js";

/**
 * @typedef {{
 *   path: string,
 *   line: number,
 *   column: number,
 *   severity: 'error' | 'warn',
 *   rule: string,
 *   message: string,
 * }} Finding
 * @typedef {{
 *   rules: import('./rules.js').Rule[],
 *   allow: RegExp[],
 *   maxFileSizeKB: number,
 * }} ScanOptions
 */

export const IGNORE_MARKER = "commit-guard: ignore";

/**
 * @param {Buffer} buf
 * @returns {boolean} true when the buffer looks binary (NUL in the first 8000 bytes)
 */
export function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Split text into numbered lines, accepting LF and CRLF.
 * @param {string} text
 * @returns {{ line: number, text: string }[]}
 */
export function textToLines(text) {
  const parts = text.replace(/^﻿/, "").split(/\r?\n/);
  return parts.map((t, i) => ({ line: i + 1, text: t }));
}

/**
 * Scan numbered lines with every enabled content rule.
 * @param {string} file
 * @param {{ line: number, text: string }[]} lines
 * @param {ScanOptions} opts
 * @returns {Finding[]}
 */
export function scanLines(file, lines, opts) {
  const rules = opts.rules.filter((r) => r.enabled && r.kind === "line" && r.scan);
  /** @type {Finding[]} */
  const out = [];
  for (const { line, text } of lines) {
    if (text.length === 0 || text.includes(IGNORE_MARKER)) continue;
    for (const rule of rules) {
      for (const m of /** @type {NonNullable<typeof rule.scan>} */ (rule.scan)(text)) {
        if (opts.allow.some((re) => re.test(text) || re.test(m.text))) continue;
        out.push({
          path: file,
          line,
          column: m.index + 1,
          severity: rule.severity,
          rule: rule.id,
          message: m.message,
        });
      }
    }
  }
  return out;
}

/**
 * File-level rules (file.env, file.large).
 * @param {string} file
 * @param {number | undefined} size bytes, when known
 * @param {ScanOptions} opts
 * @returns {Finding[]}
 */
export function scanFileRules(file, size, opts) {
  /** @type {Finding[]} */
  const out = [];
  for (const rule of opts.rules) {
    if (!rule.enabled || rule.kind !== "file") continue;
    if (rule.id === "file.env" && isEnvFile(file)) {
      out.push({
        path: file, line: 0, column: 0, severity: rule.severity, rule: rule.id,
        message: "Environment file must not be committed (use .env.example)",
      });
    }
    if (rule.id === "file.large" && size !== undefined && size > opts.maxFileSizeKB * 1024) {
      out.push({
        path: file, line: 0, column: 0, severity: rule.severity, rule: rule.id,
        message: `File is ${(size / 1024).toFixed(1)} KB, over the ${opts.maxFileSizeKB} KB limit`,
      });
    }
  }
  return out;
}
