// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { createMatcher, isGlob, normalizePattern } from "../src/glob.js";

test("normalizePattern strips ./, leading and trailing slashes", () => {
  assert.equal(normalizePattern("./src/"), "src");
  assert.equal(normalizePattern("/src/**"), "src/**");
  assert.equal(normalizePattern("  a.js "), "a.js");
});

test("isGlob", () => {
  assert.equal(isGlob("src/**/*.js"), true);
  assert.equal(isGlob("*.md"), true);
  assert.equal(isGlob("src/a.js"), false);
});

test("empty pattern list matches nothing", () => {
  assert.equal(createMatcher([])("a.js"), false);
  assert.equal(createMatcher(["", "  "])("a.js"), false);
});

test("slash-less pattern matches the file name at any depth", () => {
  const m = createMatcher(["*.js"]);
  assert.equal(m("a.js"), true);
  assert.equal(m("src/deep/a.js"), true);
  assert.equal(m("a.ts"), false);
});

test("patterns with slashes are anchored to the root", () => {
  const m = createMatcher(["src/*.js"]);
  assert.equal(m("src/a.js"), true);
  assert.equal(m("src/x/a.js"), false);
  assert.equal(m("other/src/a.js"), false);
});

test("globstar", () => {
  const m = createMatcher(["src/**/*.ts"]);
  assert.equal(m("src/a.ts"), true);
  assert.equal(m("src/x/y/a.ts"), true);
  assert.equal(m("lib/a.ts"), false);
  assert.equal(createMatcher(["**/*.js"])("a.js"), true);
});

test("a matching folder includes everything below it", () => {
  assert.equal(createMatcher(["test"])("test/a/b.js"), true);
  assert.equal(createMatcher(["src/utils"])("src/utils/x.js"), true);
  assert.equal(createMatcher(["src/utils"])("src/other/x.js"), false);
});

test("dotfiles match, braces and negated classes work", () => {
  assert.equal(createMatcher(["*"])(".hidden"), true);
  const m = createMatcher(["*.{md,txt}"]);
  assert.equal(m("a.md"), true);
  assert.equal(m("a.txt"), true);
  assert.equal(m("a.js"), false);
});

test("any of several patterns", () => {
  const m = createMatcher(["*.md", "src"]);
  assert.equal(m("README.md"), true);
  assert.equal(m("src/a.js"), true);
  assert.equal(m("lib/a.js"), false);
});

test("unicode paths", () => {
  assert.equal(createMatcher(["*.js"])("src/café/日本.js"), true);
});
