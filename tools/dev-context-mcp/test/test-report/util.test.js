// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clean, clipEnd, clipLine, detectRoot, isFrame, isNoiseFrame, isInside, locFromFrame,
  pickLocation, relativize, resolveDir, resolveFileInRoot, resolveRoot, splitStack, stripAnsi, tailLines,
} from "../../modules/test-report/util.js";
import { tmpDir, write } from "./helpers.js";

test("stripAnsi removes colors, cursor codes and OSC links", () => {
  assert.equal(stripAnsi("\u001b[31mred\u001b[39m \u001b[1;32mgreen\u001b[0m"), "red green");
  assert.equal(stripAnsi("\u001b]8;;http://x\u0007link\u001b]8;;\u0007"), "link");
  assert.equal(stripAnsi("plain"), "plain");
  assert.equal(stripAnsi(/** @type {any} */ (undefined)), "");
});

test("clean normalises CRLF and lone CR", () => {
  assert.equal(clean("a\r\nb\rc\n"), "a\nb\nc\n");
});

test("tailLines keeps the last n lines and ignores trailing blanks", () => {
  assert.deepEqual(tailLines("1\n2\n3\n4\n\n\n", 2), ["3", "4"]);
  assert.deepEqual(tailLines("", 5), [""]);
  assert.deepEqual(tailLines("a\r\nb", 5), ["a", "b"]);
});

test("clipEnd and clipLine", () => {
  assert.equal(clipEnd("abc", 10), "abc");
  const c = clipEnd("0123456789", 4);
  assert.match(c, /clipped 6 chars/);
  assert.ok(c.endsWith("6789"));
  assert.equal(clipLine("abcdef", 3), "abc...");
  assert.equal(clipLine("abc", 3), "abc");
});

test("detectRoot walks up to .git and falls back to the start dir", (t) => {
  const root = tmpDir(t);
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
  assert.equal(detectRoot(path.join(root, "a", "b")), root);
});

test("detectRoot returns start when no git root exists", (t) => {
  const root = tmpDir(t);
  const r = detectRoot(root);
  // tmp is normally outside any repo; if it is inside one, the root must be an ancestor
  assert.ok(isInside(r, root));
});

test("resolveRoot honours REPO_ROOT, else cwd detection", () => {
  const prev = process.env.REPO_ROOT;
  try {
    process.env.REPO_ROOT = path.resolve(os.tmpdir());
    assert.equal(resolveRoot(), path.resolve(os.tmpdir()));
    delete process.env.REPO_ROOT;
    assert.ok(isInside(resolveRoot(), process.cwd()));
  } finally {
    if (prev === undefined) delete process.env.REPO_ROOT;
    else process.env.REPO_ROOT = prev;
  }
});

test("resolveDir accepts inside paths and rejects escapes", (t) => {
  const root = tmpDir(t);
  fs.mkdirSync(path.join(root, "sub"));
  write(root, "file.txt", "x");
  assert.equal(resolveDir(root, undefined), root);
  assert.equal(resolveDir(root, ""), root);
  assert.equal(resolveDir(root, "sub"), path.join(root, "sub"));
  assert.equal(resolveDir(root, "./sub/.."), root);
  assert.throws(() => resolveDir(root, ".."), /outside repo root/);
  assert.throws(() => resolveDir(root, "sub/../../x"), /outside repo root/);
  assert.throws(() => resolveDir(root, path.dirname(root)), /outside repo root/);
  assert.throws(() => resolveDir(root, "missing"), /not found/i);
  assert.throws(() => resolveDir(root, "file.txt"), /Not a directory/);
});

test("resolveDir rejects a symlink that points outside the root", (t) => {
  const root = tmpDir(t);
  const outside = tmpDir(t);
  try {
    fs.symlinkSync(outside, path.join(root, "link"), "junction");
  } catch {
    t.skip("cannot create symlinks here");
    return;
  }
  assert.throws(() => resolveDir(root, "link"), /outside repo root/);
});

test("resolveFileInRoot rejects escapes", (t) => {
  const root = tmpDir(t);
  assert.equal(resolveFileInRoot(root, root, "a.js"), path.join(root, "a.js"));
  assert.throws(() => resolveFileInRoot(root, root, "../a.js"), /outside repo root/);
});

