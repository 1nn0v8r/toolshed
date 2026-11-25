// @ts-check
import { clipLine, stripAnsi } from "./util.js";

/** @typedef {import("./parsers.js").Report} Report */
/** @typedef {import("./parsers.js").Failure} Failure */

export const MAX_CHARS = 12000;
export const MAX_MESSAGE_LINES = 20;

/** @param {number | undefined} ms */
function fmtDuration(ms) {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/**
 * @param {Failure} f
 * @param {number} index 1-based
 * @param {number} maxMessageLines
 */
export function formatFailure(f, index, maxMessageLines = MAX_MESSAGE_LINES) {
  const out = [];
  out.push(`${index}) ${f.kind === "error" ? "[error] " : ""}${stripAnsi(f.name)}`);
  if (f.file) out.push(`   at ${f.file}${f.line ? `:${f.line}` : ""}`);
  const msg = stripAnsi(f.message).split("\n").map((l) => clipLine(l.replace(/\s+$/, "")));
  const shown = msg.slice(0, maxMessageLines);
  for (const l of shown) out.push(`   ${l}`);
  if (msg.length > shown.length) out.push(`   ... (${msg.length - shown.length} more message lines)`);
  if (f.stack.length) {
    out.push("   stack:");
    for (const fr of f.stack) out.push(`     ${clipLine(fr, 300)}`);
  }
  return out.join("\n");
}

/**
 * @param {Report} report
 * @param {{runner?: string, command?: string, maxChars?: number, maxMessageLines?: number, notes?: string[]}} [opts]
 */
export function formatReport(report, opts = {}) {
  const max = opts.maxChars ?? MAX_CHARS;
  const s = report.summary;
  const parts = [`${s.total} tests`, `${s.passed} passed`, `${s.failed} failed`];
  if (s.errors) parts.push(`${s.errors} errors`);
  parts.push(`${s.skipped} skipped`);
  const dur = fmtDuration(s.durationMs);
  const head = [`Summary: ${parts.join(", ")}${dur ? ` (${dur})` : ""}`];
  if (opts.runner) head.unshift(`Runner: ${opts.runner}`);
  if (opts.command) head.splice(opts.runner ? 1 : 0, 0, `Command: ${opts.command}`);
  for (const n of opts.notes ?? []) head.push(`Note: ${n}`);

  if (report.failures.length === 0) {
    head.push(s.failed + s.errors > 0 ? "No failure details were found in the report." : "All tests passed.");
    return head.join("\n");
  }

  head.push("", `Failures (${report.failures.length}):`);
  let text = head.join("\n");
  let shown = 0;
  for (let i = 0; i < report.failures.length; i++) {
    const block = formatFailure(report.failures[i], i + 1, opts.maxMessageLines);
    const remaining = report.failures.length - i - 1;
    const reserve = remaining > 0 ? 60 : 0;
    if (text.length + block.length + 2 + reserve > max) {
      if (shown === 0) {
        text += `\n\n${block.slice(0, Math.max(200, max - text.length - 80))}\n   ... (clipped)`;
        shown = 1;
      }
      break;
    }
    text += `\n\n${block}`;
    shown++;
  }
  const omitted = report.failures.length - shown;
  if (omitted > 0) text += `\n\n... ${omitted} more failure${omitted === 1 ? "" : "s"} omitted (output cap ${max} chars).`;
  return text;
}
