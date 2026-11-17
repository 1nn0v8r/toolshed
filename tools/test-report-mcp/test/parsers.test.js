// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFailure, detectFormat, parseByFormat, parseGoJson, parseJestJson, parseJunit,
  parseMochaJson, parseTap, parseTapYaml, parseXml,
} from "../src/parsers.js";
import { fixture, ROOT_PLACEHOLDER } from "./helpers.js";

const opts = { roots: [ROOT_PLACEHOLDER] };
const crlf = (/** @type {string} */ s) => s.replace(/\r?\n/g, "\r\n");

test("parseXml handles CDATA, comments, entities, self-closing and single-quoted attrs", () => {
  const doc = parseXml("<?xml version='1.0'?><!-- c --><a x='1' y=\"&lt;b&gt;\"><b/><c><![CDATA[raw <x> & y]]></c><d>&#233;&#x1F680;&bogus;</d></a>");
  const a = doc.children[0];
  assert.equal(a.attrs.x, "1");
  assert.equal(a.attrs.y, "<b>");
  assert.equal(a.children.length, 3);
  assert.equal(a.children[1].text, "raw <x> & y");
  assert.equal(a.children[2].text, "é\u{1F680}&bogus;");
});

test("parseXml tolerates stray '<', unclosed and mismatched tags", () => {
  const doc = parseXml("<a>1 < 2<b></a><c>");
  assert.equal(doc.children[0].name, "a");
  assert.ok(doc.children.length >= 1);
});

test("junit (vitest style): counts, names, locations, noise frames, unicode", () => {
  const r = parseJunit(fixture("vitest-junit.xml"), opts);
  assert.deepEqual(
    { ...r.summary },
    { total: 6, passed: 2, failed: 2, errors: 1, skipped: 1, durationMs: 1234 },
  );
  assert.equal(r.failures.length, 3);
  const [uni, api, crash] = r.failures;
  assert.equal(uni.name, "math > handles café and 日本語 & emoji \u{1F680}");
  assert.equal(uni.file, "test/math.test.ts");
  assert.equal(uni.line, 14);
  assert.match(uni.message, /expected 'café' to be 'cafe'/);
  assert.ok(uni.stack.every((f) => !f.includes("node_modules")));
  assert.equal(api.name, "api > returns 200 for <health>");
  assert.equal(api.file, "test/api.test.ts");
  assert.equal(api.line, 30);
  assert.equal(crash.kind, "error");
  assert.equal(crash.file, "src/api.ts");
  assert.ok(!crash.stack.join("\n").includes("node:internal"));
  assert.ok(!JSON.stringify(r).includes(ROOT_PLACEHOLDER));
});

test("junit works with CRLF line endings", () => {
  const r = parseJunit(crlf(fixture("vitest-junit.xml")), opts);
  assert.equal(r.failures.length, 3);
  assert.equal(r.failures[1].line, 30);
  assert.ok(!r.failures[0].message.includes("\r"));
});

test("junit (pytest style): classname grouping, E lines, error vs failure, skipped", () => {
  const r = parseJunit(fixture("pytest-junit.xml"), opts);
  assert.equal(r.summary.total, 4);
  assert.equal(r.summary.failed, 1);
  assert.equal(r.summary.errors, 1);
  assert.equal(r.summary.skipped, 1);
  assert.equal(r.summary.passed, 1);
  const [f, e] = r.failures;
  assert.equal(f.name, "tests.test_calc.TestDivide > test_by_zero");
  assert.equal(f.file, "tests/test_calc.py");
  assert.equal(f.line, 14);
  assert.match(f.message, /assert 1 == 2/);
  assert.match(f.message, /where 1 = add\(0, 1\)/);
  assert.equal(e.kind, "error");
  assert.equal(e.name, "tests.test_io > test_fixture_broken");
  assert.match(e.message, /NameError/);
});

test("junit: nested suites build the name, bare testsuite root, no failures", () => {
  const xml = `<testsuite name="Outer"><testsuite name="Inner"><testcase name="t1" time="0.5"><failure>boom</failure></testcase><testcase name="t2" time="0.25"/></testsuite></testsuite>`;
  const r = parseJunit(xml);
  assert.equal(r.failures[0].name, "Outer > Inner > t1");
  assert.equal(r.failures[0].message, "boom");
  assert.equal(r.summary.durationMs, 750);
  assert.equal(r.summary.total, 2);
  const none = parseJunit(`<testsuites><testsuite name="x"><testcase name="a"/></testsuite></testsuites>`);
  assert.equal(none.failures.length, 0);
  assert.equal(none.summary.passed, 1);
});

