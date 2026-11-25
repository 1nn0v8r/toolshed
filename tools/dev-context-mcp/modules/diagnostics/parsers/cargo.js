// @ts-check

/**
 * @typedef {import('./tsc.js').Diagnostic} Diagnostic
 */

const CARGO_HEAD_RE = /^(error|warning)(?:\[([A-Za-z0-9]+)\])?:\s*(.+)$/;
const CARGO_LOC_RE = /^\s*-->\s*(?:([A-Za-z]:[\\/][^:\r\n]+|[^:\r\n]+)):([0-9]+):([0-9]+)$/;

/**
 * Parse Rust cargo check output into diagnostics.
 * @param {string} text
 * @returns {Diagnostic[]}
 */
export function parseCargo(text) {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  const lines = text.split(/\r?\n/);

  /** @type {{ severity: 'error' | 'warning', code?: string, message: string } | null} */
  let currentHead = null;

  for (const line of lines) {
    const headMatch = CARGO_HEAD_RE.exec(line.trim());
    if (headMatch) {
      const [, sev, code, msg] = headMatch;
      currentHead = {
        severity: sev.toLowerCase() === "warning" ? "warning" : "error",
        code: code || undefined,
        message: msg.trim(),
      };
      continue;
    }

    const locMatch = CARGO_LOC_RE.exec(line);
    if (locMatch && currentHead) {
      const [, file, lineStr, colStr] = locMatch;
      diagnostics.push({
        file: file.replace(/\\/g, "/"),
        line: parseInt(lineStr, 10),
        column: parseInt(colStr, 10),
        severity: currentHead.severity,
        code: currentHead.code,
        message: currentHead.message,
      });
      currentHead = null;
    }
  }

  return diagnostics;
}
