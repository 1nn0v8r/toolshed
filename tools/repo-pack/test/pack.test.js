// @ts-check
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { parseArgs, UsageError } from "../src/args.js";
import { applyBudget, pack, resolveScope } from "../src/pack.js";
import { put, rmDir, tmpDir } from "./helpers.js";

/**
 * @param {string} cwd
 * @param {string[]} argv
 */
const packIn = (cwd, argv) => pack(parseArgs(argv), cwd);

/** Build a small plain (non-git) project. */
function project() {
  const d = tmpDir();
  put(d, "README.md", "# Demo\n");
  put(d, "package.json", '{"name":"demo"}\n');
  put(d, "src/index.js", "export const a = 1;\n");
  put(d, "src/deep/more.js", "export const b = 2;\n");
  put(d, "test/index.test.js", "// test\n");
  return d;
}

test("applyBudget: null keeps all, otherwise fills in order and skips what does not fit", () => {
  const items = [
    { path: "a", tokens: 5 },
    { path: "b", tokens: 10 },
    { path: "c", tokens: 3 },
  ];
  assert.deepEqual(applyBudget(items, null), { included: items, omitted: [] });
  const r = applyBudget(items, 9);
  assert.deepEqual(r.included.map((f) => f.path), ["a", "c"]);
  assert.deepEqual(r.omitted.map((f) => f.path), ["b"]);
  assert.deepEqual(applyBudget(items, 5).included.map((f) => f.path), ["a"]);
  assert.equal(applyBudget(items, 2).included.length, 0);
});

test("resolveScope: single folder becomes the root", () => {
  const d = project();
  try {
    const r = resolveScope(["src"], d);
    assert.equal(r.root, path.join(d, "src"));
    assert.deepEqual(r.scopes, []);
  } finally {
    rmDir(d);
  }
});

test("resolveScope: errors for missing paths and paths outside the folder", () => {
  const d = project();
  try {
    assert.throws(() => resolveScope(["nope"], d), (e) => e instanceof UsageError && /not found/.test(e.message));
    assert.throws(() => resolveScope(["src", ".."], d), (e) => e instanceof UsageError && /outside/.test(e.message));
    assert.deepEqual(resolveScope([], d).scopes, []);
  } finally {
    rmDir(d);
  }
});

test("plain folder: priority order, default excludes, totals", async () => {
  const d = project();
  try {
    put(d, "node_modules/dep/index.js", "no");
    put(d, "package-lock.json", "{}");
    put(d, "app.log", "log");
    put(d, "a.js.map", "{}");
    const r = await packIn(d, []);
    assert.equal(r.status, "ok");
    assert.equal(r.mode, "walk");
    assert.deepEqual(r.files.map((f) => f.path), [
      "README.md",
      "package.json",
      "src/index.js",
      "src/deep/more.js",
      "test/index.test.js",
    ]);
    assert.equal(r.totalTokens, r.files.reduce((n, f) => n + f.tokens, 0));
    assert.deepEqual(r.skipped, []);
  } finally {
    rmDir(d);
  }
});

test("--no-default-excludes keeps lockfiles, maps and logs", async () => {
  const d = project();
  try {
    put(d, "package-lock.json", "{}");
    put(d, "app.log", "log");
    const r = await packIn(d, ["--no-default-excludes"]);
    const paths = r.files.map((f) => f.path);
    assert.ok(paths.includes("package-lock.json"));
    assert.ok(paths.includes("app.log"));
  } finally {
    rmDir(d);
  }
});

test("--order path", async () => {
  const d = project();
  try {
    const r = await packIn(d, ["--order", "path"]);
    assert.deepEqual(r.files.map((f) => f.path), [
      "README.md",
      "package.json",
      "src/deep/more.js",
      "src/index.js",
      "test/index.test.js",
    ]);
  } finally {
    rmDir(d);
  }
});

