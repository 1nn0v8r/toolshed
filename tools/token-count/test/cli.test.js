// @ts-check
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.js";
import { makeRepo, rmDir, runCapture, sendJson, startMock, tmpDir, writeFiles } from "./helpers.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const KEY = ["test", "key", "value"].join("-");

/** @type {string[]} */
const cleanup = [];
after(() => cleanup.forEach(rmDir));

/** @param {Record<string, string | Buffer>} files */
function plainDir(files) {
  const d = tmpDir();
  cleanup.push(d);
  writeFiles(d, files);
  return d;
}

/**
 * Spawn the real CLI.
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string>, stdin?: string}} [opts]
 * @returns {Promise<{code: number | null, stdout: string, stderr: string}>}
 */
function spawnCli(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...opts.env };
    delete env.ANTHROPIC_API_KEY;
    Object.assign(env, opts.env);
    const child = spawn(process.execPath, [CLI, ...args], { cwd: opts.cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(opts.stdin ?? "");
  });
}

test("estimate output is labeled, sorted and has a total", async () => {
  const dir = plainDir({ "small.txt": "a".repeat(8), "big.txt": "b".repeat(400), "sub/mid.txt": "c".repeat(40) });
  const r = await runCapture(run, [], { cwd: dir });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Estimated token counts \(offline estimate/);
  const rowOrder = ["big.txt", "sub/mid.txt", "small.txt"].map((p) => r.stdout.indexOf(p));
  assert.ok(rowOrder.every((i) => i > 0) && rowOrder[0] < rowOrder[1] && rowOrder[1] < rowOrder[2]);
  assert.match(r.stdout, /Total: 112 tokens \(estimate\) across 3 files/);
  assert.match(r.stdout, /89\.3%\s+big\.txt/);
});

test("a single file argument", async () => {
  const dir = plainDir({ "a.txt": "abcde" });
  const r = await runCapture(run, [path.join(dir, "a.txt")], { cwd: dir });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Total: 2 tokens \(estimate\) across 1 file\n/);
});

test("dir argument prints paths relative to that dir with forward slashes", async () => {
  const dir = plainDir({ "pkg/deep/x.txt": "abcd" });
  const r = await runCapture(run, ["pkg"], { cwd: dir });
  assert.match(r.stdout, /deep\/x\.txt/);
  assert.ok(!r.stdout.includes("\\"));
  assert.ok(!r.stdout.includes("pkg/deep"));
});

test("empty directory gives a zero total", async () => {
  const dir = plainDir({});
  const r = await runCapture(run, [], { cwd: dir });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Total: 0 tokens \(estimate\) across 0 files/);
});

test("binary files are skipped and reported", async () => {
  const dir = plainDir({ "a.txt": "abcd", "img.bin": Buffer.from([0, 1, 2]) });
  const r = await runCapture(run, [], { cwd: dir });
  assert.ok(!r.stdout.includes("img.bin"));
  assert.match(r.stdout, /Skipped 1 binary file\n/);
});

test("CRLF and unicode files", async () => {
  const dir = plainDir({ "crlf.txt": "ab\r\ncd\r\n", "uni.txt": "\u{1F600}é中文" });
  const r = await runCapture(run, ["--json"], { cwd: dir });
  const j = JSON.parse(r.stdout);
  const by = Object.fromEntries(j.rows.map((/** @type {any} */ x) => [x.path, x]));
  assert.equal(by["crlf.txt"].chars, 8);
  assert.equal(by["crlf.txt"].tokens, 2);
  assert.equal(by["uni.txt"].chars, 4);
  assert.equal(by["uni.txt"].tokens, 1);
});

test("a huge file", async () => {
  const dir = plainDir({ "huge.txt": "x".repeat(2_000_000) });
  const r = await runCapture(run, ["--json"], { cwd: dir });
  assert.equal(JSON.parse(r.stdout).total, 500_000);
});

