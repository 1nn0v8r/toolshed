// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  isDefaultExcludedFile,
  isEnvFile,
  listFiles,
  listGitFiles,
  walkFiles,
} from "../src/discover.js";
import { initRepo, put, rmDir, tmpDir } from "./helpers.js";

test("isEnvFile", () => {
  for (const p of [".env", "a/.env", ".env.local", ".ENV", ".envrc", "x/.env.production"]) {
    assert.equal(isEnvFile(p), true, p);
  }
  for (const p of ["env.js", "environment.ts", "src/.environment/readme"]) {
    assert.equal(isEnvFile(p), false, p);
  }
});

test("isDefaultExcludedFile", () => {
  for (const p of ["package-lock.json", "a/yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "x.js.map", "debug.log", "go.sum"]) {
    assert.equal(isDefaultExcludedFile(p), true, p);
  }
  for (const p of ["package.json", "src/a.js", "lock.js", "log.txt"]) {
    assert.equal(isDefaultExcludedFile(p), false, p);
  }
});

test("walkFiles skips default folders and returns sorted forward-slash paths", async () => {
  const d = tmpDir();
  try {
    put(d, "b.js", "b");
    put(d, "a.js", "a");
    put(d, "src/deep/x.js", "x");
    for (const dir of ["node_modules", ".git", "dist", "build", "coverage"]) put(d, `${dir}/f.js`, "no");
    put(d, "src/node_modules/y.js", "no");
    assert.deepEqual(await walkFiles(d, true), ["a.js", "b.js", "src/deep/x.js"]);
    const all = await walkFiles(d, false);
    assert.ok(all.includes("node_modules/f.js"));
    assert.ok(all.includes("src/node_modules/y.js"));
    assert.ok(all.every((p) => !p.includes("\\")));
  } finally {
    rmDir(d);
  }
});

test("walkFiles on a missing folder returns nothing", async () => {
  assert.deepEqual(await walkFiles(path.join(tmpDir(), "does-not-exist"), true), []);
});

test("listGitFiles: null outside a repo, respects .gitignore inside", async () => {
  const plain = tmpDir();
  const repo = tmpDir();
  try {
    put(plain, "a.js", "a");
    // A temp folder is normally outside any repo. If the machine's temp dir is
    // inside one, this assertion cannot hold, so check it first.
    const outside = await listGitFiles(plain);
    if (outside !== null) return;
    assert.equal(outside, null);

    put(repo, ".gitignore", "ignored.js\nout/\n");
    put(repo, "tracked.js", "t");
    put(repo, "ignored.js", "i");
    put(repo, "out/o.js", "o");
    initRepo(repo);
    put(repo, "untracked.js", "u");
    put(repo, "with space/é.js", "u");
    const files = await listGitFiles(repo);
    assert.ok(files);
    assert.deepEqual([...files].sort(), [".gitignore", "tracked.js", "untracked.js", "with space/é.js"].sort());
  } finally {
    rmDir(plain);
    rmDir(repo);
  }
});

test("listGitFiles from a subfolder lists paths relative to it", async () => {
  const repo = tmpDir();
  try {
    put(repo, "top.js", "t");
    put(repo, "pkg/a.js", "a");
    put(repo, "pkg/sub/b.js", "b");
    initRepo(repo);
    const files = await listGitFiles(path.join(repo, "pkg"));
    assert.deepEqual([...(files ?? [])].sort(), ["a.js", "sub/b.js"]);
  } finally {
    rmDir(repo);
  }
});

test("listFiles reports the mode and dedupes", async () => {
  const repo = tmpDir();
  try {
    put(repo, "a.js", "a");
    initRepo(repo);
    const r = await listFiles(repo, { defaultExcludes: true });
    assert.equal(r.mode, "git");
    assert.deepEqual(r.files, ["a.js"]);
  } finally {
    rmDir(repo);
  }
});

test("listFiles falls back to walking when git is not on PATH", async () => {
  const d = tmpDir();
  const empty = tmpDir();
  const saved = process.env.PATH;
  const savedPath = process.env.Path;
  try {
    put(d, "a.js", "a");
    put(d, "node_modules/x.js", "x");
    initRepo(d);
    process.env.PATH = empty;
    if (process.platform === "win32") process.env.Path = empty;
    const r = await listFiles(d, { defaultExcludes: true });
    assert.equal(r.mode, "walk");
    assert.deepEqual(r.files, ["a.js"]);
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
    if (process.platform === "win32" && savedPath !== undefined) process.env.Path = savedPath;
    rmDir(d);
    rmDir(empty);
  }
});

test("walkFiles ignores symlinked entries (when creatable)", async (t) => {
  const d = tmpDir();
  try {
    put(d, "real.js", "r");
    try {
      fs.symlinkSync(path.join(d, "real.js"), path.join(d, "link.js"));
    } catch {
      t.skip("cannot create symlinks here");
      return;
    }
    assert.deepEqual(await walkFiles(d, true), ["real.js"]);
  } finally {
    rmDir(d);
  }
});
