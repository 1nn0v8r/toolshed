// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { detectRunners } from "../../modules/test-report/detect.js";
import { tmpDir, write } from "./helpers.js";

/** @param {string} dir */
const names = (dir) => detectRunners(dir, dir).map((d) => d.runner);

test("empty directory detects nothing", (t) => {
  assert.deepEqual(names(tmpDir(t)), []);
});

test("vitest, jest and mocha from devDependencies", (t) => {
  const d = tmpDir(t);
  write(d, "package.json", JSON.stringify({ devDependencies: { vitest: "^1", jest: "^29", mocha: "^10" } }));
  assert.deepEqual(names(d), ["vitest", "jest", "mocha"]);
  const first = detectRunners(d, d)[0];
  assert.equal(first.confidence, "high");
  assert.match(first.command, /vitest run --reporter=junit/);
  assert.match(first.command, /<report>/);
});

test("runner named only in a script is medium confidence", (t) => {
  const d = tmpDir(t);
  write(d, "package.json", JSON.stringify({ scripts: { test: "vitest run", other: "mocha x" } }));
  const r = detectRunners(d, d);
  assert.deepEqual(r.map((x) => x.runner), ["vitest", "mocha"]);
  assert.ok(r.every((x) => x.confidence === "medium"));
});

test("config files and package.json jest key", (t) => {
  const d = tmpDir(t);
  write(d, "package.json", JSON.stringify({ jest: { testEnvironment: "node" } }));
  write(d, "vitest.config.ts", "export default {}");
  write(d, ".mocharc.json", "{}");
  assert.deepEqual(names(d).sort(), ["jest", "mocha", "vitest"]);
});

test("node --test in the test script", (t) => {
  const d = tmpDir(t);
  write(d, "package.json", JSON.stringify({ scripts: { test: "node --test test/" } }));
  const r = detectRunners(d, d);
  assert.deepEqual(r.map((x) => x.runner), ["node:test"]);
  assert.equal(r[0].confidence, "high");
  assert.match(r[0].command, /--test/);
});

test("node:test falls back to test files when no other runner is found", (t) => {
  const d = tmpDir(t);
  write(d, "package.json", "{}");
  assert.deepEqual(names(d), []);
  write(d, "test/a.test.js", "");
  const r = detectRunners(d, d);
  assert.equal(r[0].runner, "node:test");
  assert.equal(r[0].confidence, "low");
});

test("node:test fallback is skipped when another JS runner exists", (t) => {
  const d = tmpDir(t);
  write(d, "package.json", JSON.stringify({ devDependencies: { jest: "1" } }));
  write(d, "a.test.js", "");
  assert.deepEqual(names(d), ["jest"]);
});

test("pytest from each config source", (t) => {
  const cases = [
    ["pytest.ini", "[pytest]\n"],
    ["pyproject.toml", "[tool.pytest.ini_options]\n"],
    ["setup.cfg", "[tool:pytest]\n"],
    ["tox.ini", "[pytest]\n"],
    ["conftest.py", ""],
    ["tests/conftest.py", ""],
    ["requirements-dev.txt", "pytest>=7\n"],
    ["requirements.txt", "pytest\n"],
    ["pyproject.toml", 'dependencies = ["pytest"]\n'],
  ];
  for (const [file, content] of cases) {
    const d = tmpDir(t);
    write(d, file, content);
    assert.deepEqual(names(d), ["pytest"], file);
  }
});

test("go from go.mod, and several runners at once", (t) => {
  const d = tmpDir(t);
  write(d, "go.mod", "module example.com/x\n\ngo 1.22\n");
  write(d, "pytest.ini", "");
  assert.deepEqual(names(d), ["pytest", "go"]);
  assert.match(detectRunners(d, d).find((x) => x.runner === "go")?.command ?? "", /^go test -json \.\/\.\.\.$/);
});

test("malformed package.json is ignored", (t) => {
  const d = tmpDir(t);
  write(d, "package.json", "{ nope");
  assert.deepEqual(names(d), []);
});