test("--priority boosts matching files and ensures inclusion under max-tokens", async () => {
  const d = project();
  try {
    const r = await packIn(d, ["--priority", "src/deep/more.js", "--max-tokens", "40"]);
    assert.equal(r.status, "ok");
    assert.equal(r.files[0].path, "src/deep/more.js");
  } finally {
    rmDir(d);
  }
});

test("include, exclude and positional scopes", async () => {
  const d = project();
  try {
    let r = await packIn(d, ["--include", "*.js", "--exclude", "test"]);
    assert.deepEqual(r.files.map((f) => f.path), ["src/index.js", "src/deep/more.js"]);

    r = await packIn(d, ["src", "README.md"]);
    // two positionals: root stays cwd
    assert.deepEqual(r.files.map((f) => f.path).sort(), ["README.md", "src/deep/more.js", "src/index.js"]);

    r = await packIn(d, ["src/**/*.js"]);
    assert.deepEqual(r.files.map((f) => f.path).sort(), ["src/deep/more.js", "src/index.js"]);

    r = await packIn(d, ["src"]);
    assert.deepEqual(r.files.map((f) => f.path), ["index.js", "deep/more.js"]);

    r = await packIn(d, [path.join(d, "README.md"), "package.json"]);
    assert.deepEqual(r.files.map((f) => f.path), ["README.md", "package.json"]);
  } finally {
    rmDir(d);
  }
});

test("no match gives status no-match", async () => {
  const d = project();
  try {
    assert.equal((await packIn(d, ["--include", "*.rs"])).status, "no-match");
    assert.equal((await packIn(d, ["**/*.nothing"])).status, "no-match");
    const empty = tmpDir();
    try {
      assert.equal((await packIn(empty, [])).status, "no-match");
    } finally {
      rmDir(empty);
    }
  } finally {
    rmDir(d);
  }
});

test(".env files are skipped and reported unless --allow-env", async () => {
  const d = project();
  try {
    put(d, ".env", "TOKEN=placeholder\n");
    put(d, "config/.env.local", "TOKEN=placeholder\n");
    let r = await packIn(d, []);
    assert.deepEqual(r.envSkipped, [".env", "config/.env.local"]);
    assert.ok(r.files.every((f) => !f.path.includes(".env")));
    assert.doesNotMatch(r.output, /placeholder/);

    r = await packIn(d, ["--allow-env"]);
    assert.deepEqual(r.envSkipped, []);
    assert.ok(r.files.some((f) => f.path === ".env"));
    assert.match(r.output, /TOKEN=placeholder/);

    // an env file filtered out by the user is not reported
    r = await packIn(d, ["--exclude", ".env*"]);
    assert.deepEqual(r.envSkipped, []);
  } finally {
    rmDir(d);
  }
});

test("binary and oversize files are skipped with reasons", async () => {
  const d = project();
  try {
    put(d, "logo.png", Buffer.from([0x89, 0x50, 0x00, 0x47]));
    put(d, "big.txt", "x".repeat(2000));
    const r = await packIn(d, ["--max-file-size", "1k"]);
    assert.equal(r.status, "ok");
    const byPath = Object.fromEntries(r.skipped.map((s) => [s.path, s.code]));
    assert.deepEqual(byPath, { "big.txt": "too-large", "logo.png": "binary" });
  } finally {
    rmDir(d);
  }
});

test("everything skipped gives no-packable", async () => {
  const d = tmpDir();
  try {
    put(d, "a.bin", Buffer.from([0, 1, 2]));
    const r = await packIn(d, []);
    assert.equal(r.status, "no-packable");
    assert.equal(r.skipped.length, 1);
  } finally {
    rmDir(d);
  }
});

