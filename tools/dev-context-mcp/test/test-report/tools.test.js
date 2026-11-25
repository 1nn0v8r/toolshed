// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_DEFINITIONS, handleTool } from "../../modules/test-report/tools.js";
import { fixture, makeNodeProject, tmpDir, write } from "./helpers.js";

/** @param {string} root @returns {import("../../modules/test-report/tools.js").Session} */
const session = (root) => ({ root, last: null });

test("tool definitions are well formed", () => {
  const names = TOOL_DEFINITIONS.map((d) => d.name);
  assert.equal(new Set(names).size, names.length);
  for (const d of TOOL_DEFINITIONS) assert.equal(d.inputSchema.type, "object");
});

test("handleTool: unknown tool and escaping cwd are errors, never throws", async (t) => {
  const s = session(tmpDir(t));
  const a = await handleTool(s, "nope", {});
  assert.equal(a.isError, true);
  const b = await handleTool(s, "detect_test_runner", { cwd: "../.." });
  assert.equal(b.isError, true);
  assert.match(b.content[0].text, /outside repo root/);
});

test("handleTool: run_tests caches the last run, results contain no ANSI", async (t) => {
  const root = tmpDir(t);
  makeNodeProject(root);
  const s = session(root);
  assert.match((await handleTool(s, "list_failures_from_last_run", {})).content[0].text, /No run_tests/);
  const r = await handleTool(s, "run_tests", { runner: "node:test", timeoutMs: 60000 });
  assert.match(r.content[0].text, /subtracts wrongly/);
  assert.ok(s.last);
  assert.equal(s.last.runner, "node:test");
  assert.ok(!r.content[0].text.includes("\u001b"));
});

test("handleTool: timeoutMs above the maximum is clamped, not rejected", async (t) => {
  const root = tmpDir(t);
  makeNodeProject(root);
  const r = await handleTool(session(root), "run_tests", { timeoutMs: 99999999, filter: "^adds$" });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /Summary:/);
});

test("handleTool: parse_report on a CRLF junit file", async (t) => {
  const root = tmpDir(t);
  write(root, "r.xml", fixture("vitest-junit.xml").replace(/\n/g, "\r\n"));
  const r = await handleTool(session(root), "parse_report", { path: "r.xml" });
  assert.match(r.content[0].text, /Failures \(3\):/);
  assert.ok(!r.content[0].text.includes("\r"));
});

test("handleTool: an oversized report is refused", async (t) => {
  const root = tmpDir(t);
  const p = write(root, "big.xml", "");
  const fs = await import("node:fs");
  fs.truncateSync(p, 51 * 1024 * 1024);
  const r = await handleTool(session(root), "parse_report", { path: "big.xml" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /too large/);
});
