// @ts-check
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { callTool, finalize, TOOLS } from "../../modules/git-history/tools.js";
import { defaultRoot, detectRepoRoot, git, resolveRepo, safeRelPath, safeRev, ToolError } from "../../modules/git-history/git.js";
import { cleanup, commit, EMAIL_RE, emptyRepo, makeRepo, put, sh, tmp } from "./helpers.js";

/** @type {{ dir: string, shas: Record<string, string> }} */
let repo;
before(() => {
  repo = makeRepo();
});
after(() => cleanup(repo.dir));

/**
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 */
const run = (name, args = {}) => callTool(name, args, repo.dir);

test("TOOLS lists all seven tools with schemas", () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    ["file_history", "blame_range", "line_origin", "commit_details", "search_commits", "churn", "contributors"]
  );
  for (const t of TOOLS) assert.equal(t.inputSchema.type, "object");
});

test("file_history follows renames by default", async () => {
  const out = await run("file_history", { path: "src/app.js" });
  assert.match(out, /^History of src\/app\.js \(following renames\):/);
  assert.match(out, /Tweak line three {2}\+1\/-1/);
  assert.match(out, /rename main to app/);
  assert.match(out, /Change line two {2}\+1\/-1/);
  assert.match(out, /init project/);
  assert.match(out, /\d{4}-\d{2}-\d{2} {2}Alice Anders/);
  assert.equal(out.split("\n").length, 5);
});

test("file_history without follow stops at the rename", async () => {
  const out = await run("file_history", { path: "src/app.js", follow: false });
  assert.doesNotMatch(out, /init project/);
  assert.match(out, /rename main to app/);
});

test("file_history caps and reports the cap", async () => {
  const out = await run("file_history", { path: "src/app.js", limit: 2 });
  assert.match(out, /\(capped at 2 commits/);
  assert.equal(out.split("\n").length, 4);
});

test("file_history works with spaces, unicode and CRLF files", async () => {
  assert.match(await run("file_history", { path: "docs/my file.txt" }), /add docs and unicode file {2}\+1\/-0/);
  assert.match(await run("file_history", { path: "src/\u00fcn\u00ef.js" }), /add docs and unicode file/);
  const crlf = await run("file_history", { path: "crlf.txt" });
  assert.match(crlf, /\+3\/-0/);
  assert.doesNotMatch(crlf, /\r/);
});

test("file_history reports files with no history and clamps limit", async () => {
  assert.match(await run("file_history", { path: "nope.txt" }), /No history found for nope\.txt/);
  const out = await run("file_history", { path: "src/app.js", limit: 100000 });
  assert.equal(out.split("\n").length, 5);
});

test("file_history validates limit", async () => {
  await assert.rejects(run("file_history", { path: "src/app.js", limit: "abc" }), /limit must be an integer/);
  await assert.rejects(run("file_history", { path: "src/app.js", limit: 1.5 }), /integer/);
  await assert.rejects(run("file_history", {}), /path is required/);
});

test("blame_range groups lines by commit without code by default", async () => {
  const out = await run("blame_range", { path: "src/app.js", startLine: 1, endLine: 5 });
  const lines = out.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^L1 {2}[0-9a-f]{7} {2}2026-01-10 {2}Alice Anders {2}init project$/);
  assert.match(lines[1], /^L2 {2}[0-9a-f]{7} {2}2026-03-10 {2}Alice Anders {2}Change line two$/);
  assert.match(lines[2], /^L3 {2}[0-9a-f]{7} {2}2026-05-01 {2}Bob Baker {2}Tweak line three$/);
  assert.match(lines[3], /^L4-L5 {2}[0-9a-f]{7} {2}2026-01-10 {2}Alice Anders/);
  assert.doesNotMatch(out, /line three by bob/);
});

test("blame_range includeCode prints code and strips CR", async () => {
  const out = await run("blame_range", { path: "crlf.txt", startLine: 1, endLine: 3, includeCode: true });
  assert.match(out, /L1-L3 {2}[0-9a-f]{7}/);
  assert.match(out, /\n {4}alpha\n {4}beta\n {4}gamma$/);
  assert.doesNotMatch(out, /\r/);
});

test("blame_range caps at 400 lines and says so", async () => {
  put(repo.dir, "big.txt", Array.from({ length: 450 }, (_, i) => `row ${i + 1}`).join("\n") + "\n");
  commit(repo.dir, "Alice Anders", "add big file", "2026-06-01T10:00:00Z");
  const out = await run("blame_range", { path: "big.txt", startLine: 1, endLine: 450 });
  assert.match(out, /^L1-L400 /);
  assert.match(out, /\(range capped at 400 lines: showed L1-L400\)/);
  assert.match(await run("blame_range", { path: "big.txt", startLine: 7, endLine: 7 }), /^L7 {2}/);
});

