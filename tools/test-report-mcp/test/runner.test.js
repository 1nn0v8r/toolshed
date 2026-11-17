// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildInvocation, execCapture, findNodeBin, nodeSupportsJunit, pythonCandidates, roots, runTests } from "../src/runner.js";
import { hasCommand, installFakeRunner, makeNodeProject, tmpDir, write } from "./helpers.js";

test("findNodeBin resolves the bin entry, walking up, and stops at the root", (t) => {
  const root = tmpDir(t);
  installFakeRunner(root, "vitest", "--outputFile=", "vitest-junit.xml");
  fs.mkdirSync(path.join(root, "pkg", "sub"), { recursive: true });
  const expected = path.join(root, "node_modules", "vitest", "cli.js");
  assert.equal(findNodeBin(path.join(root, "pkg", "sub"), root, "vitest"), expected);
  assert.equal(findNodeBin(root, root, "jest"), null);
  write(root, "node_modules/strbin/package.json", JSON.stringify({ name: "strbin", bin: "run.js" }));
  write(root, "node_modules/strbin/run.js", "");
  assert.equal(findNodeBin(root, root, "strbin"), path.join(root, "node_modules", "strbin", "run.js"));
  write(root, "node_modules/badpkg/package.json", "{ nope");
  assert.equal(findNodeBin(root, root, "badpkg"), null);
});

test("buildInvocation wires each runner's report flags, filter and files", (t) => {
  const root = tmpDir(t);
  for (const p of ["vitest", "jest", "mocha"]) installFakeRunner(root, p, "x=", "mocha.json");
  const rp = path.join(root, "r.out");
  const f = path.join(root, "test", "a.test.js");
  const base = { root, dir: root, reportPath: rp, filter: "adds", files: [f] };

  const v = buildInvocation("vitest", base);
  assert.deepEqual(v.args.slice(1), ["run", "--reporter=junit", `--outputFile=${rp}`, "--testNamePattern=adds", path.join("test", "a.test.js")]);
  assert.equal(v.format, "junit");
  assert.equal(v.cmd, process.execPath);

  const j = buildInvocation("jest", base);
  assert.deepEqual(j.args.slice(1), ["--json", `--outputFile=${rp}`, "--testNamePattern=adds", path.join("test", "a.test.js")]);
  assert.equal(j.format, "jest-json");

  const m = buildInvocation("mocha", base);
  assert.deepEqual(m.args.slice(1), ["--reporter", "json", "--reporter-option", `output=${rp}`, "--grep=adds", path.join("test", "a.test.js")]);

  const py = buildInvocation("pytest", base);
  assert.deepEqual(py.args, ["-m", "pytest", `--junitxml=${rp}`, "-o", "junit_family=xunit1", "--tb=short", "-k", "adds", path.join("test", "a.test.js")]);
  assert.equal(py.cmd, pythonCandidates()[0]);

  const g = buildInvocation("go", { ...base, files: [path.join(root, "pkg", "x_test.go"), path.join(root, "pkg", "y_test.go"), path.join(root, "z_test.go")] });
  assert.deepEqual(g.args, ["test", "-json", "-run", "adds", "./pkg", "."]);
  assert.deepEqual(buildInvocation("go", { root, dir: root, reportPath: rp }).args, ["test", "-json", "./..."]);

  assert.ok(!v.display.includes(root), "display must not leak the repo root");
  assert.match(v.display, /<report>/);
});

test("buildInvocation: node:test uses junit when supported, TAP otherwise", (t) => {
  const root = tmpDir(t);
  const rp = path.join(root, "r.out");
  const prev = process.env.TEST_REPORT_NODE_REPORTER;
  t.after(() => {
    if (prev === undefined) delete process.env.TEST_REPORT_NODE_REPORTER;
    else process.env.TEST_REPORT_NODE_REPORTER = prev;
  });
  process.env.TEST_REPORT_NODE_REPORTER = "junit";
  assert.equal(nodeSupportsJunit(), true);
  const a = buildInvocation("node:test", { root, dir: root, reportPath: rp, filter: "x" });
  assert.deepEqual(a.args, ["--test-reporter=junit", `--test-reporter-destination=${rp}`, "--test", "--test-name-pattern=x"]);
  assert.equal(a.source, "file");
  process.env.TEST_REPORT_NODE_REPORTER = "tap";
  assert.equal(nodeSupportsJunit(), false);
  const b = buildInvocation("node:test", { root, dir: root, reportPath: rp });
  assert.deepEqual(b.args, ["--test-reporter=tap", "--test"]);
  assert.equal(b.format, "tap");
  assert.equal(b.source, "stdout");
  assert.ok(b.note);
  delete process.env.TEST_REPORT_NODE_REPORTER;
  assert.equal(typeof nodeSupportsJunit(), "boolean");
});

