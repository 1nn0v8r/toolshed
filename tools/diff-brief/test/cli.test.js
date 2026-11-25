// @ts-check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run } from "../src/main.js";

/**
 * Create a temporary git repository with initial commit on main.
 *
 * @returns {string}
 */
function initTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-brief-test-"));
  const git = (/** @type {string[]} */ args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);

  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  fs.writeFileSync(path.join(dir, "test", "math.test.js"), "import assert from 'node:assert';\nassert.equal(1 + 1, 2);\n");

  git(["add", "."]);
  git(["commit", "-m", "initial commit"]);
  return dir;
}

/**
 * Helper to run CLI in memory and capture stdout/stderr.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, stdinText?: string }} [opts]
 */
async function invokeCli(argv, opts = {}) {
  let out = "";
  let err = "";
  const code = await run(argv, {
    cwd: opts.cwd,
    stdinText: opts.stdinText,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    }
  });
  return { code, out, err };
}

test("help and version flags exit 0", async () => {
  const help = await invokeCli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /diff-brief: summarize sprawling git diffs/);

  const ver = await invokeCli(["--version"]);
  assert.equal(ver.code, 0);
  assert.match(ver.out.trim(), /^\d+\.\d+\.\d+$/);
});

test("supports --staged, --unstaged, --base, and --commit in a git repo", async () => {
  const dir = initTempRepo();
  try {
    const git = (/** @type {string[]} */ args) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" });

    git(["checkout", "-b", "feat/calc"]);
    fs.writeFileSync(
      path.join(dir, "src", "math.js"),
      "export function add(a, b) {\n  return a + b;\n}\nexport function mul(a, b) {\n  return a * b;\n}\n"
    );
    git(["add", "src/math.js"]);

    // Staged check
    const staged = await invokeCli(["--staged", "--format", "json"], { cwd: dir });
    assert.equal(staged.code, 0);
    const stagedJson = JSON.parse(staged.out);
    assert.equal(stagedJson.scope, "staged changes (--cached)");
    assert.equal(stagedJson.files[0].path, "src/math.js");
    assert.ok(stagedJson.files[0].symbols.includes("mul"));

    // Unstaged check after editing test file
    fs.writeFileSync(
      path.join(dir, "test", "math.test.js"),
      "import assert from 'node:assert';\nassert.equal(2 * 3, 6);\n"
    );
    const unstaged = await invokeCli(["--unstaged", "--format", "json"], { cwd: dir });
    assert.equal(unstaged.code, 0);
    const unstagedJson = JSON.parse(unstaged.out);
    assert.equal(unstagedJson.files.length, 1);
    assert.equal(unstagedJson.files[0].path, "test/math.test.js");

    // Commit and test --base main and auto-detection
    git(["add", "."]);
    git(["commit", "-m", "feat: add mul"]);

    const autoRes = await invokeCli(["--format", "md"], { cwd: dir });
    assert.equal(autoRes.code, 0);
    assert.match(autoRes.out, /main\.\.\.HEAD/);
    assert.match(autoRes.out, /`src\/math\.js`/);

    const commitRes = await invokeCli(["--commit", "HEAD", "--format", "json"], { cwd: dir });
    assert.equal(commitRes.code, 0);
    const commitJson = JSON.parse(commitRes.out);
    assert.equal(commitJson.commits.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("enforces --fail-on, --fail-on-flag, and .diffbriefrc.json", async () => {
  const dir = initTempRepo();
  try {
    fs.writeFileSync(
      path.join(dir, ".diffbriefrc.json"),
      JSON.stringify({ ignoreFlags: ["todo-added"] })
    );
    const patchPath = path.join(dir, "sample.patch");
    fs.writeFileSync(
      patchPath,
      [
        "diff --git a/src/login.ts b/src/login.ts",
        "--- a/src/login.ts",
        "+++ b/src/login.ts",
        "@@ -1,1 +1,4 @@",
        "+// TODO: clean up later",
        "+export function login() { return true; }",
        "diff --git a/test/login.test.ts b/test/login.test.ts",
        "--- a/test/login.test.ts",
        "+++ b/test/login.test.ts",
        "@@ -1,1 +1,2 @@",
        "+it.skip('works', () => {});"
      ].join("\n")
    );

    // todo-added is ignored via .diffbriefrc.json, test-skip triggers high risk
    const res = await invokeCli(
      ["--diff-file", "sample.patch", "--fail-on", "high", "--format", "json"],
      { cwd: dir }
    );
    assert.equal(res.code, 1);
    const parsed = JSON.parse(res.out);
    assert.ok(!parsed.flags.some((/** @type {{ id: string }} */ f) => f.id === "todo-added"));
    assert.ok(parsed.flags.some((/** @type {{ id: string }} */ f) => f.id === "test-skip"));

    const flagRes = await invokeCli(
      ["--stdin", "--fail-on-flag", "test-skip"],
      { cwd: dir, stdinText: fs.readFileSync(patchPath, "utf8") }
    );
    assert.equal(flagRes.code, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("returns exit code 2 on invalid arguments or missing diff file", async () => {
  const badFormat = await invokeCli(["--stdin", "--format", "xml"], { stdinText: "" });
  assert.equal(badFormat.code, 2);
  assert.match(badFormat.err, /Unsupported --format/);

  const missingFile = await invokeCli(["--diff-file", "does-not-exist.patch"]);
  assert.equal(missingFile.code, 2);
  assert.match(missingFile.err, /Diff file not found/);

  const conflict = await invokeCli(["--staged", "--unstaged"]);
  assert.equal(conflict.code, 2);
  assert.match(conflict.err, /Conflicting mode options/);
});
