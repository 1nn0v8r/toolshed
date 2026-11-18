// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { parseCargo } from "../src/parsers/cargo.js";
import { parseEslint } from "../src/parsers/eslint.js";
import { parsePython } from "../src/parsers/python.js";
import { parseTsc } from "../src/parsers/tsc.js";

test("parseTsc parses single and multiline TypeScript errors", () => {
  const output = [
    "src/index.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/utils.ts:45:10 - warning TS6133: 'unused' is declared but its value is never read.",
    "  The expected type comes from property 'count' which is declared here on type 'Config'",
  ].join("\n");

  const diagnostics = parseTsc(output);
  assert.equal(diagnostics.length, 2);

  assert.equal(diagnostics[0].file, "src/index.ts");
  assert.equal(diagnostics[0].line, 12);
  assert.equal(diagnostics[0].column, 5);
  assert.equal(diagnostics[0].severity, "error");
  assert.equal(diagnostics[0].code, "TS2322");

  assert.equal(diagnostics[1].file, "src/utils.ts");
  assert.equal(diagnostics[1].line, 45);
  assert.equal(diagnostics[1].column, 10);
  assert.equal(diagnostics[1].severity, "warning");
  assert.equal(diagnostics[1].code, "TS6133");
  assert.ok(diagnostics[1].message.includes("The expected type comes from"));
});

test("parseEslint parses compact and JSON formats", () => {
  const compact = "src/app.js: line 10, col 5, Error - 'x' is not defined. (no-undef)";
  const resCompact = parseEslint(compact);
  assert.equal(resCompact.length, 1);
  assert.equal(resCompact[0].file, "src/app.js");
  assert.equal(resCompact[0].line, 10);
  assert.equal(resCompact[0].column, 5);
  assert.equal(resCompact[0].severity, "error");
  assert.equal(resCompact[0].code, "no-undef");

  const jsonOutput = JSON.stringify([
    {
      filePath: "src/server.ts",
      messages: [
        { line: 20, column: 8, severity: 1, ruleId: "no-console", message: "Unexpected console statement." },
      ],
    },
  ]);
  const resJson = parseEslint(jsonOutput);
  assert.equal(resJson.length, 1);
  assert.equal(resJson[0].file, "src/server.ts");
  assert.equal(resJson[0].severity, "warning");
  assert.equal(resJson[0].code, "no-console");
});

test("parsePython parses Pyright and Ruff errors", () => {
  const pyright = "app/main.py:15:4 - error: Argument missing for parameter 'db' (reportCallIssue)";
  const ruff = "app/main.py:25:80: E501 Line too long (88 > 79)";

  const d1 = parsePython(pyright);
  assert.equal(d1.length, 1);
  assert.equal(d1[0].file, "app/main.py");
  assert.equal(d1[0].line, 15);
  assert.equal(d1[0].column, 4);
  assert.equal(d1[0].severity, "error");
  assert.equal(d1[0].code, "reportCallIssue");

  const d2 = parsePython(ruff);
  assert.equal(d2.length, 1);
  assert.equal(d2[0].line, 25);
  assert.equal(d2[0].code, "E501");
});

test("parseCargo parses rustc compiler diagnostics", () => {
  const cargo = [
    "error[E0308]: mismatched types",
    "  --> src/main.rs:42:15",
    "   |",
    "42 |     let x: u32 = \"str\";",
    "   |                  ^^^^^ expected `u32`, found `&str`",
  ].join("\n");

  const res = parseCargo(cargo);
  assert.equal(res.length, 1);
  assert.equal(res[0].file, "src/main.rs");
  assert.equal(res[0].line, 42);
  assert.equal(res[0].column, 15);
  assert.equal(res[0].code, "E0308");
  assert.equal(res[0].message, "mismatched types");
});