test("buildInvocation errors: missing local runner, unknown runner; dry mode placeholder; leading dash files", (t) => {
  const root = tmpDir(t);
  const rp = path.join(root, "r");
  assert.throws(() => buildInvocation("jest", { root, dir: root, reportPath: rp }), /jest not found in node_modules/);
  assert.throws(() => buildInvocation("nope", { root, dir: root, reportPath: rp }), /Unknown runner/);
  assert.match(buildInvocation("jest", { root, dir: root, reportPath: rp, dry: true }).display, /^jest --json/);
  const inv = buildInvocation("pytest", { root, dir: root, reportPath: rp, files: [path.join(root, "-weird.py")] });
  assert.ok(inv.args.includes(`.${path.sep}-weird.py`));
});

test("roots includes the real path", (t) => {
  const d = tmpDir(t);
  assert.ok(roots(d).includes(d));
  assert.deepEqual(roots(path.join(d, "missing")), [path.join(d, "missing")]);
});

test("execCapture: output, exit code, spawn error, timeout and tree kill", async () => {
  const ok = await execCapture(process.execPath, ["-e", "console.log('out'); console.error('err'); process.exit(3)"], { cwd: process.cwd(), timeoutMs: 20000 });
  assert.equal(ok.code, 3);
  assert.match(ok.stdout, /out/);
  assert.match(ok.stderr, /err/);
  assert.equal(ok.timedOut, false);

  const missing = await execCapture("definitely-not-a-real-binary-xyz", [], { cwd: process.cwd(), timeoutMs: 5000 });
  assert.equal(missing.spawnError?.code, "ENOENT");

  const started = Date.now();
  const slow = await execCapture(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: process.cwd(), timeoutMs: 500 });
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - started < 15000, "timeout must kill the process promptly");
});