test("junit: failure without message or body falls back to type, then placeholder", () => {
  const r = parseJunit(`<testsuite><testcase name="a"><failure type="Oops"/></testcase><testcase name="b"><failure/></testcase></testsuite>`);
  assert.equal(r.failures[0].message, "Oops");
  assert.equal(r.failures[1].message, "(no message)");
});

test("junit: status=skipped attribute counts as skipped; empty input is empty report", () => {
  const r = parseJunit(`<testsuite><testcase name="a" status="skipped"/></testsuite>`);
  assert.equal(r.summary.skipped, 1);
  const empty = parseJunit("");
  assert.equal(empty.summary.total, 0);
  assert.deepEqual(empty.failures, []);
});

test("junit: line attribute is used when no stack frames exist", () => {
  const r = parseJunit(`<testsuite><testcase name="a" file="x/y.py" line="7"><failure message="bad"/></testcase></testsuite>`);
  assert.equal(r.failures[0].file, "x/y.py");
  assert.equal(r.failures[0].line, 7);
});

test("jest json: names, ANSI stripped, suite crash, todo and pending counted as skipped", () => {
  const r = parseJestJson(fixture("jest.json"), opts);
  assert.equal(r.summary.failed, 1);
  assert.equal(r.summary.errors, 1);
  assert.equal(r.summary.skipped, 2);
  assert.equal(r.summary.passed, 2);
  assert.equal(r.summary.durationMs, 1000);
  const [f, crash] = r.failures;
  assert.equal(f.name, "Cart > totals > applies discount éè ✓");
  assert.equal(f.file, "src/__tests__/cart.test.js");
  assert.equal(f.line, 21);
  assert.ok(!f.message.includes("\u001b"));
  assert.match(f.message, /Expected: 90/);
  assert.ok(f.stack.length === 1);
  assert.equal(crash.kind, "error");
  assert.equal(crash.name, "src/__tests__/broken.test.js");
  assert.match(crash.message, /Cannot find module/);
});

test("jest json: uses location from testLocationInResults and tolerates BOM and CRLF", () => {
  const data = JSON.parse(fixture("jest.json"));
  data.testResults[0].assertionResults[1].location = { line: 99, column: 3 };
  const r = parseJestJson("﻿" + crlf(JSON.stringify(data, null, 2)), opts);
  assert.equal(r.failures[0].line, 99);
});

test("jest json: minimal and empty documents", () => {
  const r = parseJestJson("{}");
  assert.equal(r.summary.total, 0);
  assert.throws(() => parseJestJson("not json"));
});

test("mocha json", () => {
  const r = parseMochaJson(fixture("mocha.json"), opts);
  assert.deepEqual(
    { total: r.summary.total, passed: r.summary.passed, failed: r.summary.failed, skipped: r.summary.skipped, ms: r.summary.durationMs },
    { total: 4, passed: 2, failed: 1, skipped: 1, ms: 42 },
  );
  assert.equal(r.failures[0].name, "Validator rejects bad input ü");
  assert.equal(r.failures[0].file, "test/validator.spec.js");
  assert.equal(r.failures[0].line, 17);
  assert.equal(r.failures[0].message, "expected 'ok' to equal 'bad'");
  assert.equal(parseMochaJson("{}").summary.total, 0);
});

test("tap yaml: block scalars, quoted strings, escapes", () => {
  const y = parseTapYaml([
    "  a: 'it''s'",
    '  b: "line\\nbreak"',
    "  c: |-",
    "    one",
    "",
    "      two",
    "  d: plain",
    "  not a key",
  ]);
  assert.equal(y.a, "it's");
  assert.equal(y.b, "line\nbreak");
  assert.equal(y.c, "one\n\n  two");
  assert.equal(y.d, "plain");
  assert.deepEqual(parseTapYaml([]), {});
  assert.equal(parseTapYaml(['x: "bad\\q"']).x, 'bad\\q');
});

test("tap (node): nested subtests, subtestsFailed parents are not double counted", () => {
  const r = parseTap(fixture("node-tap.txt"), opts);
  assert.deepEqual(
    { ...r.summary },
    { total: 5, passed: 2, failed: 2, errors: 0, skipped: 1, durationMs: 51 },
  );
  const [uni, top] = r.failures;
  assert.equal(uni.name, "math > handles unicode café 日本語");
  assert.equal(uni.file, "test/math.test.js");
  assert.equal(uni.line, 11);
  assert.match(uni.message, /strictly equal/);
  assert.equal(top.name, "top level broken");
  assert.equal(top.message, "it's broken");
  assert.equal(top.line, 5);
});

