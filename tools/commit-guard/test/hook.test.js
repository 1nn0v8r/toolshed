// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { run } from "../src/main.js";
import { CLI, commit, fake, git, makeRepo, rmDir, runCli, stage, tmpDir, write } from "./helpers.js";

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

/** @param {string} d @param {string} [rel] */
const hookPath = (d, rel = ".git/hooks/pre-commit") => path.join(d, rel);

describe("install and uninstall", () => {
  it("installs a POSIX sh hook that points at this cli.js", () => {
    const d = repo();
    const r = runCli(d, ["install"]);
    assert.equal(r.status, 0, r.stderr);
    const text = fs.readFileSync(hookPath(d), "utf8");
    assert.ok(text.startsWith("#!/bin/sh\n"));
    assert.ok(text.includes("commit-guard-hook"));
    assert.ok(text.includes(`exec node "${CLI.replace(/\\/g, "/")}" check --staged`));
    assert.ok(!text.includes("\r"));
    if (process.platform !== "win32") assert.equal(fs.statSync(hookPath(d)).mode & 0o777, 0o755);
  });

  it("is idempotent for our own hook", () => {
    const d = repo();
    assert.equal(runCli(d, ["install"]).status, 0);
    assert.equal(runCli(d, ["install"]).status, 0);
    assert.equal(fs.readdirSync(path.join(d, ".git", "hooks")).filter((f) => f.includes("backup")).length, 0);
  });

  it("refuses to overwrite a foreign hook, then backs it up with --force", () => {
    const d = repo();
    fs.mkdirSync(path.join(d, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(hookPath(d), "#!/bin/sh\necho mine\n");
    let r = runCli(d, ["install"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--force/);
    assert.equal(fs.readFileSync(hookPath(d), "utf8"), "#!/bin/sh\necho mine\n");
    r = runCli(d, ["install", "--force"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /backup/);
    assert.equal(fs.readFileSync(hookPath(d) + ".commit-guard-backup", "utf8"), "#!/bin/sh\necho mine\n");
    assert.ok(fs.readFileSync(hookPath(d), "utf8").includes("commit-guard-hook"));
  });

  it("keeps earlier backups when forcing twice over foreign hooks", () => {
    const d = repo();
    fs.mkdirSync(path.join(d, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(hookPath(d), "#!/bin/sh\necho one\n");
    runCli(d, ["install", "--force"]);
    fs.writeFileSync(hookPath(d), "#!/bin/sh\necho two\n");
    runCli(d, ["install", "--force"]);
    assert.equal(fs.readFileSync(hookPath(d) + ".commit-guard-backup", "utf8"), "#!/bin/sh\necho one\n");
    assert.equal(fs.readFileSync(hookPath(d) + ".commit-guard-backup.1", "utf8"), "#!/bin/sh\necho two\n");
  });

  it("uninstall removes only our hook", () => {
    const d = repo();
    assert.equal(runCli(d, ["uninstall"]).status, 0, "nothing installed is fine");
    runCli(d, ["install"]);
    const r = runCli(d, ["uninstall"]);
    assert.equal(r.status, 0);
    assert.ok(!fs.existsSync(hookPath(d)));
    fs.writeFileSync(hookPath(d), "#!/bin/sh\necho mine\n");
    const r2 = runCli(d, ["uninstall"]);
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /not installed by commit-guard/);
    assert.ok(fs.existsSync(hookPath(d)));
  });

  it("install and uninstall outside a repo exit 2", () => {
    const d = tmpDir();
    dirs.push(d);
    assert.equal(runCli(d, ["install"]).status, 2);
    assert.equal(runCli(d, ["uninstall"]).status, 2);
  });

  it("installs into a relative core.hooksPath", () => {
    const d = repo();
    git(d, ["config", "core.hooksPath", ".githooks"]);
    const r = runCli(d, ["install"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(hookPath(d, ".githooks/pre-commit")));
    assert.ok(!fs.existsSync(hookPath(d)));
    assert.equal(runCli(d, ["uninstall"]).status, 0);
    assert.ok(!fs.existsSync(hookPath(d, ".githooks/pre-commit")));
  });

  it("installs into an absolute core.hooksPath", () => {
    const d = repo();
    const hooks = tmpDir("commit-guard-hooks-");
    dirs.push(hooks);
    git(d, ["config", "core.hooksPath", hooks]);
    assert.equal(runCli(d, ["install"]).status, 0);
    assert.ok(fs.existsSync(path.join(hooks, "pre-commit")));
  });

  it("works from a subdirectory", () => {
    const d = repo();
    fs.mkdirSync(path.join(d, "sub"));
    assert.equal(runCli(path.join(d, "sub"), ["install"]).status, 0);
    assert.ok(fs.existsSync(hookPath(d)));
  });
});

describe("the installed hook in real commits", () => {
  it("blocks a commit with a secret, allows a clean commit, stops after uninstall", () => {
    const d = repo();
    assert.equal(runCli(d, ["install"]).status, 0);

    // blocked
    const secret = fake.aws();
    write(d, "bad.js", `const k = "${secret}";\n`);
    stage(d, "bad.js");
    const blocked = commit(d, "bad");
    assert.notEqual(blocked.status, 0);
    const out = blocked.stdout + blocked.stderr;
    assert.match(out, /bad\.js:1  error  secret\.aws-access-key/);
    assert.ok(!out.includes(secret));
    assert.notEqual(git(d, ["rev-parse", "--verify", "HEAD"]).status, 0, "no commit was created");

    // clean commit succeeds
    git(d, ["reset", "-q"]);
    fs.rmSync(path.join(d, "bad.js"));
    write(d, "good.js", "export const ok = true;\n");
    stage(d, "good.js");
    const ok = commit(d, "good");
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal(git(d, ["rev-parse", "--verify", "HEAD"]).status, 0);

    // warnings alone do not block
    write(d, "big.txt", "a".repeat(1024 * 1024 + 5));
    stage(d, "big.txt");
    assert.equal(commit(d, "big").status, 0);

    // .env is blocked
    write(d, ".env", "A=1\n");
    stage(d, ".env");
    assert.notEqual(commit(d, "env").status, 0);
    git(d, ["reset", "-q"]);

    // uninstall then the same bad commit goes through
    assert.equal(runCli(d, ["uninstall"]).status, 0);
    write(d, "bad.js", `const k = "${secret}";\n`);
    stage(d, "bad.js");
    assert.equal(commit(d, "bad again").status, 0);
  });

  it("--no-verify bypasses the hook", () => {
    const d = repo();
    runCli(d, ["install"]);
    write(d, "bad.js", `const k = "${fake.aws()}";\n`);
    stage(d, "bad.js");
    const r = git(d, [
      "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false",
      "commit", "-q", "--no-verify", "-m", "x",
    ]);
    assert.equal(r.status, 0);
  });

  it("works with a hook installed through core.hooksPath", () => {
    const d = repo();
    git(d, ["config", "core.hooksPath", ".githooks"]);
    runCli(d, ["install"]);
    write(d, "bad.js", `const k = "${fake.ghp()}";\n`);
    stage(d, "bad.js");
    assert.notEqual(commit(d).status, 0);
    git(d, ["reset", "-q"]);
    write(d, "good.js", "ok\n");
    stage(d, "good.js");
    assert.equal(commit(d).status, 0);
  });

  it("only checks the new lines on later commits", () => {
    const d = repo();
    write(d, "a.txt", `old = "${fake.aws()}"\n`);
    stage(d, "a.txt");
    assert.equal(commit(d, "before hook").status, 0);
    runCli(d, ["install"]);
    write(d, "a.txt", `old = "${fake.aws()}"\nnew line\n`);
    stage(d, "a.txt");
    assert.equal(commit(d, "touch").status, 0);
  });
});

describe("in-process run()", () => {
  /** @param {string} cwd @param {string[]} argv */
  function exec(cwd, argv) {
    let out = "";
    let err = "";
    const code = run(argv, { cwd, out: (s) => (out += s), err: (s) => (err += s), cliPath: "/abs/path/to/src/cli.js" });
    return { code, out, err };
  }
  it("uses the injected cliPath when installing", () => {
    const d = repo();
    assert.equal(exec(d, ["install"]).code, 0);
    assert.ok(fs.readFileSync(hookPath(d), "utf8").includes('"/abs/path/to/src/cli.js"'));
  });
  it("reports usage errors on stderr", () => {
    const r = exec(tmpDir(), ["wat"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown command/);
  });
  it("checks staged content", () => {
    const d = repo();
    write(d, "a.js", `k = "${fake.slack()}"\n`);
    stage(d, "a.js");
    const r = exec(d, ["check"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /secret\.slack-token/);
  });
  it("reports a missing git binary as exit 2", () => {
    const saved = process.env.PATH;
    const savedWin = process.env.Path;
    const d = repo();
    try {
      process.env.PATH = "";
      process.env.Path = "";
      const r = exec(d, ["check"]);
      assert.equal(r.code, 2);
      assert.match(r.err, /git was not found/);
    } finally {
      process.env.PATH = saved;
      if (savedWin !== undefined) process.env.Path = savedWin;
    }
  });
});
