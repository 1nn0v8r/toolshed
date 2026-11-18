// @ts-check
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {import('./parsers/tsc.js').Diagnostic} Diagnostic
 */

/**
 * Read context snippet around the error line if file exists.
 * @param {string} root
 * @param {string} relFile
 * @param {number} line
 * @param {number} column
 * @returns {string | null}
 */
export function getCodeSnippet(root, relFile, line, column) {
  try {
    const absPath = path.isAbsolute(relFile) ? relFile : path.join(root, relFile);
    if (!fs.existsSync(absPath)) return null;
    const content = fs.readFileSync(absPath, "utf8");
    const lines = content.split(/\r?\n/);
    if (line < 1 || line > lines.length) return null;

    const errorLine = lines[line - 1];
    const pad = String(line).length;
    const pointer = " ".repeat(Math.max(0, column - 1)) + "^";

    return `  ${String(line).padStart(pad)} | ${errorLine}\n  ${" ".repeat(pad)} | ${pointer}`;
  } catch {
    return null;
  }
}

/**
 * Format diagnostics into a token-capped summary.
 * @param {Diagnostic[]} diagnostics
 * @param {{
 *   root?: string,
 *   maxErrors?: number,
 *   suppressedCount?: number,
 *   includeSnippets?: boolean,
 * }} [opts]
 * @returns {string}
 */
export function formatDiagnostics(diagnostics, opts = {}) {
  const maxErrors = opts.maxErrors ?? 15;
  const root = opts.root ?? process.cwd();
  const includeSnippets = opts.includeSnippets ?? true;

  const totalErrors = diagnostics.filter((d) => d.severity === "error").length;
  const totalWarnings = diagnostics.filter((d) => d.severity === "warning").length;
  const suppressed = opts.suppressedCount ?? 0;

  if (diagnostics.length === 0) {
    return "Diagnostics: clean, no errors or warnings found.";
  }

  const lines = [];
  let summary = `Diagnostics: ${totalErrors} error${totalErrors === 1 ? "" : "s"}, ${totalWarnings} warning${totalWarnings === 1 ? "" : "s"}`;
  if (suppressed > 0) {
    summary += ` (${suppressed} secondary/duplicate diagnostics suppressed)`;
  }
  lines.push(summary, "");

  const shown = diagnostics.slice(0, maxErrors);
  for (const d of shown) {
    const codeTag = d.code ? `[${d.code}] ` : "";
    const header = `${codeTag}${d.file}:${d.line}:${d.column} (${d.severity})`;
    lines.push(header);
    lines.push(d.message);

    if (includeSnippets) {
      const snippet = getCodeSnippet(root, d.file, d.line, d.column);
      if (snippet) lines.push(snippet);
    }
    lines.push("");
  }

  if (diagnostics.length > maxErrors) {
    lines.push(`... and ${diagnostics.length - maxErrors} more diagnostic(s) omitted.`);
  }

  return lines.join("\n").trim();
}
