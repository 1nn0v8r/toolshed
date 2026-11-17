// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { baseName, globToSource, matchGlob, matchesAny, normalizePath } from "../src/lib/glob.js";

test("normalizePath converts separators and strips ./", () => {
  assert.equal(normalizePath("a\\b\\\\c"), "a/b/c");
  assert.equal(normalizePath("./x/y"), "x/y");
  assert.equal(normalizePath("C:\\Users\\me\\.env"), "C:/Users/me/.env");
});

test("baseName handles both separators and trailing slash", () => {
  assert.equal(baseName("/a/b/c.txt"), "c.txt");
  assert.equal(baseName("C:\\a\\b.txt"), "b.txt");
  assert.equal(baseName("dir/"), "dir");
  assert.equal(baseName("plain"), "plain");
});

test("globs without a slash match the file name", () => {
  assert.ok(matchGlob("*.pem", "/x/y/cert.pem"));
  assert.ok(matchGlob("*.PEM", "C:\\x\\cert.pem"));
  assert.ok(!matchGlob("*.pem", "/x/y/cert.pem.txt"));
  assert.ok(matchGlob("id_*", "/home/u/.ssh/id_rsa"));
});

test("relative globs with a slash match trailing segments", () => {
  assert.ok(matchGlob("secrets/**", "/abs/proj/secrets/a/b.txt"));
  assert.ok(matchGlob("secrets/", "/abs/proj/secrets/a.txt"));
  assert.ok(matchGlob(".aws/credentials", "C:\\Users\\me\\.aws\\credentials"));
  assert.ok(!matchGlob("secrets/**", "/abs/proj/public/a.txt"));
  assert.ok(matchGlob("**/fixtures/*.json", "/p/test/fixtures/a.json"));
  assert.ok(!matchGlob("**/fixtures/*.json", "/p/test/fixtures/deep/a.json"));
});

test("absolute globs must match the whole path", () => {
  assert.ok(matchGlob("/abs/path/**", "/abs/path/x/y"));
  assert.ok(!matchGlob("/abs/path/*", "/other/abs/path/x"));
  assert.ok(matchGlob("D:/work/**", "D:\\work\\a\\b"));
});

test("braces, ? and character classes", () => {
  assert.ok(matchGlob("*.{pem,key}", "a.key"));
  assert.ok(!matchGlob("*.{pem,key}", "a.crt"));
  assert.ok(matchGlob("file?.txt", "file1.txt"));
  assert.ok(matchGlob("f[0-9].txt", "f7.txt"));
  assert.ok(matchGlob("f[!0-9].txt", "fa.txt"));
  assert.ok(!matchGlob("f[!0-9].txt", "f7.txt"));
  assert.ok(matchGlob("a[b", "a[b"));
  assert.ok(matchGlob("*.{a,b", "x.a"));
});

test("empty inputs never match", () => {
  assert.ok(!matchGlob("", "a"));
  assert.ok(!matchGlob("a", ""));
  assert.ok(!matchesAny([], "a"));
});

test("matchesAny and globToSource", () => {
  assert.ok(matchesAny(["*.x", "*.y"], "a.y"));
  assert.equal(globToSource("a.b"), "a\\.b");
  assert.equal(globToSource("**"), ".*");
});