test("relativize strips root in both separators, file URLs and case", () => {
  const roots = ["/abs/path/to/project"];
  assert.equal(relativize("at x (/abs/path/to/project/src/a.js:1:2)", roots), "at x (src/a.js:1:2)");
  assert.equal(relativize("file:///abs/path/to/project/src/a.js:1:2", roots), "src/a.js:1:2");
  assert.equal(relativize("file:///C:/work/proj/src/a.js:1:2", ["C:\\work\\proj"]), "src/a.js:1:2");
  assert.equal(relativize("C:\\work\\proj\\src\\a.js:1", ["C:\\work\\proj"]), "src\\a.js:1");
  assert.equal(relativize("nothing here", roots), "nothing here");
  assert.equal(relativize("keep", []), "keep");
  assert.equal(relativize("/abs/path/to/project", roots), "");
});

test("isFrame recognises JS, python, go and vitest frames", () => {
  assert.ok(isFrame("    at foo (a.js:1:2)"));
  assert.ok(isFrame(" \u276F test/a.test.ts:5:3"));
  assert.ok(isFrame('  File "a.py", line 3, in f'));
  assert.ok(isFrame("tests/test_a.py:14: AssertionError"));
  assert.ok(isFrame("\t/x/y_test.go:40 +0x1d"));
  assert.ok(isFrame("TestContext.<anonymous> (test/a.js:11:12)"));
  assert.ok(!isFrame("AssertionError: nope"));
  assert.ok(!isFrame(""));
});

test("isNoiseFrame drops node_modules and node internals", () => {
  assert.ok(isNoiseFrame("at x (node:internal/process/task_queues:95:5)"));
  assert.ok(isNoiseFrame("at x (/p/node_modules/dep/index.js:1:1)"));
  assert.ok(isNoiseFrame("at new Promise (<anonymous>)"));
  assert.ok(isNoiseFrame("at async Promise.all (index 0)"));
  assert.ok(isNoiseFrame("/usr/lib/python3.12/site-packages/x.py:1: in f"));
  assert.ok(isNoiseFrame("C:\\p\\node_modules\\dep\\a.js:1:1"));
  assert.ok(!isNoiseFrame("at test (src/a.js:1:1)"));
});

test("locFromFrame parses common frame shapes", () => {
  assert.deepEqual(locFromFrame("at fn (src/a.js:10:5)"), { file: "src/a.js", line: 10 });
  assert.deepEqual(locFromFrame("at src/a.js:10:5"), { file: "src/a.js", line: 10 });
  assert.deepEqual(locFromFrame("at fn (D:\\p\\src\\a.js:10:5)"), { file: "D:\\p\\src\\a.js", line: 10 });
  assert.deepEqual(locFromFrame('File "/x/a.py", line 7, in f'), { file: "/x/a.py", line: 7 });
  assert.deepEqual(locFromFrame("tests/test_a.py:14: AssertionError"), { file: "tests/test_a.py", line: 14 });
  assert.equal(locFromFrame("at async Promise.all (index 0)"), null);
});

test("splitStack separates message from frames, drops noise and caps frames", () => {
  const frames = Array.from({ length: 12 }, (_, i) => `    at f${i} (src/a.js:${i + 1}:1)`);
  const text = ["Error: boom", "detail", ...frames.slice(0, 3), "    at x (node:internal/a:1:1)", ...frames.slice(3)].join("\n");
  const r = splitStack(text);
  assert.deepEqual(r.message, ["Error: boom", "detail"]);
  assert.equal(r.frames.length, 8);
  assert.ok(!r.frames.some((f) => f.includes("node:internal")));
});

test("pickLocation prefers a frame in the known file", () => {
  const frames = ["at a (src/lib.js:3:1)", "at b (test/x.test.js:9:2)"];
  assert.deepEqual(pickLocation(frames, "test/x.test.js"), { file: "test/x.test.js", line: 9 });
  assert.deepEqual(pickLocation(frames), { file: "src/lib.js", line: 3 });
  assert.deepEqual(pickLocation([], "a/b.js"), { file: "a/b.js" });
  assert.deepEqual(pickLocation([]), {});
});

test("relativize: decodes percent-encoded tilde from Node reporters (Windows 8.3 names)", () => {
  const root = "C:/Work/PROJEC~1/proj";
  const reported = "C:/Work/PROJEC%7E1/proj/test/sample.test.js";
  assert.equal(relativize(reported, [root]), "test/sample.test.js");
});
