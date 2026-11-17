// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { formatFailure, formatReport } from "../src/format.js";
import { parseJunit } from "../src/parsers.js";
import { BANNED, fixture } from "./helpers.js";

/** @returns {import("../src/parsers.js").Failure} */
const mk = (/** @type {number} */ i, msgLines = 3) => ({
  name: `suite > test ${i}`,
  kind: "failure",
  file: "test/a.test.js",
  line: i,
  message: Array.from({ length: msgLines }, (_, n) => `message line ${n} of failure ${i}`).join("\n"),
  stack: ["at f (src/a.js:1:1)"],
});

/** @param {import("../src/parsers.js").Failure[]} failures */
const report = (failures) => ({
  format: "junit",
  summary: { total: failures.length + 2, passed: 2, failed: failures.length, errors: 0, skipped: 0, durationMs: 1500 },
  failures,
});

test("all-passing report", () => {
  const out = formatReport({ format: "x", summary: { total: 3, passed: 3, failed: 0, errors: 0, skipped: 0, durationMs: 40 }, failures: [] }, { runner: "node:test", command: "node --test" });
  assert.match(out, /^Runner: node:test\nCommand: node --test\nSummary: 3 tests, 3 passed, 0 failed, 0 skipped \(40ms\)/);
  assert.match(out, /All tests passed\./);
});

test("failed count with no details says so", () => {
  const out = formatReport({ format: "x", summary: { total: 1, passed: 0, failed: 1, errors: 0, skipped: 0 }, failures: [] });
  assert.match(out, /No failure details were found/);
});

test("formats failures with location, message and stack, plus errors count and notes", () => {
  const r = report([mk(1)]);
  r.summary.errors = 1;
  const out = formatReport(r, { notes: ["something"] });
  assert.match(out, /1 failed, 1 errors/);
  assert.match(out, /Note: something/);
  assert.match(out, /1\) suite > test 1\n   at test\/a\.test\.js:1\n   message line 0/);
  assert.match(out, /stack:\n {5}at f \(src\/a\.js:1:1\)/);
});

test("message is capped at 20 lines", () => {
  const out = formatFailure(mk(1, 50), 1);
  assert.match(out, /message line 19 of/);
  assert.ok(!out.includes("message line 20 of"));
  assert.match(out, /\(30 more message lines\)/);
});

test("very long lines are clipped", () => {
  const f = mk(1);
  f.message = "x".repeat(2000);
  assert.ok(formatFailure(f, 1).length < 900);
});

test("total output is capped near 12000 chars and omitted failures are counted", () => {
  const failures = Array.from({ length: 200 }, (_, i) => mk(i + 1, 20));
  const out = formatReport(report(failures));
  assert.ok(out.length <= 12000, `length ${out.length}`);
  const m = /\.\.\. (\d+) more failures omitted/.exec(out);
  assert.ok(m, "omitted note present");
  const shown = (out.match(/^\d+\) /gm) ?? []).length;
  assert.equal(shown + Number(m[1]), 200);
});

test("a single huge failure is still shown, clipped", () => {
  const f = mk(1);
  f.message = Array.from({ length: 20 }, () => "y".repeat(390)).join("\n");
  const out = formatReport(report([f]), { maxChars: 1500 });
  assert.ok(out.length <= 1700);
  assert.match(out, /1\) suite/);
});

test("singular omitted wording and custom cap", () => {
  const out = formatReport(report([mk(1, 20), mk(2, 20)]), { maxChars: 700 });
  assert.match(out, /\.\.\. 1 more failure omitted/);
});

test("output contains no ANSI codes and none of the banned punctuation", () => {
  const f = mk(1);
  f.message = "\u001b[31mred\u001b[0m";
  const out = formatReport(report([f]), { runner: "r" }) + formatReport(parseJunit(fixture("vitest-junit.xml")));
  assert.ok(!out.includes("\u001b"));
  for (const ch of BANNED) assert.ok(!out.includes(ch), `contains U+${ch.codePointAt(0)?.toString(16)}`);
});
