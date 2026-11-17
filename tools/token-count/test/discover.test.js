// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { discover, isBinaryFile, isSkippedFile, listGitFiles, toPosix, walkFiles } from "../src/discover.js";
import { git, makeRepo, rmDir, tmpDir, writeFiles } from "./helpers.js";

/** @type {string[]} */
const cleanup = [];
after(() => cleanup.forEach(rmDir));

/** @param {string} root @param {string[]} files */
const rel = (root, files) => files.map((f) => toPosix(path.relative(root, f))).sort();

test("toPosix converts separators", () => {
  assert.equal(toPosix(["a", "b", "c.txt"].join(path.sep)), "a/b/c.txt");
});

test("isSkippedFile", () => {
  assert.ok(isSkippedFile("package-lock.json"));
  assert.ok(isSkippedFile("yarn.lock"));
  assert.ok(isSkippedFile("app.js.map"));
  assert.ok(!isSkippedFile("app.js"));
  assert.ok(!isSkippedFile("lock.txt"));
});

test("walkFiles applies default excludes", () => {
  const dir = tmpDir();
  cleanup.push(dir);
  writeFiles(dir, {
    "a.txt": "a",
    "src/b.js": "b",
    "node_modules/x/index.js": "x",
    ".git/config": "x",
    "dist/out.js": "x",
    "build/out.js": "x",
    "coverage/lcov.info": "x",
    "yarn.lock": "x",
    "pnpm-lock.yaml": "x",
    "src/b.js.map": "x",
    "nested/node_modules/y.js": "x",
  });
  assert.deepEqual(rel(dir, walkFiles(dir)), ["a.txt", "src/b.js"]);
});

test("walkFiles on a missing directory returns nothing", () => {
  assert.deepEqual(walkFiles(path.join(tmpDir(), "does-not-exist")), []);
});

test("isBinaryFile detects NUL in first 8KB only", () => {
  const dir = tmpDir();
  cleanup.push(dir);
  writeFiles(dir, {
    "text.txt": "hello",
    "bin.dat": Buffer.from([1, 2, 0, 3]),
    "late.txt": Buffer.concat([Buffer.alloc(9000, 97), Buffer.from([0])]),
    "empty.txt": "",
  });
  assert.equal(isBinaryFile(path.join(dir, "text.txt")), false);
  assert.equal(isBinaryFile(path.join(dir, "bin.dat")), true);
  assert.equal(isBinaryFile(path.join(dir, "late.txt")), false);
  assert.equal(isBinaryFile(path.join(dir, "empty.txt")), false);
});

test("listGitFiles returns tracked and untracked, honors .gitignore, skips deleted", async () => {
  const repo = makeRepo({ "tracked.txt": "t", "gone.txt": "g", ".gitignore": "ignored.txt\n", "sub/in.txt": "i" });
  cleanup.push(repo);
  fs.unlinkSync(path.join(repo, "gone.txt"));
  writeFiles(repo, { "untracked.txt": "u", "ignored.txt": "x" });
  const files = await listGitFiles(repo);
  assert.deepEqual(rel(repo, files ?? []), [".gitignore", "sub/in.txt", "tracked.txt", "untracked.txt"]);
});

test("git repo discovery keeps tracked lockfiles (git decides, not the default excludes)", async () => {
  const repo = makeRepo({ "a.txt": "a", "package-lock.json": "{}" });
  cleanup.push(repo);
  const { files } = await discover([], repo);
  assert.deepEqual(rel(repo, files), ["a.txt", "package-lock.json"]);
});

test("listGitFiles scopes to a subdirectory", async () => {
  const repo = makeRepo({ "a.txt": "a", "sub/b.txt": "b" });
  cleanup.push(repo);
  const files = await listGitFiles(path.join(repo, "sub"));
  assert.deepEqual(rel(repo, files ?? []), ["sub/b.txt"]);
});

test("listGitFiles returns null outside git", async () => {
  const dir = tmpDir();
  cleanup.push(dir);
  assert.equal(await listGitFiles(dir), null);
});

test("listGitFiles returns null when git is missing from PATH", async () => {
  const dir = tmpDir();
  cleanup.push(dir);
  const saved = process.env.PATH;
  process.env.PATH = dir;
  try {
    assert.equal(await listGitFiles(dir), null);
    writeFiles(dir, { "a.txt": "a" });
    const { files } = await discover([], dir);
    assert.deepEqual(rel(dir, files), ["a.txt"]);
  } finally {
    process.env.PATH = saved;
  }
});

test("discover falls back to walking outside git, with excludes", async () => {
  const dir = tmpDir();
  cleanup.push(dir);
  writeFiles(dir, { "a.txt": "a", "node_modules/x.js": "x", "package-lock.json": "{}" });
  const { root, files, missing } = await discover([], dir);
  assert.equal(root, dir);
  assert.deepEqual(rel(dir, files), ["a.txt"]);
  assert.deepEqual(missing, []);
});

test("discover with one directory argument uses it as root", async () => {
  const repo = makeRepo({ "a.txt": "a", "sub/b.txt": "b" });
  cleanup.push(repo);
  const r = await discover(["sub"], repo);
  assert.equal(r.root, path.join(repo, "sub"));
  assert.deepEqual(rel(r.root, r.files), ["b.txt"]);
});

test("discover with files and dirs keeps cwd as root and dedupes", async () => {
  const repo = makeRepo({ "a.txt": "a", "sub/b.txt": "b" });
  cleanup.push(repo);
  const r = await discover(["sub", "sub/b.txt", "a.txt"], repo);
  assert.equal(r.root, repo);
  assert.deepEqual(rel(repo, r.files), ["a.txt", "sub/b.txt"]);
});

test("discover reports missing paths", async () => {
  const dir = tmpDir();
  cleanup.push(dir);
  const r = await discover(["nope.txt"], dir);
  assert.deepEqual(r.missing, ["nope.txt"]);
  assert.deepEqual(r.files, []);
});

test("an explicit file inside an excluded folder is still counted", async () => {
  const dir = tmpDir();
  cleanup.push(dir);
  writeFiles(dir, { "dist/out.js": "x" });
  const r = await discover(["dist/out.js"], dir);
  assert.equal(r.files.length, 1);
});

test("git ls-files is used inside a repo even when a file was added later", async () => {
  const repo = makeRepo({ "a.txt": "a" });
  cleanup.push(repo);
  writeFiles(repo, { "new.txt": "n" });
  git(repo, ["add", "new.txt"]);
  const r = await discover([], repo);
  assert.deepEqual(rel(repo, r.files), ["a.txt", "new.txt"]);
});
