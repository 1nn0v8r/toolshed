// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { filterDiagnostics } from "../src/filters.js";

test("filterDiagnostics suppresses exact duplicates and cascading identical messages", () => {
  /** @type {import('../src/parsers/tsc.js').Diagnostic[]} */
  const diagnostics = [
    { file: "src/a.ts", line: 10, column: 5, severity: "error", code: "TS2304", message: "Cannot find name 'x'." },
    { file: "src/a.ts", line: 10, column: 5, severity: "error", code: "TS2304", message: "Cannot find name 'x'." }, // exact duplicate
    { file: "src/a.ts", line: 15, column: 5, severity: "error", code: "TS2304", message: "Cannot find name 'x'." },
    { file: "src/a.ts", line: 20, column: 5, severity: "error", code: "TS2304", message: "Cannot find name 'x'." },
    { file: "src/a.ts", line: 25, column: 5, severity: "error", code: "TS2304", message: "Cannot find name 'x'." }, // 4th occurrence in same file
    { file: "src/b.ts", line: 5, column: 2, severity: "error", code: "TS2307", message: "Cannot find module 'foo'." },
  ];

  const { kept, suppressedCount } = filterDiagnostics(diagnostics, 2);
  assert.equal(suppressedCount, 3);
  assert.equal(kept.length, 3);
});
