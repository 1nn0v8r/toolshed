// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens } from "../src/tokens.js";
import { languageFor } from "../src/language.js";
import { comparePaths, sortByPath, sortByPriority, tierOf } from "../src/priority.js";

test("estimateTokens is ceil(chars / 4)", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("a"), 1);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("x".repeat(1000)), 250);
});

test("languageFor", () => {
  assert.equal(languageFor("a/b.ts"), "ts");
  assert.equal(languageFor("a/b.PY"), "python");
  assert.equal(languageFor("Dockerfile"), "dockerfile");
  assert.equal(languageFor("x/Dockerfile.dev"), "dockerfile");
  assert.equal(languageFor("Makefile"), "makefile");
  assert.equal(languageFor("noext"), "");
  assert.equal(languageFor("a.unknownext"), "");
  assert.equal(languageFor("a.constructor"), "");
  assert.equal(languageFor("data.json"), "json");
});

/** @type {[string, number][]} */
const TIERS = [
  ["README.md", 0],
  ["packages/x/readme.txt", 0],
  ["docs/guide.md", 0],
  ["CONTRIBUTING.md", 0],
  ["src/notes.md", 2],
  ["package.json", 1],
  ["tsconfig.build.json", 1],
  ["vite.config.ts", 1],
  ["requirements-dev.txt", 1],
  ["Dockerfile", 1],
  [".eslintrc", 1],
  ["settings.yaml", 1],
  ["sub/settings.yaml", 2],
  ["src/index.js", 2],
  ["lib/util.py", 2],
  ["test/a.js", 3],
  ["src/__tests__/a.js", 3],
  ["src/a.test.ts", 3],
  ["src/a.spec.ts", 3],
  ["pkg/a_test.go", 3],
  ["pkg/test_a.py", 3],
  ["test/README.md", 3],
];
for (const [p, tier] of TIERS) {
  test(`tierOf ${p} is ${tier}`, () => assert.equal(tierOf(p), tier));
}

test("priority order is docs, config, source by depth, then tests", () => {
  const paths = [
    "test/a.test.js",
    "src/deep/er/c.js",
    "src/b.js",
    "z.js",
    "package.json",
    "docs/x.md",
    "README.md",
    "src/a.js",
  ];
  const sorted = sortByPriority(paths.map((path) => ({ path }))).map((f) => f.path);
  assert.deepEqual(sorted, [
    "README.md",
    "docs/x.md",
    "package.json",
    "z.js",
    "src/a.js",
    "src/b.js",
    "src/deep/er/c.js",
    "test/a.test.js",
  ]);
});

test("ordering is deterministic and does not mutate the input", () => {
  const input = [{ path: "b.js" }, { path: "a.js" }, { path: "B.js" }];
  const copy = JSON.stringify(input);
  const first = sortByPriority(input).map((f) => f.path);
  const second = sortByPriority([...input].reverse()).map((f) => f.path);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), copy);
  assert.deepEqual(sortByPath(input).map((f) => f.path), ["B.js", "a.js", "b.js"]);
});

test("comparePaths", () => {
  assert.equal(comparePaths("a", "b"), -1);
  assert.equal(comparePaths("b", "a"), 1);
  assert.equal(comparePaths("a", "a"), 0);
});