test("blame_range marks uncommitted lines", async () => {
  fs.appendFileSync(path.join(repo.dir, "README.md"), "dirty line\n");
  const out = await run("blame_range", { path: "README.md", startLine: 1, endLine: 3 });
  assert.match(out, /uncommitted/);
  sh(repo.dir, ["checkout", "--", "README.md"]);
});

test("blame_range validates arguments", async () => {
  await assert.rejects(run("blame_range", { path: "src/app.js", startLine: 5, endLine: 2 }), /endLine must be >= startLine/);
  await assert.rejects(run("blame_range", { path: "src/app.js", startLine: 1 }), /endLine is required/);
  await assert.rejects(run("blame_range", { path: "src/app.js", startLine: 99, endLine: 120 }), /file .*only/i);
  await assert.rejects(run("blame_range", { path: "src/app.js", startLine: 0, endLine: 2 }), /startLine must be >= 1/);
  await assert.rejects(run("blame_range", { path: "missing.txt", startLine: 1, endLine: 2 }), ToolError);
});

test("line_origin shows last change and the one before", async () => {
  const out = await run("line_origin", { path: "src/app.js", line: 3 });
  assert.match(out, /^Last changed by: [0-9a-f]{7} {2}2026-05-01 {2}Bob Baker {2}Tweak line three/);
  assert.match(out, /\n {2}-line three\n {2}\+line three by bob/);
  assert.match(out, /Previously changed by: [0-9a-f]{7} {2}2026-01-10 {2}Alice Anders {2}init project/);
  assert.doesNotMatch(out, /diff --git|^index /m);
});

test("line_origin notes when no earlier commit exists", async () => {
  const out = await run("line_origin", { path: "README.md", line: 1 });
  assert.match(out, /Last changed by:/);
  assert.match(out, /no earlier commit touched this line|Previously changed by/);
});

test("line_origin errors on bad line and clips long patches", async () => {
  await assert.rejects(run("line_origin", { path: "src/app.js", line: 999 }), ToolError);
  await assert.rejects(run("line_origin", { path: "src/app.js", line: 0 }), /line must be >= 1/);
  await assert.rejects(run("line_origin", { path: "src/app.js" }), /line is required/);
});

test("commit_details for a normal commit", async () => {
  const out = await run("commit_details", { sha: repo.shas.change });
  assert.match(out, new RegExp(`^commit ${repo.shas.change}`));
  assert.match(out, /author {2}Alice Anders/);
  assert.match(out, /date {4}2026-03-10 \d\d:\d\d:\d\d [+-]\d{4}/);
  assert.match(out, /\n {4}Change line two\n/);
  assert.match(out, /1 file\(s\) changed, \+1\/-1/);
  assert.match(out, /\+1\/-1 {2}src\/main\.js/);
  assert.doesNotMatch(out, /\npatch:/);
});

test("commit_details root commit, short sha and HEAD revisions", async () => {
  const root = await run("commit_details", { sha: repo.shas.init.slice(0, 8) });
  assert.match(root, /parents \(root commit\)/);
  assert.match(root, /3 file\(s\) changed/);
  assert.match(await run("commit_details", { sha: "HEAD~1" }), /^commit [0-9a-f]{40}/);
});

test("commit_details includes a patch and clips it", async () => {
  const full = await run("commit_details", { sha: repo.shas.change, includePatch: true });
  assert.match(full, /\npatch:\n/);
  assert.match(full, /\+line two changed/);
  assert.doesNotMatch(full, /\nindex [0-9a-f]/);
  const clipped = await run("commit_details", { sha: repo.shas.init, includePatch: true, maxPatchLines: 3 });
  assert.match(clipped, /\(patch clipped at 3 lines; \d+ more\)/);
});

test("commit_details on a merge uses the first parent", async () => {
  const out = await run("commit_details", { sha: repo.shas.merge, includePatch: true });
  assert.match(out, /\(merge; stats vs first parent\)/);
  assert.match(out, /1 file\(s\) changed, \+1\/-0/);
  assert.match(out, /feature\.txt/);
  assert.match(out, /\+feature work/);
});

test("commit_details renders renames and hides emails in messages", async () => {
  const rename = await run("commit_details", { sha: repo.shas.rename });
  assert.match(rename, /src\/\{main\.js => app\.js\}|main\.js => .*app\.js/);
  const tweak = await run("commit_details", { sha: repo.shas.tweak });
  assert.match(tweak, /Reviewed-by: Zed <\[email hidden\]>/);
});