test("tap: CRLF, TODO directive, plain tap without YAML, and a parent with its own error", () => {
  const plain = "TAP version 13\r\nok 1 - a\r\nnot ok 2 - b\r\nnot ok 3 - c # TODO later\r\nok 4 - d # SKIP\r\n1..4\r\n";
  const r = parseTap(plain);
  assert.equal(r.summary.total, 4);
  assert.equal(r.summary.failed, 1);
  assert.equal(r.summary.skipped, 2);
  assert.equal(r.failures[0].name, "b");
  assert.equal(r.failures[0].message, "(no message)");

  const own = [
    "    not ok 1 - child",
    "      ---",
    "      error: 'child failed'",
    "      ...",
    "not ok 1 - suite",
    "  ---",
    "  failureType: 'hookFailed'",
    "  error: 'after hook broke'",
    "  ...",
  ].join("\n");
  const r2 = parseTap(own);
  assert.equal(r2.failures.length, 1);
  assert.equal(r2.failures[0].message, "after hook broke");
  assert.equal(parseTap("").summary.total, 0);
});

test("tap: expected and actual are appended when not already in the message", () => {
  const r = parseTap("not ok 1 - x\n  ---\n  error: 'bad'\n  expected: 2\n  actual: 1\n  ...\n");
  assert.match(r.failures[0].message, /expected: 2/);
  assert.match(r.failures[0].message, /actual: 1/);
});

test("go json: leaf counting, parents skipped, panic, build failure, unicode", () => {
  const r = parseGoJson(fixture("go-test.jsonl"), opts);
  assert.deepEqual(
    { total: r.summary.total, passed: r.summary.passed, failed: r.summary.failed, errors: r.summary.errors, skipped: r.summary.skipped },
    { total: 6, passed: 2, failed: 2, errors: 1, skipped: 1 },
  );
  assert.equal(r.summary.durationMs, 250);
  const [tbl, panic, build] = r.failures;
  assert.equal(tbl.name, "TestTable/café (example.com/proj/calc)");
  assert.equal(tbl.file, "calc_test.go");
  assert.equal(tbl.line, 27);
  assert.match(tbl.message, /got 3, want 4/);
  assert.ok(!tbl.message.includes("--- FAIL"));
  assert.match(panic.message, /panic: boom/);
  assert.equal(panic.file, "calc/calc_test.go");
  assert.equal(panic.line, 40);
  assert.equal(build.kind, "error");
  assert.match(build.message, /undefined: nope/);
});

test("go json: tolerates CRLF, non-JSON build output and empty input", () => {
  const text = "# pkg\r\nx/a.go:3:1: syntax error\r\n";
  const r = parseGoJson(text);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].kind, "error");
  assert.equal(parseGoJson("").summary.total, 0);
  const lines = fixture("go-test.jsonl").replace(/\n/g, "\r\n");
  assert.equal(parseGoJson(lines, opts).failures.length, 3);
});

test("detectFormat recognises each format", () => {
  assert.equal(detectFormat(fixture("vitest-junit.xml")), "junit");
  assert.equal(detectFormat(fixture("jest.json")), "jest-json");
  assert.equal(detectFormat(fixture("mocha.json")), "mocha-json");
  assert.equal(detectFormat(fixture("node-tap.txt")), "tap");
  assert.equal(detectFormat(fixture("go-test.jsonl")), "go-json");
  assert.equal(detectFormat("﻿<testsuite/>"), "junit");
  assert.equal(detectFormat("hello"), null);
  assert.equal(detectFormat("{not json"), null);
  assert.equal(detectFormat('{"a":1}'), null);
});

test("parseByFormat dispatches and rejects unknown formats", () => {
  assert.equal(parseByFormat("junit", "<testsuite/>").format, "junit");
  assert.equal(parseByFormat("tap", "").format, "tap");
  assert.throws(() => parseByFormat("nope", ""), /Unknown format/);
});

test("buildFailure falls back to message-only frames and known file", () => {
  const f = buildFailure({ name: "n", message: "Err\n    at x (src/a.js:4:1)", file: "src/a.js" });
  assert.equal(f.line, 4);
  assert.deepEqual(f.stack, ["at x (src/a.js:4:1)"]);
  const g = buildFailure({ name: "n", text: "", file: "src/b.js" });
  assert.equal(g.file, "src/b.js");
  assert.equal(g.line, undefined);
});
