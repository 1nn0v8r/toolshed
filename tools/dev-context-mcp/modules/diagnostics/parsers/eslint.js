// @ts-check

/**
 * @typedef {import('./tsc.js').Diagnostic} Diagnostic
 */

const COMPACT_RE = /^(?:([A-Za-z]:[\\/][^:\r\n]+|[^:\r\n]+)):\s*line\s*([0-9]+),\s*col\s*([0-9]+),\s*(Error|Warning)(?:\s*-\s*|\s+)(.+?)(?:\s*\(([^)]+)\))?$/i;
const TABLE_ROW_RE = /^\s*([0-9]+):([0-9]+)\s+(error|warning)\s+(.+?)(?:\s{2,}([a-z0-9@\/-]+))?$/i;

/**
 * Parse ESLint output (JSON array or standard text) into diagnostics.
 * @param {string} text
 * @returns {Diagnostic[]}
 */
export function parseEslint(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        /** @type {Diagnostic[]} */
        const list = [];
        for (const fileObj of parsed) {
          const filePath = (fileObj.filePath || "").replace(/\\/g, "/");
          if (!Array.isArray(fileObj.messages)) continue;
          for (const m of fileObj.messages) {
            list.push({
              file: filePath,
              line: m.line || 1,
              column: m.column || 1,
              severity: m.severity === 2 ? "error" : "warning",
              code: m.ruleId || undefined,
              message: m.message || "",
            });
          }
        }
        return list;
      }
    } catch {
      // Fallback to text parsing
    }
  }

  /** @type {Diagnostic[]} */
  const diagnostics = [];
  const lines = text.split(/\r?\n/);
  let currentFile = "";

  for (const line of lines) {
    const compactMatch = COMPACT_RE.exec(line);
    if (compactMatch) {
      const [, file, lineStr, colStr, sev, msg, rule] = compactMatch;
      diagnostics.push({
        file: file.replace(/\\/g, "/"),
        line: parseInt(lineStr, 10),
        column: parseInt(colStr, 10),
        severity: sev.toLowerCase() === "warning" ? "warning" : "error",
        code: rule || undefined,
        message: msg.trim(),
      });
      continue;
    }

    if (!line.startsWith(" ") && !line.startsWith("\t") && (line.includes("/") || line.includes("\\"))) {
      const candidate = line.trim();
      if (!candidate.startsWith("✖") && !candidate.startsWith("✔")) {
        currentFile = candidate.replace(/\\/g, "/");
      }
      continue;
    }

    const rowMatch = TABLE_ROW_RE.exec(line);
    if (rowMatch && currentFile) {
      const [, lineStr, colStr, sev, msg, rule] = rowMatch;
      diagnostics.push({
        file: currentFile,
        line: parseInt(lineStr, 10),
        column: parseInt(colStr, 10),
        severity: sev.toLowerCase() === "warning" ? "warning" : "error",
        code: rule || undefined,
        message: msg.trim(),
      });
    }
  }

  return diagnostics;
}