test("execCapture removes NODE_TEST_CONTEXT so nested node --test works", async () => {
  const prev = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = "child-v8";
  try {
    const r = await execCapture(process.execPath, ["-p", "String(process.env.NODE_TEST_CONTEXT)"], { cwd: process.cwd(), timeoutMs: 20000 });
    assert.equal(r.stdout.trim(), "undefined");
  } finally {
    if (prev === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = prev;
  }
});

for (const reporter of ["junit", "tap"]) {
  test(`runTests with real node --test (${reporter} reporter path)`, async (t) => {
    const prev = process.env.TEST_REPORT_NODE_REPORTER;
    process.env.TEST_REPORT_NODE_REPORTER = reporter;
    t.after(() => {
      if (prev === undefined) delete process.env.TEST_REPORT_NODE_REPORTER;
      else process.env.TEST_REPORT_NODE_REPORTER = prev;
    });
    const root = tmpDir(t);
    makeNodeProject(root);
    const out = await runTests({ root, dir: root, runner: "node:test", timeoutMs: 60000 });
    assert.ok(out.report, out.crashTail);
    assert.equal(out.report.summary.failed, 1);
    assert.equal(out.report.summary.passed, 1);
    assert.equal(out.report.summary.skipped, 1);
    assert.equal(out.report.failures.length, 1);
    const f = out.report.failures[0];
    assert.match(f.name, /subtracts wrongly/);
    assert.equal(f.file?.replace(/\\/g, "/"), "test/sample.test.js");
    assert.equal(f.line, 5);
    assert.match(f.message, /5/);
    assert.notEqual(out.exitCode, 0);
    assert.ok(!JSON.stringify(out).includes(root.replace(/\\/g, "\\\\")), "no absolute root in output");
  });
}

test("runTests passes filter and files through to node --test", async (t) => {
  const root = tmpDir(t);
  makeNodeProject(root);
  write(root, "test/other.test.js", "import test from 'node:test';\ntest('other ok', () => {});\n");
  const filtered = await runTests({ root, dir: root, runner: "node:test", filter: "^adds$", timeoutMs: 60000 });
  assert.equal(filtered.report?.failures.length, 0);
  assert.ok((filtered.report?.summary.passed ?? 0) >= 1);
  const bad = await runTests({ root, dir: root, runner: "node:test", filter: "subtracts", timeoutMs: 60000 });
  assert.equal(bad.report?.failures.length, 1);
  const files = await runTests({ root, dir: root, runner: "node:test", files: [path.join(root, "test", "other.test.js")], timeoutMs: 60000 });
  assert.equal(files.report?.summary.total, 1);
  assert.equal(files.report?.summary.failed, 0);
});

test("runTests with simulated vitest, jest and mocha binaries (wiring only)", async (t) => {
  const root = tmpDir(t);
  const v = installFakeRunner(root, "vitest", "--outputFile=", "vitest-junit.xml");
  const j = installFakeRunner(root, "jest", "--outputFile=", "jest.json");
  const m = installFakeRunner(root, "mocha", "output=", "mocha.json");
  const rv = await runTests({ root, dir: root, runner: "vitest", filter: "adds", timeoutMs: 30000 });
  assert.equal(rv.report?.failures.length, 3);
  assert.ok(v.argv().includes("--testNamePattern=adds"));
  const rj = await runTests({ root, dir: root, runner: "jest", timeoutMs: 30000 });
  assert.equal(rj.report?.failures.length, 2);
  assert.ok(j.argv().some((/** @type {string} */ a) => a.startsWith("--outputFile=")));
  const rm = await runTests({ root, dir: root, runner: "mocha", timeoutMs: 30000 });
  assert.equal(rm.report?.failures.length, 1);
  assert.ok(m.argv().includes("json"));
});

test("mocha stdout JSON fallback when the runner ignores the output option", async (t) => {
  const root = tmpDir(t);
  write(root, "node_modules/mocha/package.json", JSON.stringify({ name: "mocha", bin: { mocha: "cli.js" } }));
  const json = fs.readFileSync(new URL("./fixtures/mocha.json", import.meta.url), "utf8");
  write(root, "node_modules/mocha/cli.js", `console.log("some log line");\nconsole.log(${JSON.stringify(json)});\nprocess.exit(1);\n`);
  const out = await runTests({ root, dir: root, runner: "mocha", timeoutMs: 30000 });
  assert.equal(out.report?.failures.length, 1);
});

test("runTests: runner crash before a report returns the output tail", async (t) => {
  const root = tmpDir(t);
  write(root, "node_modules/jest/package.json", JSON.stringify({ name: "jest", bin: { jest: "cli.js" } }));
  const noise = Array.from({ length: 100 }, (_, i) => `console.error("line ${i}");`).join("\n");
  write(root, "node_modules/jest/cli.js", `${noise}\nprocess.exit(2);\n`);
  const out = await runTests({ root, dir: root, runner: "jest", timeoutMs: 30000 });
  assert.equal(out.report, undefined);
  assert.equal(out.exitCode, 2);
  assert.match(out.notes.join(" "), /before producing a report/);
  const lines = (out.crashTail ?? "").split("\n");
  assert.equal(lines.length, 60);
  assert.equal(lines[59], "line 99");
});

test("runTests: unparsable report is treated as a crash", async (t) => {
  const root = tmpDir(t);
  write(root, "node_modules/jest/package.json", JSON.stringify({ name: "jest", bin: { jest: "cli.js" } }));
  write(root, "node_modules/jest/cli.js", `require('fs').writeFileSync(process.argv.find(a=>a.startsWith('--outputFile=')).slice(13), 'garbage{'); console.error('oops'); process.exit(1);\n`);
  const out = await runTests({ root, dir: root, runner: "jest", timeoutMs: 30000 });
  assert.equal(out.report, undefined);
  assert.match(out.notes.join(" "), /could not be parsed/);
  assert.match(out.crashTail ?? "", /oops/);
});

test("runTests: timeout kills the run and reports it", async (t) => {
  const root = tmpDir(t);
  write(root, "package.json", JSON.stringify({ type: "module" }));
  write(root, "test/slow.test.js", "import test from 'node:test';\ntest('slow', async () => { console.log('started slow'); await new Promise((r) => setTimeout(r, 60000)); });\n");
  const started = Date.now();
  const out = await runTests({ root, dir: root, runner: "node:test", timeoutMs: 2000 });
  assert.equal(out.timedOut, true);
  assert.equal(out.report, undefined);
  assert.match(out.notes.join(" "), /Timed out after 2000 ms/);
  assert.ok(Date.now() - started < 30000);
});

test("runTests: missing binary reports a spawn error", async (t) => {
  const root = tmpDir(t);
  const prev = process.env.TEST_REPORT_PYTHON;
  process.env.TEST_REPORT_PYTHON = "definitely-not-python-xyz";
  t.after(() => {
    if (prev === undefined) delete process.env.TEST_REPORT_PYTHON;
    else process.env.TEST_REPORT_PYTHON = prev;
  });
  const out = await runTests({ root, dir: root, runner: "pytest", timeoutMs: 10000 });
  assert.equal(out.report, undefined);
  assert.match(out.notes.join(" "), /Could not start/);
});

test("runTests: exit code with an empty report adds a note", async (t) => {
  const root = tmpDir(t);
  write(root, "node_modules/jest/package.json", JSON.stringify({ name: "jest", bin: { jest: "cli.js" } }));
  write(root, "node_modules/jest/cli.js", `require('fs').writeFileSync(process.argv.find(a=>a.startsWith('--outputFile=')).slice(13), '{}'); console.error('no tests found'); process.exit(1);\n`);
  const out = await runTests({ root, dir: root, runner: "jest", timeoutMs: 30000 });
  assert.ok(out.report);
  assert.match(out.notes.join(" "), /reported no tests/);
  assert.match(out.crashTail ?? "", /no tests found/);
});

test("runTests: nonzero exit with a clean report adds a note", async (t) => {
  const root = tmpDir(t);
  write(root, "node_modules/jest/package.json", JSON.stringify({ name: "jest", bin: { jest: "cli.js" } }));
  write(root, "node_modules/jest/cli.js", `require('fs').writeFileSync(process.argv.find(a=>a.startsWith('--outputFile=')).slice(13), JSON.stringify({numTotalTests:1,numPassedTests:1,testResults:[]})); process.exit(1);\n`);
  const out = await runTests({ root, dir: root, runner: "jest", timeoutMs: 30000 });
  assert.match(out.notes.join(" "), /lists no failures/);
});

const havePytest = hasCommand(pythonCandidates()[0], ["-m", "pytest", "--version"]);
test("live pytest (skipped when python with pytest is unavailable)", { skip: !havePytest && "pytest not installed" }, async (t) => {
  const root = tmpDir(t);
  write(root, "pytest.ini", "[pytest]\n");
  write(root, "tests/test_a.py", "def test_ok():\n    assert 1 + 1 == 2\n\n\ndef test_bad():\n    assert 1 + 1 == 3\n");
  const out = await runTests({ root, dir: root, runner: "pytest", timeoutMs: 120000 });
  assert.ok(out.report, out.crashTail);
  assert.equal(out.report.summary.failed, 1);
  assert.equal(out.report.summary.passed, 1);
  assert.match(out.report.failures[0].name, /test_bad/);
  assert.equal(out.report.failures[0].file?.replace(/\\/g, "/"), "tests/test_a.py");
  assert.equal(out.report.failures[0].line, 6);
});

const haveGo = hasCommand("go", ["version"]);
test("live go test (skipped when go is unavailable)", { skip: !haveGo && "go not installed" }, async (t) => {
  const root = tmpDir(t);
  write(root, "go.mod", "module example.com/fx\n\ngo 1.20\n");
  write(root, "a_test.go", 'package fx\n\nimport "testing"\n\nfunc TestOK(t *testing.T) {}\n\nfunc TestBad(t *testing.T) {\n\tt.Errorf("got %d, want %d", 1, 2)\n}\n');
  const out = await runTests({ root, dir: root, runner: "go", timeoutMs: 120000 });
  assert.ok(out.report, out.crashTail);
  assert.equal(out.report.summary.failed, 1);
  assert.equal(out.report.summary.passed, 1);
  assert.match(out.report.failures[0].name, /TestBad/);
  assert.equal(out.report.failures[0].line, 8);
});
