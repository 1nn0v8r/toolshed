// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BANNED, fixture, makeNodeProject, SERVER, tmpDir, write } from "./helpers.js";

/**
 * Start the real server over stdio.
 * @param {import("node:test").TestContext} t
 * @param {{env?: Record<string, string>, cwd?: string}} [o]
 */
async function connect(t, o = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: o.env ?? {},
    cwd: o.cwd,
    stderr: "pipe",
  });
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });
  /**
   * @param {string} name
   * @param {Record<string, unknown>} [args]
   */
  const call = async (name, args = {}) => {
    const res = /** @type {{content: {type: string, text: string}[], isError?: boolean}} */ (await client.callTool({ name, arguments: args }));
    const text = res.content.map((c) => c.text).join("\n");
    for (const ch of BANNED) assert.ok(!text.includes(ch), "tool output has banned punctuation");
    assert.ok(!text.includes("\u001b"), "tool output has ANSI codes");
    return { text, isError: Boolean(res.isError) };
  };
  return { client, call };
}

test("lists the four tools with schemas", async (t) => {
  const root = tmpDir(t);
  const { client } = await connect(t, { env: { REPO_ROOT: root } });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), ["detect_test_runner", "list_failures_from_last_run", "parse_report", "run_tests"]);
  for (const tool of tools) {
    assert.ok(tool.description);
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.inputSchema.properties && "cwd" in tool.inputSchema.properties, `${tool.name} accepts cwd`);
  }
});

test("detect_test_runner reports the runner and command", async (t) => {
  const root = tmpDir(t);
  makeNodeProject(root);
  const { call } = await connect(t, { env: { REPO_ROOT: root } });
  const r = await call("detect_test_runner");
  assert.equal(r.isError, false);
  assert.match(r.text, /1\. node:test \(high, package\.json test script\) \[default\]/);
  assert.match(r.text, /command: node --test/);
  assert.ok(!r.text.includes(root), "must not leak the absolute root");
});

test("detect_test_runner with nothing found and in a subdirectory via cwd", async (t) => {
  const root = tmpDir(t);
  write(root, "web/package.json", JSON.stringify({ devDependencies: { vitest: "1" } }));
  const { call } = await connect(t, { env: { REPO_ROOT: root } });
  assert.match((await call("detect_test_runner")).text, /No test runner detected in \./);
  assert.match((await call("detect_test_runner", { cwd: "web" })).text, /1\. vitest/);
});

test("run_tests: one passing and one failing test via real node --test", async (t) => {
  const root = tmpDir(t);
  makeNodeProject(root);
  const { call } = await connect(t, { env: { REPO_ROOT: root } });
  const r = await call("run_tests");
  assert.equal(r.isError, false);
  assert.match(r.text, /Summary: 3 tests, 1 passed, 1 failed, 1 skipped/);
  assert.match(r.text, /Failures \(1\):/);
  assert.match(r.text, /1\) math > subtracts wrongly/);
  assert.match(r.text, /at test[\\/]sample\.test\.js:5/);
  assert.match(r.text, /5/);
  assert.ok(!r.text.includes(root), "must not leak the absolute root");
  assert.ok(r.text.length < 3000, "output stays compact");
});

test("run_tests honours runner, filter and files", async (t) => {
  const root = tmpDir(t);
  makeNodeProject(root);
  write(root, "test/extra.test.js", "import test from 'node:test';\ntest('extra ok', () => {});\n");
  const { call } = await connect(t, { env: { REPO_ROOT: root } });
  const filtered = await call("run_tests", { runner: "node:test", filter: "adds" });
  assert.match(filtered.text, /All tests passed\./);
  const files = await call("run_tests", { files: ["test/extra.test.js"] });
  assert.match(files.text, /All tests passed\./);
  assert.match(files.text, /Summary: 1 tests/);
});

