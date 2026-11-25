// @ts-check

/**
 * Compute a concise line-by-line diff with context lines using LCS.
 * @param {string} label
 * @param {string} beforeText
 * @param {string} afterText
 * @param {number} [contextLines]
 * @returns {string}
 */
export function formatLineDiff(label, beforeText, afterText, contextLines = 3) {
  const normBefore = beforeText.replace(/\r\n/g, "\n");
  const normAfter = afterText.replace(/\r\n/g, "\n");
  if (normBefore === normAfter) {
    return "";
  }

  const a = normBefore.length === 0 ? [] : normBefore.split("\n");
  const b = normAfter.length === 0 ? [] : normAfter.split("\n");

  const n = a.length;
  const m = b.length;

  // Guard against quadratic DP on unusually huge files
  if (n * m > 200_000) {
    return [
      `--- a/${label}`,
      `+++ b/${label}`,
      `@@ -1,${n} +1,${m} @@`,
      `- (${n} lines)`,
      `+ (${m} lines)`,
    ].join("\n");
  }

  /** @type {Int32Array[]} */
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  /** @type {Array<{ type: " " | "-" | "+", line: string }>} */
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: " ", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "-", line: a[i] });
      i++;
    } else {
      ops.push({ type: "+", line: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "-", line: a[i++] });
  }
  while (j < m) {
    ops.push({ type: "+", line: b[j++] });
  }

  // Group into hunks with context
  /** @type {number[]} */
  const changedIndices = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type !== " ") changedIndices.push(k);
  }
  if (changedIndices.length === 0) return "";

  /** @type {Array<[number, number]>} */
  const ranges = [];
  for (const idx of changedIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(ops.length - 1, idx + contextLines);
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev[1] + 1) {
      prev[1] = Math.max(prev[1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  const lines = [`--- a/${label}`, `+++ b/${label}`];
  for (const [start, end] of ranges) {
    let aLine = 1;
    let bLine = 1;
    for (let k = 0; k < start; k++) {
      if (ops[k].type !== "+") aLine++;
      if (ops[k].type !== "-") bLine++;
    }
    let aCount = 0;
    let bCount = 0;
    for (let k = start; k <= end; k++) {
      if (ops[k].type !== "+") aCount++;
      if (ops[k].type !== "-") bCount++;
    }
    lines.push(`@@ -${aLine},${aCount} +${bLine},${bCount} @@`);
    for (let k = start; k <= end; k++) {
      lines.push(`${ops[k].type}${ops[k].line}`);
    }
  }

  return lines.join("\n");
}