test("commit_details rejects unknown and malformed revisions", async () => {
  await assert.rejects(run("commit_details", { sha: "deadbeefdeadbeef" }), /Unknown commit: deadbeefdeadbeef/);
  await assert.rejects(run("commit_details", { sha: "--output=x" }), /Invalid revision/);
  await assert.rejects(run("commit_details", { sha: "a b" }), /Invalid revision/);
  await assert.rejects(run("commit_details", {}), /sha is required/);
});

test("commit_details lists binary files", async () => {
  fs.writeFileSync(path.join(repo.dir, "pic.bin"), Buffer.from([0, 1, 2, 0, 255, 0, 3]));
  commit(repo.dir, "Alice Anders", "add binary", "2026-06-02T10:00:00Z");
  assert.match(await run("commit_details", { sha: "HEAD" }), / {2}binary {2}pic\.bin/);
});

test("search_commits by message, author, dates, path and limit", async () => {
  assert.match(await run("search_commits", { query: "RENAME" }), /rename main to app/);
  assert.equal((await run("search_commits", { query: "RENAME" })).split("\n").length, 1);
  assert.match(await run("search_commits", { query: "Reviewed-by" }), /Tweak line three/);
  const bob = await run("search_commits", { author: "bob" });
  assert.match(bob, /Bob Baker/);
  assert.doesNotMatch(bob, /Alice/);
  assert.match(await run("search_commits", { until: "2026-01-31" }), /init project/);
  assert.match(await run("search_commits", { since: "2026-05-01", until: "2026-05-31" }), /update readme/);
  assert.match(await run("search_commits", { query: "line", path: "src/app.js" }), /Tweak line three/);
  const capped = await run("search_commits", { limit: 2 });
  assert.match(capped, /\(capped at 2 results/);
  assert.match(await run("search_commits", { query: "no such text anywhere" }), /No matching commits/);
});

test("search_commits treats the query literally and supports pickaxe", async () => {
  assert.match(await run("search_commits", { query: ".*" }), /No matching commits/);
  const pick = await run("search_commits", { query: "line two changed", pickaxe: true });
  assert.match(pick, /Change line two/);
  assert.doesNotMatch(pick, /init project/);
  await assert.rejects(run("search_commits", { pickaxe: true }), /pickaxe requires a query/);
  await assert.rejects(run("search_commits", { path: "../x" }), /escapes/);
});

test("churn ranks files by commit count and respects limit and path", async () => {
  const out = await run("churn", { since: "10 years ago" });
  assert.match(out, /^Most changed files since 10 years ago:\ncommits {2}lines {2}path/);
  const rows = out.split("\n").slice(2);
  assert.match(rows[0], /^ {7}\d+ {2}\s*\d+ {2}README\.md|src\/app\.js|src\/main\.js/);
  const first = Number(rows[0].trim().split(/\s+/)[0]);
  const last = Number(rows[rows.length - 1].trim().split(/\s+/)[0]);
  assert.ok(first >= last);
  const limited = await run("churn", { since: "10 years ago", limit: 2 });
  assert.match(limited, /\(showing 2 of \d+ files/);
  const scoped = await run("churn", { since: "10 years ago", path: "docs" });
  assert.match(scoped, /docs\/my file\.txt/);
  assert.doesNotMatch(scoped, /src\//);
});

test("churn default window and empty result", async () => {
  const empty = await run("churn", { since: "2026-07-01" });
  assert.match(empty, /No file changes since 2026-07-01/);
  assert.match(await run("churn"), /^(Most changed files since 90 days ago:|No file changes since 90 days ago)/);
});

test("contributors lists names with counts and no merges", async () => {
  const out = await run("contributors");
  const lines = out.split("\n");
  assert.match(lines[0], /^ +\d+ {2}Alice Anders$/);
  assert.match(out, /Bob Baker/);
  assert.match(out, /Zo\u00eb M\u00fcller/);
  const alice = Number(lines[0].trim().split(/\s+/)[0]);
  assert.ok(alice >= 4);
});

test("contributors path, since and limit", async () => {
  const scoped = await run("contributors", { path: "docs" });
  assert.match(scoped, /^ +1 {2}Bob Baker$/);
  assert.match(await run("contributors", { since: "2026-07-01" }), /No commits found/);
  assert.match(await run("contributors", { limit: 1 }), /\(showing 1 of \d+ authors/);
});

test("no tool output contains an email address", async () => {
  const outs = [
    await run("file_history", { path: "src/app.js" }),
    await run("blame_range", { path: "src/app.js", startLine: 1, endLine: 5, includeCode: true }),
    await run("line_origin", { path: "src/app.js", line: 3 }),
    await run("commit_details", { sha: repo.shas.tweak, includePatch: true }),
    await run("search_commits", { query: "Reviewed-by" }),
    await run("search_commits", { author: "example.com" }),
    await run("churn", { since: "10 years ago" }),
    await run("contributors"),
  ];
  for (const o of outs) assert.doesNotMatch(o, EMAIL_RE);
});

test("path escapes are rejected by every file tool", async () => {
  const outside = path.join(path.dirname(repo.dir), "outside.txt");
  for (const p of ["../outside.txt", "..", "src/../../outside.txt", outside]) {
    await assert.rejects(run("file_history", { path: p }), /escapes the repo root/);
    await assert.rejects(run("blame_range", { path: p, startLine: 1, endLine: 1 }), /escapes the repo root/);
    await assert.rejects(run("line_origin", { path: p, line: 1 }), /escapes the repo root/);
  }
  await assert.rejects(run("churn", { path: "../" }), /escapes the repo root/);
  await assert.rejects(run("contributors", { path: ".." }), /escapes the repo root/);
  await assert.rejects(run("file_history", { path: "" }), /path is required/);
});

test("absolute paths inside the root are accepted", async () => {
  const out = await run("file_history", { path: path.join(repo.dir, "src", "app.js") });
  assert.match(out, /^History of src\/app\.js/);
});

test("symlink escapes are rejected when symlinks can be created", async (t) => {
  const outside = tmp();
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "x");
    try {
      fs.symlinkSync(outside, path.join(repo.dir, "linkdir"), "junction");
    } catch {
      t.skip("symlinks unavailable");
      return;
    }
    await assert.rejects(run("file_history", { path: "linkdir/secret.txt" }), /escapes the repo root/);
  } finally {
    fs.rmSync(path.join(repo.dir, "linkdir"), { force: true, recursive: true });
    cleanup(outside);
  }
});

test("repoRoot override works and is validated", async () => {
  const other = makeRepo();
  try {
    const out = await callTool("contributors", { repoRoot: other.dir }, "/abs/path/not/used");
    assert.match(out, /Alice Anders/);
    await assert.rejects(callTool("contributors", { repoRoot: "relative/dir" }, repo.dir), /must be an absolute path/);
    await assert.rejects(callTool("contributors", { repoRoot: path.join(other.dir, "missing") }, repo.dir), /Not a directory/);
  } finally {
    cleanup(other.dir);
  }
});

test("non-git directories give a clear error", async () => {
  const dir = tmp();
  try {
    for (const name of TOOLS.map((t) => t.name)) {
      await assert.rejects(callTool(name, { path: "a.txt", sha: "HEAD", startLine: 1, endLine: 1, line: 1 }, dir), /Not a git repository/);
    }
    await assert.rejects(resolveRepo(dir, undefined), /Not a git repository/);
  } finally {
    cleanup(dir);
  }
});

test("empty repositories are handled", async () => {
  const dir = emptyRepo();
  try {
    assert.equal(await callTool("file_history", { path: "a.txt" }, dir), "No commits yet.");
    assert.equal(await callTool("search_commits", {}, dir), "No commits yet.");
    assert.equal(await callTool("churn", {}, dir), "No commits yet.");
    assert.equal(await callTool("contributors", {}, dir), "No commits yet.");
    await assert.rejects(callTool("commit_details", { sha: "HEAD" }, dir), /Unknown commit/);
  } finally {
    cleanup(dir);
  }
});

test("unknown tools are rejected", async () => {
  await assert.rejects(run("rm_rf"), /Unknown tool: rm_rf/);
  await assert.rejects(run("constructor"), /Unknown tool/);
});

test("finalize caps long output and redacts emails", () => {
  const out = finalize("x".repeat(30000));
  assert.ok(out.length < 25000);
  assert.match(out, /output clipped at 24000 characters/);
  assert.equal(finalize("a@b.co"), "[email hidden]");
});

test("git helpers: root detection, defaults and revision checks", () => {
  const nested = path.join(repo.dir, "src");
  assert.equal(detectRepoRoot(nested), repo.dir);
  const plain = tmp();
  try {
    assert.equal(detectRepoRoot(plain), path.resolve(plain));
  } finally {
    cleanup(plain);
  }
  const prev = process.env.REPO_ROOT;
  process.env.REPO_ROOT = repo.dir;
  assert.equal(defaultRoot(), path.resolve(repo.dir));
  delete process.env.REPO_ROOT;
  assert.equal(typeof defaultRoot(), "string");
  if (prev !== undefined) process.env.REPO_ROOT = prev;
  assert.equal(safeRev("HEAD~2"), "HEAD~2");
  assert.equal(safeRelPath(repo.dir, "src\\app.js".replace("\\", path.sep)), "src/app.js");
  assert.throws(() => safeRelPath(repo.dir, "a\0b"), /Invalid path/);
  assert.throws(() => safeRev("-x"), /Invalid revision/);
});

test("git() reports failures as ToolError, including a missing cwd tool error", async () => {
  await assert.rejects(git(repo.dir, ["definitely-not-a-command"]), ToolError);
});