test("list_failures_from_last_run returns the cache without re-running", async (t) => {
  const root = tmpDir(t);
  makeNodeProject(root);
  const { call } = await connect(t, { env: { REPO_ROOT: root } });
  assert.match((await call("list_failures_from_last_run")).text, /No run_tests has been executed/);
  const ran = await call("run_tests");
  // Break the project: a re-run would now give a different answer than the cache.
  fs.rmSync(path.join(root, "test"), { recursive: true });
  const cached = await call("list_failures_from_last_run");
  assert.match(cached.text, /Cached result of the last run \(node:test,/);
  assert.ok(cached.text.endsWith(ran.text));
});

test("parse_report parses each format, with and without an explicit format", async (t) => {
  const root = tmpDir(t);
  write(root, "reports/vitest.xml", fixture("vitest-junit.xml"));
  write(root, "reports/jest.json", fixture("jest.json"));
  write(root, "reports/node.tap", fixture("node-tap.txt"));
  write(root, "reports/go.jsonl", fixture("go-test.jsonl"));
  write(root, "reports/mocha.json", fixture("mocha.json"));
  write(root, "reports/pytest.xml", fixture("pytest-junit.xml"));
  const { call } = await connect(t, { env: { REPO_ROOT: root } });
  assert.match((await call("parse_report", { path: "reports/vitest.xml" })).text, /6 tests, 2 passed, 2 failed, 1 errors, 1 skipped/);
  assert.match((await call("parse_report", { path: "reports/pytest.xml", format: "junit" })).text, /tests\.test_calc\.TestDivide > test_by_zero/);
  assert.match((await call("parse_report", { path: "reports/jest.json", format: "jest-json" })).text, /applies discount/);
  assert.match((await call("parse_report", { path: "node.tap", cwd: "reports" })).text, /5 tests, 2 passed, 2 failed, 1 skipped/);
  assert.match((await call("parse_report", { path: "reports/go.jsonl", format: "go-json" })).text, /TestTable\/caf/);
  assert.match((await call("parse_report", { path: "reports/mocha.json" })).text, /Validator rejects bad input/);
});

test("parse_report errors: missing, directory, undetectable, bad format, unparsable, missing path", async (t) => {
  const root = tmpDir(t);
  write(root, "plain.txt", "hello");
  write(root, "bad.json", "{ nope");
  fs.mkdirSync(path.join(root, "dir"));
  const { call } = await connect(t, { env: { REPO_ROOT: root } });
  assert.match((await call("parse_report", { path: "nope.xml" })).text, /Report not found/);
  assert.match((await call("parse_report", { path: "dir" })).text, /Not a file/);
  assert.match((await call("parse_report", { path: "plain.txt" })).text, /Could not detect/);
  assert.match((await call("parse_report", { path: "plain.txt", format: "bogus" })).text, /Unknown format/);
  const bad = await call("parse_report", { path: "bad.json", format: "jest-json" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Could not parse/);
  const missing = await call("parse_report", {});
  assert.equal(missing.isError, true);
  assert.match(missing.text, /path is required/);
});

test("path escapes are rejected by every tool", async (t) => {
  const root = tmpDir(t);
  makeNodeProject(root);
  const outside = tmpDir(t);
  write(outside, "report.xml", fixture("vitest-junit.xml"));
  const { call } = await connect(t, { env: { REPO_ROOT: root } });
  for (const tool of ["detect_test_runner", "run_tests", "list_failures_from_last_run"]) {
    for (const cwd of ["..", "../x", path.dirname(root), outside]) {
      const r = await call(tool, { cwd });
      assert.equal(r.isError, true, `${tool} cwd=${cwd}`);
      assert.match(r.text, /outside repo root/);
    }
  }
  const p1 = await call("parse_report", { path: path.join(outside, "report.xml") });
  assert.equal(p1.isError, true);
  assert.match(p1.text, /outside repo root/);
  const p2 = await call("parse_report", { path: "../report.xml" });
  assert.match(p2.text, /outside repo root/);
  const p3 = await call("parse_report", { path: "report.xml", cwd: ".." });
  assert.match(p3.text, /outside repo root/);
  const f = await call("run_tests", { files: ["../../etc/passwd"] });
  assert.equal(f.isError, true);
  assert.match(f.text, /outside repo root/);
});

test("run_tests argument validation", async (t) => {
  const root = tmpDir(t);
  makeNodeProject(root);
  const { call } = await connect(t, { env: { REPO_ROOT: root } });
  assert.match((await call("run_tests", { runner: "bogus" })).text, /Unknown runner/);
  assert.match((await call("run_tests", { filter: "--inspect" })).text, /must not start with/);
  assert.match((await call("run_tests", { files: "a.js" })).text, /files must be an array/);
  assert.match((await call("run_tests", { files: [""] })).text, /non-empty strings/);
  assert.match((await call("run_tests", { timeoutMs: -5 })).text, /positive number/);
  assert.match((await call("run_tests", { timeoutMs: "abc" })).text, /positive number/);
  const none = tmpDir(t);
  const second = await connect(t, { env: { REPO_ROOT: none } });
  const r = await second.call("run_tests");
  assert.equal(r.isError, true);
  assert.match(r.text, /No test runner detected/);
  const unknown = await second.client.callTool({ name: "nope", arguments: {} });
  assert.equal(unknown.isError, true);
});

test("run_tests: timeout is reported and the cache keeps it", async (t) => {
  const root = tmpDir(t);
  write(root, "package.json", JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  write(root, "test/slow.test.js", "import test from 'node:test';\ntest('slow', async () => { await new Promise((r) => setTimeout(r, 60000)); });\n");
  const { call } = await connect(t, { env: { REPO_ROOT: root } });
  const started = Date.now();
  const r = await call("run_tests", { timeoutMs: 1500 });
  assert.ok(Date.now() - started < 30000);
  assert.match(r.text, /Timed out after 1500 ms/);
  assert.match((await call("list_failures_from_last_run")).text, /Timed out/);
});

test("run_tests: runner binary missing gives a clear error", async (t) => {
  const root = tmpDir(t);
  write(root, "package.json", JSON.stringify({ devDependencies: { vitest: "1" } }));
  const { call } = await connect(t, { env: { REPO_ROOT: root } });
  const r = await call("run_tests");
  assert.equal(r.isError, true);
  assert.match(r.text, /vitest not found in node_modules/);
});

test("root resolution: nearest git root above the launch cwd", async (t) => {
  const root = tmpDir(t);
  fs.mkdirSync(path.join(root, ".git"));
  write(root, "sub/package.json", JSON.stringify({ devDependencies: { mocha: "1" } }));
  fs.mkdirSync(path.join(root, "deep", "er"), { recursive: true });
  const { call, client } = await connect(t, { cwd: path.join(root, "deep", "er") });
  const r = await call("detect_test_runner", { cwd: "sub" });
  assert.equal(r.isError, false);
  assert.match(r.text, /1\. mocha/);
  await client.close();
});

test("root resolution: falls back to the launch cwd when there is no git root", async (t) => {
  const root = tmpDir(t);
  write(root, "package.json", JSON.stringify({ devDependencies: { jest: "1" } }));
  const { call, client } = await connect(t, { cwd: root });
  const r = await call("detect_test_runner");
  assert.match(r.text, /1\. jest/);
  await client.close();
});
