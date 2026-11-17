// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HELP, run } from "../src/cli.js";
import { git, initRepo, put, rmDir, runCli, tmpDir } from "./helpers.js";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("--help and --version print to stdout and exit 0", () => {
  const h = runCli(["--help"]);
  assert.equal(h.code, 0);
  assert.equal(h.stdout, HELP);
  assert.match(h.stdout, /--max-tokens/);
  assert.equal(h.stderr, "");
  const v = runCli(["--version"]);
  assert.equal(v.code, 0);
  assert.equal(v.stdout.trim(), pkg.version);
  assert.equal(runCli(["-v"]).stdout.trim(), pkg.version);
});

test("usage errors exit 2 with a message on stderr and nothing on stdout", () => {
  for (const args of [["--bogus"], ["--format", "yaml"], ["--max-tokens", "0"], ["--include"], ["no-such-path"]]) {
    const r = runCli(args, { cwd: tmpDir() });
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^repo-pack: /);
  }
});

test("git repo: respects .gitignore, includes untracked files, stdout is clean markdown", () => {
  const d = tmpDir();
  try {
    put(d, ".gitignore", "secret-notes.txt\ndist/\n");
    put(d, "README.md", "# Hello\n");
    put(d, "src/main.js", "console.log(1);\n");
    put(d, "secret-notes.txt", "ignored");
    put(d, "dist/out.js", "ignored");
    initRepo(d);
    put(d, "src/new.js", "// untracked\n");
    const r = runCli([], { cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^# Repo pack: /);
    assert.match(r.stdout, /### src\/main\.js\n\n```js\nconsole\.log\(1\);\n```/);
    assert.match(r.stdout, /### src\/new\.js/);
    assert.doesNotMatch(r.stdout, /ignored/);
    assert.match(r.stderr, /packed 4 file\(s\)/);
    assert.doesNotMatch(r.stderr, /# Repo pack/);
    assert.ok(r.stdout.indexOf("### README.md") < r.stdout.indexOf("### src/main.js"));
  } finally {
    rmDir(d);
  }
});

test("git repo: deleted-but-tracked files are skipped as missing", () => {
  const d = tmpDir();
  try {
    put(d, "keep.txt", "k");
    put(d, "gone.txt", "g");
    initRepo(d);
    fs.rmSync(path.join(d, "gone.txt"));
    const r = runCli([], { cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /gone\.txt \(missing on disk\)/);
    assert.doesNotMatch(r.stdout, /### gone\.txt/);
  } finally {
    rmDir(d);
  }
});

test("git repo: a subfolder argument packs only that folder with relative paths", () => {
  const d = tmpDir();
  try {
    put(d, "top.js", "t");
    put(d, "pkg/a.js", "a");
    initRepo(d);
    const r = runCli(["pkg"], { cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /### a\.js/);
    assert.doesNotMatch(r.stdout, /top\.js/);
  } finally {
    rmDir(d);
  }
});

test("non-git folder: walks with default excludes", () => {
  const d = tmpDir();
  try {
    put(d, "a.js", "a");
    put(d, "node_modules/x/index.js", "dep");
    put(d, "dist/bundle.js", "built");
    put(d, "yarn.lock", "lock");
    put(d, "site.js.map", "map");
    put(d, "run.log", "log");
    const r = runCli([], { cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /### a\.js/);
    for (const bad of ["dep", "built", "lock", "map"]) assert.doesNotMatch(r.stdout, new RegExp(`\\n${bad}\\n`));
    assert.doesNotMatch(r.stdout, /node_modules|bundle\.js|yarn\.lock|run\.log/);
  } finally {
    rmDir(d);
  }
});

test("git missing from PATH: falls back to the folder walk", () => {
  const d = tmpDir();
  const empty = tmpDir();
  try {
    put(d, "a.js", "a");
    put(d, "node_modules/x.js", "dep");
    initRepo(d);
    const env = { ...process.env, PATH: empty, Path: empty };
    const r = runCli([], { cwd: d, env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /### a\.js/);
    assert.doesNotMatch(r.stdout, /node_modules/);
  } finally {
    rmDir(d);
    rmDir(empty);
  }
});

test(".env is never packed, with a warning; --allow-env opts in", () => {
  const d = tmpDir();
  try {
    put(d, "a.js", "a");
    put(d, ".env", "DB_PASSWORD=not-a-real-value\n");
    initRepo(d);
    const r = runCli([], { cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /DB_PASSWORD/);
    assert.match(r.stderr, /warning: skipped 1 \.env file/);
    assert.match(r.stderr, /--allow-env/);

    const allowed = runCli(["--allow-env"], { cwd: d });
    assert.equal(allowed.code, 0);
    assert.match(allowed.stdout, /DB_PASSWORD=not-a-real-value/);
    assert.doesNotMatch(allowed.stderr, /warning/);
  } finally {
    rmDir(d);
  }
});

test("binary and oversize files are reported on stderr", () => {
  const d = tmpDir();
  try {
    put(d, "a.js", "a");
    put(d, "img.png", Buffer.from([0x89, 0, 1, 2]));
    put(d, "big.txt", "x".repeat(3000));
    const r = runCli(["--max-file-size", "2k"], { cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /skipped 2 file\(s\)/);
    assert.match(r.stderr, /img\.png \(binary\)/);
    assert.match(r.stderr, /big\.txt \(too large \(3000 bytes, limit 2048\)\)/);
    assert.doesNotMatch(r.stdout, /img\.png|big\.txt/);
  } finally {
    rmDir(d);
  }
});

test("--include and --exclude (repeatable)", () => {
  const d = tmpDir();
  try {
    put(d, "a.js", "a");
    put(d, "b.ts", "b");
    put(d, "c.md", "c");
    put(d, "test/t.js", "t");
    const r = runCli(["--include", "*.js", "--include", "*.ts", "--exclude", "test", "--exclude", "b.ts"], { cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /### a\.js/);
    assert.doesNotMatch(r.stdout, /### (b\.ts|c\.md|test\/t\.js)/);
  } finally {
    rmDir(d);
  }
});

test("--max-tokens: priority order keeps docs and config, lists what was left out", () => {
  const d = tmpDir();
  try {
    put(d, "README.md", "r".repeat(80)); // 20
    put(d, "package.json", "{}".repeat(20)); // 10
    put(d, "src/big.js", "b".repeat(4000)); // 1000
    put(d, "test/t.test.js", "t".repeat(40)); // 10
    const r = runCli(["--max-tokens", "45"], { cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /### README\.md/);
    assert.match(r.stdout, /### package\.json/);
    assert.match(r.stdout, /### test\/t\.test\.js/);
    assert.doesNotMatch(r.stdout, /bbbb/);
    assert.match(r.stdout, /- src\/big\.js \(about 1000 tokens\)/);
    assert.match(r.stderr, /left out 1 file\(s\) over the --max-tokens budget of 45/);
    assert.match(r.stderr, /src\/big\.js/);
  } finally {
    rmDir(d);
  }
});

test("budget too small for any file exits 1 with empty stdout and no --out file", () => {
  const d = tmpDir();
  try {
    put(d, "a.js", "x".repeat(400));
    const out = path.join(d, "o.md");
    const r = runCli(["--max-tokens", "10", "--out", out], { cwd: d });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /too small/);
    assert.equal(fs.existsSync(out), false);
  } finally {
    rmDir(d);
  }
});

test("nothing matched exits 1", () => {
  const d = tmpDir();
  try {
    put(d, "a.js", "a");
    const r = runCli(["--include", "*.rs"], { cwd: d });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /no files matched/);
    const empty = runCli([], { cwd: tmpDir() });
    assert.equal(empty.code, 1);
  } finally {
    rmDir(d);
  }
});

test("every file skipped exits 1", () => {
  const d = tmpDir();
  try {
    put(d, "a.bin", Buffer.from([0, 0, 0]));
    const r = runCli([], { cwd: d });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /nothing to pack/);
  } finally {
    rmDir(d);
  }
});

test("--out writes a file, keeps stdout empty, prints the summary on stderr", () => {
  const d = tmpDir();
  try {
    put(d, "a.js", "a\r\nb\r\n");
    initRepo(d);
    const r = runCli(["--out", "bundle.md"], { cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /wrote bundle\.md/);
    const text = fs.readFileSync(path.join(d, "bundle.md"), "utf8");
    assert.match(text, /### a\.js/);
    assert.ok(!text.includes("\r"));
    // running again must not pack the previous bundle into the new one
    const again = runCli(["--out", "bundle.md"], { cwd: d });
    assert.equal(again.code, 0);
    assert.doesNotMatch(fs.readFileSync(path.join(d, "bundle.md"), "utf8"), /### bundle\.md/);
  } finally {
    rmDir(d);
  }
});

test("--out to an unwritable location exits 1", () => {
  const d = tmpDir();
  try {
    put(d, "a.js", "a");
    const r = runCli(["--out", path.join(d, "missing-folder", "x.md")], { cwd: d });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot write/);
  } finally {
    rmDir(d);
  }
});

test("--format xml and --line-numbers", () => {
  const d = tmpDir();
  try {
    put(d, "a.js", "one\ntwo\n");
    const xml = runCli(["--format", "xml", "--line-numbers"], { cwd: d });
    assert.equal(xml.code, 0, xml.stderr);
    assert.match(xml.stdout, /<file path="a\.js" language="js" estimated-tokens="\d+"><!\[CDATA\[1 \| one\n2 \| two\n\]\]><\/file>/);
    const md = runCli(["--line-numbers"], { cwd: d });
    assert.match(md.stdout, /```js\n1 \| one\n2 \| two\n```/);
  } finally {
    rmDir(d);
  }
});

test("single folder argument outside cwd becomes the root", () => {
  const d = tmpDir();
  const elsewhere = tmpDir();
  try {
    put(d, "inner/x.js", "x");
    const r = runCli([path.join(d, "inner")], { cwd: elsewhere });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /### x\.js/);
  } finally {
    rmDir(d);
    rmDir(elsewhere);
  }
});

test("glob positional and unicode file names", () => {
  const d = tmpDir();
  try {
    put(d, "src/café.js", "ok\n");
    put(d, "src/b.py", "no\n");
    const r = runCli(["src/**/*.js"], { cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /### src\/café\.js/);
    assert.doesNotMatch(r.stdout, /b\.py/);
  } finally {
    rmDir(d);
  }
});

test("output is deterministic across runs", () => {
  const d = tmpDir();
  try {
    for (const n of ["z.js", "a.js", "m/b.js", "README.md"]) put(d, n, `// ${n}\n`);
    initRepo(d);
    const a = runCli([], { cwd: d });
    const b = runCli([], { cwd: d });
    assert.equal(a.stdout, b.stdout);
  } finally {
    rmDir(d);
  }
});

test("tracked symlink is skipped (when git and the OS allow it)", (t) => {
  const d = tmpDir();
  try {
    put(d, "real.txt", "r");
    try {
      fs.symlinkSync(path.join(d, "real.txt"), path.join(d, "link.txt"));
    } catch {
      t.skip("cannot create symlinks here");
      return;
    }
    git(d, ["init", "-q"]);
    const r = runCli([], { cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /link\.txt \(symlink\)/);
  } finally {
    rmDir(d);
  }
});

test("run() in-process: help, usage error and success without spawning", async () => {
  const d = tmpDir();
  try {
    put(d, "a.js", "a");
    /** @type {string[]} */ const out = [];
    /** @type {string[]} */ const err = [];
    const io = { cwd: d, stdout: (/** @type {string} */ s) => void out.push(s), stderr: (/** @type {string} */ s) => void err.push(s) };
    assert.equal(await run(["--help"], io), 0);
    assert.equal(await run(["--nope"], io), 2);
    assert.equal(await run([], io), 0);
    assert.match(out.join(""), /### a\.js/);
    assert.match(err.join(""), /unknown option/);
  } finally {
    rmDir(d);
  }
});
