// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { git, GitError, isGitRepo, latestTag, parseLog, readCommits, resolveRef } from "../src/git.js";
import { cleanup, commit, git as g, makeDir, makeRepo } from "./helpers.js";

test("parseLog handles NUL records, empty input and odd bodies", () => {
  assert.deepEqual(parseLog(""), []);
  const out = ["h1\x1fp1 p2\x1fsubj\x1fbody line\n\nmore", "\nh2\x1f\x1fsubj2\x1f", "junk"].join("\0") + "\0";
  const r = parseLog(out);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0].parents, ["p1", "p2"]);
  assert.equal(r[0].body, "body line\n\nmore");
  assert.equal(r[1].hash, "h2");
  assert.deepEqual(r[1].parents, []);
  assert.equal(r[0].short, "h1");
});

test("parseLog keeps a unit separator inside the body", () => {
  const r = parseLog("h\x1f\x1fs\x1fa\x1fb\0");
  assert.equal(r[0].body, "a\x1fb");
});

test("isGitRepo, resolveRef, latestTag and readCommits on a real repo", async () => {
  const notRepo = makeDir();
  const dir = makeRepo();
  try {
    assert.equal(await isGitRepo(notRepo), false);
    assert.equal(await isGitRepo(dir), true);
    assert.equal(await resolveRef("HEAD", dir), null);

    const first = commit(dir, "feat: first");
    assert.equal(await resolveRef("HEAD", dir), first);
    assert.equal(await resolveRef("nope", dir), null);
    assert.equal(await latestTag("v", "HEAD", dir), null);

    g(dir, ["tag", "v1.0.0"]);
    g(dir, ["tag", "-a", "-m", "release", "pack@2.0.0"]);
    commit(dir, "fix: second\n\nbody with | pipes and \"quotes\"");
    assert.equal(await latestTag("v", "HEAD", dir), "v1.0.0");
    assert.equal(await latestTag("pack@", "HEAD", dir), "pack@2.0.0");
    assert.equal(await latestTag("nope@", "HEAD", dir), null);
    assert.equal(await latestTag("*", "HEAD", dir), null, "glob chars in the prefix are literal");

    const all = await readCommits({ cwd: dir, to: "HEAD", includeMerges: false });
    assert.equal(all.length, 2);
    assert.equal(all[0].subject, "fix: second");
    assert.match(all[0].body, /pipes and "quotes"/);
    const ranged = await readCommits({ cwd: dir, from: "v1.0.0", to: "HEAD", includeMerges: false });
    assert.equal(ranged.length, 1);
    await assert.rejects(readCommits({ cwd: dir, from: "bad-ref", to: "HEAD", includeMerges: false }), GitError);
  } finally {
    cleanup(notRepo);
    cleanup(dir);
  }
});

test("merge commits are skipped unless included", async () => {
  const dir = makeRepo();
  try {
    commit(dir, "feat: base");
    const main = g(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    g(dir, ["switch", "-q", "-c", "side"]);
    commit(dir, "fix: on side");
    g(dir, ["switch", "-q", main]);
    commit(dir, "feat: on main");
    g(dir, ["merge", "--no-ff", "-q", "-m", "Merge branch side", "side"]);
    const without = await readCommits({ cwd: dir, to: "HEAD", includeMerges: false });
    const withM = await readCommits({ cwd: dir, to: "HEAD", includeMerges: true });
    assert.equal(without.length, 3);
    assert.equal(withM.length, 4);
    assert.ok(withM.some((c) => c.parents.length === 2));
  } finally {
    cleanup(dir);
  }
});

test("path filtering and multi-line messages with NUL-unsafe content", async () => {
  const dir = makeRepo();
  try {
    commit(dir, "a: one", "tools/a/x.txt");
    commit(dir, "b: two\n\nline\n\n\nlasté ✓", "tools/b/y.txt");
    const onlyB = await readCommits({ cwd: dir, to: "HEAD", path: "tools/b", includeMerges: false });
    assert.equal(onlyB.length, 1);
    assert.equal(onlyB[0].subject, "b: two");
    assert.match(onlyB[0].body, /lasté ✓/);
  } finally {
    cleanup(dir);
  }
});

test("git() reports non-zero exit and a missing binary", async () => {
  const dir = makeDir();
  try {
    const r = await git(["rev-parse", "--git-dir"], dir);
    assert.notEqual(r.code, 0);
    const saved = process.env.PATH;
    const savedWin = process.env.Path;
    process.env.PATH = dir;
    if (savedWin !== undefined) process.env.Path = dir;
    try {
      await assert.rejects(git(["--version"], dir), (e) => e instanceof GitError && e.missing);
    } finally {
      process.env.PATH = saved;
      if (savedWin !== undefined) process.env.Path = savedWin;
    }
  } finally {
    cleanup(dir);
  }
});
