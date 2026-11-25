// @ts-check

/**
 * @typedef {import('./parsers/tsc.js').Diagnostic} Diagnostic
 */

/**
 * Deduplicate diagnostics and suppress repetitive cascading errors.
 * @param {Diagnostic[]} diagnostics
 * @param {number} [maxPerMessage=3]
 * @returns {{ kept: Diagnostic[], suppressedCount: number }}
 */
export function filterDiagnostics(diagnostics, maxPerMessage = 3) {
  /** @type {Diagnostic[]} */
  const kept = [];
  /** @type {Set<string>} */
  const seenExact = new Set();
  /** @type {Map<string, number>} */
  const patternCounts = new Map();
  let suppressedCount = 0;

  for (const d of diagnostics) {
    // Exact duplicate check
    const exactKey = `${d.file}:${d.line}:${d.column}:${d.code || ""}:${d.message}`;
    if (seenExact.has(exactKey)) {
      suppressedCount++;
      continue;
    }
    seenExact.add(exactKey);

    // Cascading repetitive message pattern check per file
    const patternKey = `${d.file}::${d.code || ""}::${d.message}`;
    const count = patternCounts.get(patternKey) || 0;
    if (count >= maxPerMessage) {
      suppressedCount++;
      continue;
    }

    patternCounts.set(patternKey, count + 1);
    kept.push(d);
  }

  return { kept, suppressedCount };
}
