// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { EM, ELL, commit, fake, git, makeRepo, rmDir, runCli, stage, tmpDir, unixHome, winHome, write } from "./helpers.js";

/** @type {string[]} */
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmDir(d);
});
function repo() {
  const d = makeRepo();
  dirs.push(d);
  return d;
}

describe("check --staged", () => {
  it("passes on a clean staged file (default mode, no flag)", () => {
    const d = repo();
    write(d, "a.js", "export const a = 1;\n");
    stage(d, "a.js");
    const r = runCli(d, ["check"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /no problems found \(1 file scanned\)/);
  });

  it("passes with nothing staged", () => {
    const d = repo();
    const r = runCli(d, ["check", "--staged"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /0 files scanned/);
  });

  it("blocks a staged secret with the right line, masked output and exit 1", () => {
    const d = repo();
    const secret = fake.aws();
    write(d, "src/a.js", `line one\nconst k = "${secret}";\n`);
    stage(d, "src/a.js");
    const r = runCli(d, ["check", "--staged"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^src\/a\.js:2  error  secret\.aws-access-key  /m);
    assert.ok(r.stdout.includes("AKIA***"));
    assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), "full secret must never be printed");
    assert.match(r.stdout, /1 error, 0 warnings/);
  });

  it("scans only added lines: old secrets in untouched lines are ignored, new ones get real line numbers", () => {
    const d = repo();
    const old = fake.ghp();
    write(d, "a.txt", `l1\nold = "${old}"\nl3\n`);
    stage(d, "a.txt");
    assert.equal(commit(d).status, 0);
    // add a clean line, plus a new secret at line 5
    write(d, "a.txt", `l1\nold = "${old}"\nl3\nl4\nnew = "${fake.stripe()}"\n`);
    stage(d, "a.txt");
    const r = runCli(d, ["check", "--staged"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^a\.txt:5  error  secret\.stripe-live/m);
    assert.ok(!/secret\.github-token/.test(r.stdout));
  });

  it("does not flag a secret that is only removed", () => {
    const d = repo();
    write(d, "a.txt", `x = "${fake.aws()}"\nkeep\n`);
    stage(d, "a.txt");
    commit(d);
    write(d, "a.txt", "keep\n");
    stage(d, "a.txt");
    assert.equal(runCli(d, ["check"]).status, 0);
  });

  it("ignores unstaged working-tree changes", () => {
    const d = repo();
    write(d, "a.txt", "clean\n");
    stage(d, "a.txt");
    write(d, "a.txt", `x = "${fake.aws()}"\n`);
    assert.equal(runCli(d, ["check"]).status, 0);
  });

  it("handles CRLF files", () => {
    const d = repo();
    write(d, "w.txt", `one\r\ntwo\r\nk = "${fake.aws()}"\r\n`);
    stage(d, "w.txt");
    const r = runCli(d, ["check", "--staged"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^w\.txt:3  error  secret\.aws-access-key/m);
  });

  it("skips binary files", () => {
    const d = repo();
    write(d, "img.bin", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(fake.aws())]));
    stage(d, "img.bin");
    const r = runCli(d, ["check"]);
    assert.equal(r.status, 0, r.stdout);
  });

  it("handles unicode and space file names", () => {
    const d = repo();
    write(d, "dir with space/café.txt", `k = "${fake.slack()}"\n`);
    stage(d, "dir with space/café.txt");
    const r = runCli(d, ["check"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^dir with space\/café\.txt:1  error  secret\.slack-token/m);
  });

  it("works from a subdirectory", () => {
    const d = repo();
    write(d, "sub/a.txt", `k = "${fake.google()}"\n`);
    stage(d, "sub/a.txt");
    const r = runCli(path.join(d, "sub"), ["check"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^sub\/a\.txt:1/m);
  });

  it("does not scan deleted files", () => {
    const d = repo();
    write(d, "a.txt", `k = "${fake.aws()}"\n`);
    stage(d, "a.txt");
    commit(d);
    git(d, ["rm", "-q", "a.txt"]);
    assert.equal(runCli(d, ["check"]).status, 0);
  });

  it("flags every rule family end to end", () => {
    const d = repo();
    const lines = [
      fake.ghPat(), fake.privateKey(), fake.anthropic(), fake.openai(), fake.jwt(),
      `password = "${fake.generic()}"`,
    ];
    write(d, "all.txt", lines.join("\n") + "\n");
    stage(d, "all.txt");
    const r = runCli(d, ["check"]);
    assert.equal(r.status, 1);
    for (const id of ["github-token", "private-key", "anthropic-key", "openai-key", "jwt", "generic-assignment"]) {
      assert.ok(r.stdout.includes(`secret.${id}`), id);
    }
    for (const l of lines) assert.ok(!r.stdout.includes(l));
  });
});

describe("file rules", () => {
  it("blocks .env files but allows .env.example", () => {
    const d = repo();
    write(d, ".env", "A=1\n");
    write(d, ".env.local", "B=1\n");
    write(d, ".env.example", "A=\n");
    stage(d, ".env", ".env.local", ".env.example");
    const r = runCli(d, ["check"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^\.env:0  error  file\.env/m);
    assert.match(r.stdout, /^\.env\.local:0  error  file\.env/m);
    assert.ok(!/^\.env\.example:/m.test(r.stdout));
  });

  it("warns about large files but exits 0 (default 1 MB)", () => {
    const d = repo();
    write(d, "big.txt", "a".repeat(1024 * 1024 + 10));
    write(d, "ok.txt", "a".repeat(1024));
    stage(d, "big.txt", "ok.txt");
    const r = runCli(d, ["check"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^big\.txt:0  warn  file\.large/m);
    assert.ok(!/ok\.txt/.test(r.stdout));
    assert.match(r.stdout, /0 errors, 1 warning/);
  });

  it("respects maxFileSizeKB and rule overrides", () => {
    const d = repo();
    write(d, ".commit-guard.json", JSON.stringify({ maxFileSizeKB: 1, rules: { "file.large": "error" } }));
    write(d, "mid.txt", "a".repeat(2000));
    stage(d, "mid.txt");
    const r = runCli(d, ["check"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /error  file\.large/);
  });
});

describe("path and typography rules", () => {
  it("path.personal warns by default (exit 0) and errors via config", () => {
    const d = repo();
    write(d, "a.md", `see ${winHome("bob")} and ${unixHome("bob")}\n`);
    stage(d, "a.md");
    let r = runCli(d, ["check"]);
    assert.equal(r.status, 0);
    assert.equal((r.stdout.match(/warn  path\.personal/g) ?? []).length, 2);
    assert.ok(!r.stdout.includes("bob\\") && !r.stdout.includes("bob/"));
    write(d, ".commit-guard.json", JSON.stringify({ rules: { "path.personal": "error" } }));
    r = runCli(d, ["check"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /error  path\.personal/);
  });

  it("text.typography is off by default and detects characters when enabled", () => {
    const d = repo();
    write(d, "t.md", `a ${EM} b ${ELL}\n`);
    stage(d, "t.md");
    assert.equal(runCli(d, ["check"]).stdout.includes("text.typography"), false);
    write(d, ".commit-guard.json", JSON.stringify({ rules: { "text.typography": "error" } }));
    const r = runCli(d, ["check"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^t\.md:1  error  text\.typography  Em dash/m);
    assert.match(r.stdout, /Ellipsis/);
    assert.ok(!r.stdout.includes(EM) && !r.stdout.includes(ELL), "output itself stays plain");
  });

  it("text.typography auto-fixes typography characters in place with --fix", () => {
    const d = repo();
    write(d, "t.md", `a ${EM} b ${ELL}\n`);
    stage(d, "t.md");
    write(d, ".commit-guard.json", JSON.stringify({ rules: { "text.typography": "error" } }));
    const r = runCli(d, ["check", "--fix"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /commit-guard: fixed 2 typography characters/);
    assert.equal(fs.readFileSync(path.join(d, "t.md"), "utf8"), "a -- b ...\n");
  });

  it("text.typography auto-fixes explicit files with --fix", () => {
    const d = repo();
    write(d, "note.md", `first ${EM} second\n`);
    write(d, ".commit-guard.json", JSON.stringify({ rules: { "text.typography": "error" } }));
    const r = runCli(d, ["check", "--fix", "note.md"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /fixed 1 typography character/);
    assert.equal(fs.readFileSync(path.join(d, "note.md"), "utf8"), "first -- second\n");
  });
});

describe("suppression and config", () => {
  it("inline marker, allow regexes and ignoreFiles suppress findings", () => {
    const d = repo();
    write(d, "a.js", `k = "${fake.aws()}" // commit-guard: ignore\n`);
    write(d, "b.js", `FIXTURE_KEY = "${fake.aws()}"\n`);
    write(d, "fixtures/c.js", `k = "${fake.aws()}"\n`);
    write(d, ".commit-guard.json", JSON.stringify({ allow: ["^FIXTURE_"], ignoreFiles: ["fixtures/**"] }));
    stage(d, "a.js", "b.js", "fixtures/c.js", ".commit-guard.json");
    const r = runCli(d, ["check"]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /\(4 files scanned\)|\(3 files scanned\)/);
  });

  it("rules set to off are skipped", () => {
    const d = repo();
    write(d, ".commit-guard.json", JSON.stringify({ rules: { "secret.aws-access-key": "off" } }));
    write(d, "a.js", `k = "${fake.aws()}"\n`);
    stage(d, "a.js");
    assert.equal(runCli(d, ["check"]).status, 0);
  });

  it("exits 2 on invalid config for every command that reads it", () => {
    const d = repo();
    write(d, ".commit-guard.json", '{"rules":{"nope":"off"}}');
    for (const args of [["check"], ["rules"], ["check", "--all"]]) {
      const r = runCli(d, args);
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.stderr, /unknown rule id/);
    }
    write(d, ".commit-guard.json", "{broken");
    assert.equal(runCli(d, ["check"]).status, 2);
  });
});

describe("json output", () => {
  it("emits parseable findings and summary with masked matches", () => {
    const d = repo();
    const secret = fake.ghp();
    write(d, "a.js", `t = "${secret}"\n`);
    stage(d, "a.js");
    const r = runCli(d, ["check", "--json"]);
    assert.equal(r.status, 1);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false);
    assert.equal(j.summary.errors, 1);
    assert.equal(j.findings[0].rule, "secret.github-token");
    assert.equal(j.findings[0].path, "a.js");
    assert.equal(j.findings[0].line, 1);
    assert.ok(!r.stdout.includes(secret));
  });

  it("rules --json lists every rule", () => {
    const d = repo();
    const j = JSON.parse(runCli(d, ["rules", "--json"]).stdout);
    assert.equal(j.length, 14);
    assert.equal(j.find((/** @type {any} */ x) => x.id === "text.typography").enabled, false);
  });
});

describe("check --all and explicit files", () => {
  it("--all scans tracked files whole, including already committed content", () => {
    const d = repo();
    write(d, "old.js", `k = "${fake.aws()}"\n`);
    write(d, "ok.js", "fine\n");
    write(d, "bin.dat", Buffer.from([0, 0, 0]));
    stage(d, "old.js", "ok.js", "bin.dat");
    commit(d);
    write(d, "untracked.js", `k = "${fake.aws()}"\n`);
    const r = runCli(d, ["check", "--all"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^old\.js:1  error/m);
    assert.ok(!r.stdout.includes("untracked.js"));
    assert.match(r.stdout, /\(3 files scanned\)/);
  });

  it("--all skips tracked files that were deleted from the working tree", () => {
    const d = repo();
    write(d, "gone.js", "x\n");
    stage(d, "gone.js");
    commit(d);
    fs.rmSync(path.join(d, "gone.js"));
    const r = runCli(d, ["check", "--all"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /0 files scanned/);
  });

  it("explicit files are scanned whole, also outside git", () => {
    const d = tmpDir();
    dirs.push(d);
    write(d, "a.txt", `x\nk = "${fake.aws()}"\n`);
    write(d, "b.txt", "clean\n");
    write(d, ".env", "A=1\n");
    let r = runCli(d, ["check", "a.txt", "b.txt"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^a\.txt:2  error  secret\.aws-access-key/m);
    r = runCli(d, ["check", "b.txt"]);
    assert.equal(r.status, 0);
    r = runCli(d, ["check", ".env"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /file\.env/);
  });

  it("explicit file errors exit 2", () => {
    const d = tmpDir();
    dirs.push(d);
    fs.mkdirSync(path.join(d, "folder"));
    assert.equal(runCli(d, ["check", "missing.txt"]).status, 2);
    const r = runCli(d, ["check", "folder"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not a file/);
  });

  it("explicit files honour ignoreFiles and show absolute path outside the repo", () => {
    const d = repo();
    const other = tmpDir();
    dirs.push(other);
    write(d, ".commit-guard.json", JSON.stringify({ ignoreFiles: ["skip.txt"] }));
    write(d, "skip.txt", `k = "${fake.aws()}"\n`);
    write(other, "out.txt", `k = "${fake.aws()}"\n`);
    assert.equal(runCli(d, ["check", "skip.txt"]).status, 0);
    const r = runCli(d, ["check", path.join(other, "out.txt")]);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes(".txt:1  error"));
  });

  it("--all and --staged outside a git repo exit 2", () => {
    const d = tmpDir();
    dirs.push(d);
    for (const args of [["check"], ["check", "--staged"], ["check", "--all"]]) {
      const r = runCli(d, args);
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.stderr, /not inside a git repository/);
    }
  });
});

describe("misc CLI behaviour", () => {
  it("help, version, and usage errors", () => {
    const d = tmpDir();
    dirs.push(d);
    assert.equal(runCli(d, ["--help"]).status, 0);
    assert.match(runCli(d, ["--help"]).stdout, /Usage:/);
    assert.match(runCli(d, ["--version"]).stdout, /^0\.1\.0/);
    assert.equal(runCli(d, []).status, 2);
    assert.equal(runCli(d, ["bogus"]).status, 2);
    assert.equal(runCli(d, ["check", "--nope"]).status, 2);
    assert.equal(runCli(d, ["check", "--staged", "--all"]).status, 2);
  });

  it("rules prints the table with config applied", () => {
    const d = repo();
    write(d, ".commit-guard.json", JSON.stringify({ rules: { "text.typography": "error", "secret.jwt": "off" } }));
    const r = runCli(d, ["rules"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /text\.typography\s+error\s+yes/);
    assert.match(r.stdout, /secret\.jwt\s+error\s+no/);
    assert.match(r.stdout, /path\.personal\s+warn\s+yes/);
  });

  it("rules works outside a git repo", () => {
    const d = tmpDir();
    dirs.push(d);
    assert.equal(runCli(d, ["rules"]).status, 0);
  });
});
