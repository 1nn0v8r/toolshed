// @ts-check

/**
 * @typedef {{
 *   file: string,
 *   line: number,
 *   column: number,
 *   severity: 'error' | 'warning' | 'info',
 *   code?: string,
 *   message: string,
 * }} Diagnostic
 */

const TSC_RE = /^(?:([A-Za-z]:[\\/][^(\r\n:]+|[^(\r\n:]+))[(\:]([0-9]+)[,:]([0-9]+)\)?(?::\s*|\s*-\s*|\s+)(error|warning|info)\s+([A-Za-z0-9]+):\s*(.+)$/i;

/**
 * Parse TypeScript compiler output into structured diagnostics.
 * @param {string} text
 * @returns {Diagnostic[]}
 */
export function parseTsc(text) {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  const lines = text.split(/\r?\n/);

  /** @type {Diagnostic | null} */
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const match = TSC_RE.exec(line);

    if (match) {
      if (current) diagnostics.push(current);
      const [, file, lineStr, colStr, sevStr, code, message] = match;
      const severity = sevStr.toLowerCase() === "warning" ? "warning" : "error";
      current = {
        file: file.replace(/\\/g, "/"),
        line: parseInt(lineStr, 10),
        column: parseInt(colStr, 10),
        severity,
        code,
        message: message.trim(),
      };
    } else if (current && (rawLine.startsWith("  ") || rawLine.startsWith("\t"))) {
      // Append secondary context lines to the message
      const extra = rawLine.trim();
      if (extra && !extra.startsWith("~")) {
        current.message += ` ${extra}`;
      }
    }
  }

  if (current) diagnostics.push(current);
  return diagnostics;
}
