// @ts-check

/**
 * @typedef {import('./tsc.js').Diagnostic} Diagnostic
 */

const PY_RE = /^(?:([A-Za-z]:[\\/][^:\r\n]+|[^:\r\n]+)):([0-9]+)(?::([0-9]+))?(?:\s*-\s*|\s*:?\s*)(error|warning|note|info)?(?::\s*|\s+)(.+?)(?:\s*(?:\[|\()([A-Za-z0-9_-]+)(?:\]|\)))?$/i;
const RUFF_RE = /^(?:([A-Za-z]:[\\/][^:\r\n]+|[^:\r\n]+)):([0-9]+):([0-9]+):\s*([A-Za-z0-9_-]+)\s+(.+)$/;

/**
 * Parse Python linters (Pyright, Mypy, Ruff) into diagnostics.
 * @param {string} text
 * @returns {Diagnostic[]}
 */
export function parsePython(text) {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("Found ") || line.startsWith("Success:")) continue;

    const ruffMatch = RUFF_RE.exec(line);
    if (ruffMatch) {
      const [, file, lineStr, colStr, rule, msg] = ruffMatch;
      diagnostics.push({
        file: file.replace(/\\/g, "/"),
        line: parseInt(lineStr, 10),
        column: parseInt(colStr, 10),
        severity: "error",
        code: rule,
        message: msg.trim(),
      });
      continue;
    }

    const match = PY_RE.exec(line);
    if (match) {
      const [, file, lineStr, colStr, sevStr, msg, rule] = match;
      const sevLower = (sevStr || "error").toLowerCase();
      const severity = sevLower === "warning" ? "warning" : sevLower === "note" || sevLower === "info" ? "info" : "error";

      diagnostics.push({
        file: file.replace(/\\/g, "/"),
        line: parseInt(lineStr, 10),
        column: colStr ? parseInt(colStr, 10) : 1,
        severity,
        code: rule || undefined,
        message: msg.trim(),
      });
    }
  }

  return diagnostics;
}