test("--top limits rows but not the total", async () => {
  const dir = plainDir({ "a.txt": "a".repeat(40), "b.txt": "b".repeat(20), "c.txt": "c".repeat(4) });
  const r = await runCapture(run, ["--top", "1"], { cwd: dir });
  assert.ok(r.stdout.includes("a.txt"));
  assert.ok(!r.stdout.includes("b.txt"));
  assert.match(r.stdout, /\.\.\. 2 more not shown \(--top 1\)/);
  assert.match(r.stdout, /Total: 16 tokens/);
  const j = JSON.parse((await runCapture(run, ["--top", "2", "--json"], { cwd: dir })).stdout);
  assert.equal(j.rows.length, 2);
  assert.equal(j.truncated, true);
  assert.equal(j.total, 16);
});

test("--by-dir aggregates top-level directories", async () => {
  const dir = plainDir({ "src/a.txt": "a".repeat(40), "src/x/b.txt": "b".repeat(40), "docs/c.txt": "c".repeat(8), "root.txt": "r".repeat(4) });
  const r = await runCapture(run, ["--by-dir", "--json"], { cwd: dir });
  const j = JSON.parse(r.stdout);
  assert.equal(j.view, "dir");
  assert.deepEqual(j.rows.map((/** @type {any} */ x) => [x.path, x.tokens, x.files]), [
    ["src/", 20, 2],
    ["docs/", 2, 1],
    ["(root)", 1, 1],
  ]);
  const text = await runCapture(run, ["--by-dir"], { cwd: dir });
  assert.match(text.stdout, /src\//);
});

test("--json shape for estimates", async () => {
  const dir = plainDir({ "a.txt": "abcd" });
  const j = JSON.parse((await runCapture(run, ["--json"], { cwd: dir })).stdout);
  assert.equal(j.mode, "estimate");
  assert.ok(!("model" in j));
  assert.equal(j.total, 1);
  assert.equal(j.fileCount, 1);
  assert.equal(j.view, "file");
  assert.equal(j.budget, null);
  assert.deepEqual(j.rows[0], { path: "a.txt", tokens: 1, chars: 4, share: 1 });
});

test("--json with zero files has share 0 safely", async () => {
  const dir = plainDir({});
  const j = JSON.parse((await runCapture(run, ["--json"], { cwd: dir })).stdout);
  assert.equal(j.total, 0);
  assert.deepEqual(j.rows, []);
});

test("--budget under, equal and over", async () => {
  const dir = plainDir({ "a.txt": "a".repeat(40) });
  const under = await runCapture(run, ["--budget", "100"], { cwd: dir });
  assert.equal(under.code, 0);
  assert.match(under.stdout, /Within budget of 100 tokens \(90 to spare\)/);
  const equal = await runCapture(run, ["--budget", "10"], { cwd: dir });
  assert.equal(equal.code, 0);
  const over = await runCapture(run, ["--budget", "4"], { cwd: dir });
  assert.equal(over.code, 1);
  assert.match(over.stderr, /over budget by 6 tokens \(total 10, budget 4\)/);
  const json = await runCapture(run, ["--budget", "4", "--json"], { cwd: dir });
  assert.equal(json.code, 1);
  assert.deepEqual(JSON.parse(json.stdout).budget, { limit: 4, over: 6, ok: false });
});

test("stdin input with -", async () => {
  const r = await runCapture(run, ["-", "--json"], { stdin: "abcdefgh" });
  const j = JSON.parse(r.stdout);
  assert.equal(j.total, 2);
  assert.equal(j.rows[0].path, "<stdin>");
});

test("stdin combined with paths", async () => {
  const dir = plainDir({ "a.txt": "abcd" });
  const r = await runCapture(run, ["a.txt", "-", "--json"], { cwd: dir, stdin: "abcd" });
  assert.deepEqual(JSON.parse(r.stdout).rows.map((/** @type {any} */ x) => x.path).sort(), ["<stdin>", "a.txt"]);
});

test("usage errors exit 2", async () => {
  const bad = await runCapture(run, ["--bogus"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown option --bogus/);
  const dir = plainDir({});
  const missing = await runCapture(run, ["nope"], { cwd: dir });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /path not found: nope/);
  assert.equal((await runCapture(run, ["--top", "x"])).code, 2);
});

test("help and version exit 0", async () => {
  const h = await runCapture(run, ["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /Usage:/);
  const v = await runCapture(run, ["--version"]);
  assert.equal(v.code, 0);
  assert.match(v.stdout, /^\d+\.\d+\.\d+\n$/);
});

test("unreadable entries are skipped, not fatal", async () => {
  const dir = plainDir({ "a.txt": "abcd" });
  // a directory-looking name that is a broken symlink cannot always be created on Windows; skip if it fails
  try {
    fs.symlinkSync(path.join(dir, "missing-target"), path.join(dir, "broken"));
  } catch {
    return;
  }
  const r = await runCapture(run, [], { cwd: dir });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /a\.txt/);
});

test("inside a git repo, ignored and untracked files follow git rules", async () => {
  const repo = makeRepo({ ".gitignore": "secret.txt\n", "a.txt": "abcd" });
  cleanup.push(repo);
  writeFiles(repo, { "secret.txt": "x".repeat(400), "new.txt": "abcd" });
  const j = JSON.parse((await runCapture(run, ["--json"], { cwd: repo })).stdout);
  assert.deepEqual(j.rows.map((/** @type {any} */ x) => x.path).sort(), [".gitignore", "a.txt", "new.txt"]);
});

test("exact mode: success with a mock server, key never printed", async () => {
  const dir = plainDir({ "a.txt": "aaaa", "b.txt": "bbbbbbbb", "empty.txt": "" });
  const mock = await startMock((req, _n, res) => {
    const text = req.body.messages[0].content;
    sendJson(res, 200, { input_tokens: text.length + 100 });
  });
  try {
    const r = await runCapture(run, ["--exact"], { cwd: dir, env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: mock.url } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Exact token counts \(Anthropic API, model claude-haiku-5-5\)/);
    assert.ok(!r.stdout.includes("(estimate)"));
    assert.match(r.stdout, /Total: 212 tokens across 3 files/);
    assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[0].headers["x-api-key"], KEY);
    assert.equal(mock.requests[0].body.model, "claude-haiku-5-5");
  } finally {
    await mock.close();
  }
});

test("exact mode: --model override and json", async () => {
  const dir = plainDir({ "a.txt": "aaaa" });
  const mock = await startMock((_req, _n, res) => sendJson(res, 200, { input_tokens: 11 }));
  try {
    const r = await runCapture(run, ["--exact", "--model", "claude-test-1", "--json"], { cwd: dir, env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: mock.url } });
    const j = JSON.parse(r.stdout);
    assert.equal(j.mode, "exact");
    assert.equal(j.model, "claude-test-1");
    assert.equal(j.total, 11);
    assert.equal(mock.requests[0].body.model, "claude-test-1");
  } finally {
    await mock.close();
  }
});

