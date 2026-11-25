// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { formatDiagnostics } from "../../modules/diagnostics/format.js";

test("formatDiagnostics formats clean output when empty", () => {
  const res = formatDiagnostics([]);
  assert.equal(res, "Diagnostics: clean, no errors or warnings found.");
});

test("formatDiagnostics summarizes errors and respects maxErrors", () => {
  /** @type {import('../../modules/diagnostics/parsers/tsc.js').Diagnostic[]} */
  const diagnostics = [
    { file: "src/a.ts", line: 10, column: 5, severity: "error", code: "TS2322", message: "Type error." },
    { file: "src/b.ts", line: 20, column: 1, severity: "warning", code: "TS6133", message: "Unused var." },
    { file: "src/c.ts", line: 30, column: 1, severity: "error", code: "TS2304", message: "Not found." },
  ];

  const report = formatDiagnostics(diagnostics, { maxErrors: 2, suppressedCount: 5, includeSnippets: false });
  assert.ok(report.includes("Diagnostics: 2 errors, 1 warning (5 secondary/duplicate diagnostics suppressed)"));
  assert.ok(report.includes("[TS2322] src/a.ts:10:5 (error)"));
  assert.ok(report.includes("[TS6133] src/b.ts:20:1 (warning)"));
  assert.ok(report.includes("... and 1 more diagnostic(s) omitted."));
});
