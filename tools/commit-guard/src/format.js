// @ts-check

/**
 * @typedef {import('./scan.js').Finding} Finding
 * @typedef {{ errors: number, warnings: number, filesScanned: number }} Summary
 */

/**
 * @param {Finding[]} findings
 * @param {number} filesScanned
 * @returns {Summary}
 */
export function summarize(findings, filesScanned) {
  return {
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warn").length,
    filesScanned,
  };
}

/** @param {Finding} f */
export function formatFinding(f) {
  return `${f.path}:${f.line}  ${f.severity}  ${f.rule}  ${f.message}`;
}

/**
 * @param {Summary} s
 */
export function formatSummary(s) {
  const plural = (/** @type {number} */ n, /** @type {string} */ w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (s.errors === 0 && s.warnings === 0) {
    return `commit-guard: no problems found (${plural(s.filesScanned, "file")} scanned)`;
  }
  return `commit-guard: ${plural(s.errors, "error")}, ${plural(s.warnings, "warning")} (${plural(s.filesScanned, "file")} scanned)`;
}

/**
 * @param {Finding[]} findings
 * @param {Summary} summary
 */
export function formatJson(findings, summary) {
  return JSON.stringify({ ok: summary.errors === 0, summary, findings }, null, 2);
}

/**
 * Plain-text table of rules.
 * @param {{ id: string, severity: string, enabled: boolean, description: string }[]} rules
 */
export function formatRules(rules) {
  const idW = Math.max(...rules.map((r) => r.id.length), 2);
  const lines = [`${"id".padEnd(idW)}  severity  enabled  description`];
  for (const r of rules) {
    lines.push(`${r.id.padEnd(idW)}  ${r.severity.padEnd(8)}  ${(r.enabled ? "yes" : "no").padEnd(7)}  ${r.description}`);
  }
  return lines.join("\n");
}