test("exact mode: 429 then success", async () => {
  const dir = plainDir({ "a.txt": "aaaa" });
  const mock = await startMock((_req, n, res) => {
    if (n === 1) sendJson(res, 429, { error: { message: "rate limited" } });
    else sendJson(res, 200, { input_tokens: 5 });
  });
  try {
    const r = await runCapture(run, ["--exact"], { cwd: dir, env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: mock.url, TOKEN_COUNT_RETRY_BASE_MS: "1" } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Total: 5 tokens/);
    assert.equal(mock.requests.length, 2);
  } finally {
    await mock.close();
  }
});

test("exact mode: 401 exits 1 with a clear message", async () => {
  const dir = plainDir({ "a.txt": "aaaa" });
  const mock = await startMock((_req, _n, res) => sendJson(res, 401, { error: { message: "invalid x-api-key" } }));
  try {
    const r = await runCapture(run, ["--exact"], { cwd: dir, env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: mock.url } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /API error 401: invalid x-api-key/);
    assert.ok(!r.stderr.includes(KEY));
    assert.equal(r.stdout, "");
  } finally {
    await mock.close();
  }
});

test("exact mode: missing key exits 1 without contacting the server", async () => {
  const dir = plainDir({ "a.txt": "aaaa" });
  const mock = await startMock((_req, _n, res) => sendJson(res, 200, { input_tokens: 1 }));
  try {
    const r = await runCapture(run, ["--exact"], { cwd: dir, env: { ANTHROPIC_BASE_URL: mock.url } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ANTHROPIC_API_KEY/);
    assert.equal(mock.requests.length, 0);
  } finally {
    await mock.close();
  }
});

test("exact mode: stdin and budget", async () => {
  const mock = await startMock((_req, _n, res) => sendJson(res, 200, { input_tokens: 50 }));
  try {
    const r = await runCapture(run, ["--exact", "-", "--budget", "10"], { stdin: "hello", env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: mock.url } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /over budget by 40 tokens/);
  } finally {
    await mock.close();
  }
});

test("exact mode: counts files with at most 4 in flight", async () => {
  /** @type {Record<string, string>} */
  const files = {};
  for (let i = 0; i < 12; i++) files[`f${i}.txt`] = `file ${i}`;
  const dir = plainDir(files);
  let active = 0;
  let peak = 0;
  const mock = await startMock((_req, _n, res) => {
    active++;
    peak = Math.max(peak, active);
    setTimeout(() => { active--; sendJson(res, 200, { input_tokens: 1 }); }, 20);
  });
  try {
    const r = await runCapture(run, ["--exact"], { cwd: dir, env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: mock.url } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(mock.requests.length, 12);
    assert.ok(peak <= 4, `peak ${peak}`);
  } finally {
    await mock.close();
  }
});

test("e2e: real process, estimate, exit 0", async () => {
  const dir = plainDir({ "a.txt": "abcdefgh" });
  const r = await spawnCli([], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Total: 2 tokens \(estimate\)/);
});

test("e2e: --version, --help, usage error, stdin, budget", async () => {
  const v = await spawnCli(["--version"]);
  assert.equal(v.code, 0);
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(CLI), "..", "package.json"), "utf8"));
  assert.equal(v.stdout.trim(), pkg.version);
  assert.equal((await spawnCli(["--help"])).code, 0);
  assert.equal((await spawnCli(["--nope"])).code, 2);
  const s = await spawnCli(["-", "--json"], { stdin: "abcdefgh" });
  assert.equal(JSON.parse(s.stdout).total, 2);
  const dir = plainDir({ "a.txt": "a".repeat(40) });
  assert.equal((await spawnCli(["--budget", "1"], { cwd: dir })).code, 1);
});

test("e2e: exact mode against the mock server, and missing key", async () => {
  const dir = plainDir({ "a.txt": "aaaa" });
  const mock = await startMock((_req, _n, res) => sendJson(res, 200, { input_tokens: 9 }));
  try {
    const ok = await spawnCli(["--exact", "--json"], { cwd: dir, env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: mock.url } });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).total, 9);
    const noKey = await spawnCli(["--exact"], { cwd: dir, env: { ANTHROPIC_BASE_URL: mock.url } });
    assert.equal(noKey.code, 1);
    assert.match(noKey.stderr, /ANTHROPIC_API_KEY/);
  } finally {
    await mock.close();
  }
});

test("e2e: runs through a symlinked bin path", async (t) => {
  const dir = plainDir({ "a.txt": "abcd" });
  const link = path.join(dir, "tc-link.js");
  try {
    fs.symlinkSync(CLI, link);
  } catch {
    t.skip("symlinks not permitted here");
    return;
  }
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [link, "a.txt"], { cwd: dir });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code, out }));
  });
  assert.equal(/** @type {any} */ (r).code, 0);
  assert.match(/** @type {any} */ (r).out, /Total: 1 token/);
});