test("--max-tokens leaves out files and lists them; tiny budget fails", async () => {
  const d = tmpDir();
  try {
    put(d, "README.md", "x".repeat(40)); // 10 tokens
    put(d, "src/a.js", "y".repeat(400)); // 100 tokens
    put(d, "src/b.js", "z".repeat(40)); // 10 tokens
    const r = await packIn(d, ["--max-tokens", "25"]);
    assert.equal(r.status, "ok");
    assert.deepEqual(r.files.map((f) => f.path), ["README.md", "src/b.js"]);
    assert.deepEqual(r.omitted, [{ path: "src/a.js", tokens: 100 }]);
    assert.ok(r.totalTokens <= 25);
    assert.match(r.output, /Left out \(over budget\)/);
    assert.doesNotMatch(r.output, /yyyy/);

    const tiny = await packIn(d, ["--max-tokens", "5"]);
    assert.equal(tiny.status, "budget-too-small");
    assert.equal(tiny.output, "");
    assert.equal(tiny.omitted.length, 3);
  } finally {
    rmDir(d);
  }
});

test("--line-numbers changes content and counts toward tokens", async () => {
  const d = tmpDir();
  try {
    put(d, "a.txt", "one\ntwo\n");
    const plain = await packIn(d, []);
    const numbered = await packIn(d, ["--line-numbers"]);
    assert.match(numbered.output, /1 \| one\n2 \| two\n/);
    assert.ok(numbered.totalTokens > plain.totalTokens);
  } finally {
    rmDir(d);
  }
});

test("CRLF input is normalized to LF in output", async () => {
  const d = tmpDir();
  try {
    put(d, "a.txt", "one\r\ntwo\r\n");
    const r = await packIn(d, []);
    assert.ok(!r.output.includes("\r"));
    assert.match(r.output, /one\ntwo\n/);
  } finally {
    rmDir(d);
  }
});

test("xml format", async () => {
  const d = tmpDir();
  try {
    put(d, "a.js", "const s = ']]>';\n");
    const r = await packIn(d, ["--format", "xml"]);
    assert.match(r.output, /^<repo-pack /);
    assert.match(r.output, /<file path="a\.js"/);
    assert.ok(!r.output.includes("']]>'"), "raw ]]> must not appear inside CDATA");
  } finally {
    rmDir(d);
  }
});

test("content containing triple backticks cannot break out of the fence", async () => {
  const d = tmpDir();
  try {
    put(d, "doc.md", "text\n```js\ncode\n```\nmore\n");
    const r = await packIn(d, []);
    assert.match(r.output, /````md\ntext\n```js\ncode\n```\nmore\n````\n/);
  } finally {
    rmDir(d);
  }
});

test("the --out file is never packed into itself", async () => {
  const d = tmpDir();
  try {
    put(d, "a.txt", "a");
    put(d, "bundle.md", "old");
    const r = await packIn(d, ["--out", "bundle.md"]);
    assert.deepEqual(r.files.map((f) => f.path), ["a.txt"]);
    const outside = await packIn(d, ["--out", path.join(tmpDir(), "x.md")]);
    assert.deepEqual(outside.files.map((f) => f.path).sort(), ["a.txt", "bundle.md"]);
  } finally {
    rmDir(d);
  }
});

test("empty file is packed with zero tokens", async () => {
  const d = tmpDir();
  try {
    put(d, "empty.txt", "");
    const r = await packIn(d, []);
    assert.equal(r.status, "ok");
    assert.deepEqual(r.files, [{ path: "empty.txt", tokens: 0 }]);
  } finally {
    rmDir(d);
  }
});

test("output paths use forward slashes", async () => {
  const d = tmpDir();
  try {
    put(d, "a/b/c.txt", "x");
    const r = await packIn(d, []);
    assert.deepEqual(r.files.map((f) => f.path), ["a/b/c.txt"]);
    assert.ok(!r.output.includes("\\"));
  } finally {
    rmDir(d);
  }
});

test("huge file over the default limit is skipped, large-but-allowed file is packed", async () => {
  const d = tmpDir();
  try {
    put(d, "huge.txt", "x".repeat(300 * 1024));
    put(d, "ok.txt", "x".repeat(200 * 1024));
    const r = await packIn(d, []);
    assert.deepEqual(r.files.map((f) => f.path), ["ok.txt"]);
    assert.equal(r.skipped[0].path, "huge.txt");
  } finally {
    rmDir(d);
  }
});
