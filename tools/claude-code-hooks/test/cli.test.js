// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { main } from "../src/cli.js";
import { HOOKS, HOOK_NAMES, commandFor, hookScriptPath } from "../src/lib/registry.js";
import { installInto, installedHooks, isOurCommand, readSettings, settingsPath, uninstallFrom } from "../src/lib/settings.js";
import { CLI, mkTmp, payload, rmTmp, testEnv } from "./helpers.js";

/**
 * Run the CLI in-process with captured output and a temp home.
 * @param {string[]} argv
 * @param {{ home: string, cwd: string }} ctx
 */
function cli(argv, ctx) {
  const saved = process.env.CLAUDE_CODE_HOOKS_HOME;
  process.env.CLAUDE_CODE_HOOKS_HOME = ctx.home;
  let out = "";
  let err = "";
  try {
    const code = main(argv, { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, cwd: ctx.cwd });
    return { code, out, err };
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_HOOKS_HOME;
    else process.env.CLAUDE_CODE_HOOKS_HOME = saved;
  }
}

/** @returns {{ home: string, proj: string, done: () => void }} */
function sandbox() {
  const home = mkTmp();
  const proj = mkTmp();
  return {
    home,
    proj,
    done: () => {
      rmTmp(home);
      rmTmp(proj);
    },
  };
}

/** @param {string} file */
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
/** @param {string} dir */
const backups = (dir) => fs.readdirSync(dir).filter((f) => f.includes(".bak-"));

test("install creates the project settings file with all four hooks", () => {
  const s = sandbox();
  try {
    const r = cli(["install"], { home: s.home, cwd: s.proj });
    assert.equal(r.code, 0, r.err);
    const file = path.join(s.proj, ".claude", "settings.json");
    const data = readJson(file);
    assert.equal(data.hooks.PreToolUse.length, 3);
    assert.equal(data.hooks.PostToolUse.length, 1);
    const pf = data.hooks.PreToolUse.find((/** @type {any} */ g) => g.matcher === "Read|Edit|Write|MultiEdit|Bash");
    assert.equal(pf.hooks[0].type, "command");
    assert.match(pf.hooks[0].command, /^node "[^"\\]+\/src\/hooks\/protect-files\.js"$/);
    assert.ok(!pf.hooks[0].command.includes("\\"));
    assert.ok(path.isAbsolute(pf.hooks[0].command.slice(6, -1)));
    assert.deepEqual(readJson(file) && installedHooks(data).sort(), HOOK_NAMES.slice().sort());
    assert.equal(backups(path.dirname(file)).length, 0, "no backup when the file did not exist");
    assert.ok(!fs.existsSync(path.join(s.home, ".claude")), "real home folder untouched");
  } finally {
    s.done();
  }
});

test("install is idempotent and does not back up or rewrite on a second run", () => {
  const s = sandbox();
  try {
    cli(["install"], { home: s.home, cwd: s.proj });
    const file = path.join(s.proj, ".claude", "settings.json");
    const before = fs.readFileSync(file, "utf8");
    const mtime = fs.statSync(file).mtimeMs;
    const r = cli(["install"], { home: s.home, cwd: s.proj });
    assert.equal(r.code, 0);
    assert.match(r.out, /Already installed/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(fs.statSync(file).mtimeMs, mtime);
    assert.equal(backups(path.dirname(file)).length, 0);
  } finally {
    s.done();
  }
});

test("install merges with unrelated settings and hooks, and backs up", () => {
  const s = sandbox();
  try {
    const file = path.join(s.proj, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = {
      model: "opus",
      permissions: { allow: ["Bash(npm test)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/abs/path/to/other-hook.sh" }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
      },
    };
    fs.writeFileSync(file, JSON.stringify(original, null, 2));
    const r = cli(["install"], { home: s.home, cwd: s.proj });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Backed up existing settings/);
    const bak = backups(path.dirname(file));
    assert.equal(bak.length, 1);
    assert.match(bak[0], /^settings\.json\.bak-\d+/);
    assert.deepEqual(readJson(path.join(path.dirname(file), bak[0])), original);
    const data = readJson(file);
    assert.equal(data.model, "opus");
    assert.deepEqual(data.permissions, original.permissions);
    assert.deepEqual(data.hooks.Stop, original.hooks.Stop);
    assert.deepEqual(data.hooks.PreToolUse[0], original.hooks.PreToolUse[0]);
    assert.equal(data.hooks.PreToolUse.length, 4);
  } finally {
    s.done();
  }
});

test("install --hooks installs a subset; a later install adds the rest", () => {
  const s = sandbox();
  try {
    const file = path.join(s.proj, ".claude", "settings.json");
    const r = cli(["install", "--hooks", "guard-bash,auto-format"], { home: s.home, cwd: s.proj });
    assert.equal(r.code, 0);
    assert.deepEqual(installedHooks(readJson(file)).sort(), ["auto-format", "guard-bash"]);
    cli(["install"], { home: s.home, cwd: s.proj });
    assert.equal(installedHooks(readJson(file)).length, 4);
    assert.equal(readJson(file).hooks.PreToolUse.length, 3);
    assert.equal(backups(path.dirname(file)).length, 1);
  } finally {
    s.done();
  }
});

test("install updates a moved script path in place", () => {
  const s = sandbox();
  try {
    const file = path.join(s.proj, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "/old/place/claude-code-hooks/src/hooks/guard-bash.js"' }] }] } }),
    );
    const r = cli(["install", "--hooks", "guard-bash"], { home: s.home, cwd: s.proj });
    assert.match(r.out, /Updated script path/);
    const data = readJson(file);
    assert.equal(data.hooks.PreToolUse.length, 1);
    assert.equal(data.hooks.PreToolUse[0].hooks[0].command, commandFor(HOOKS[2]));
  } finally {
    s.done();
  }
});

test("scopes: user, project and local write to the right files", () => {
  const s = sandbox();
  try {
    for (const scope of ["user", "project", "local"]) {
      const r = cli(["install", "--scope", scope, "--hooks", "guard-bash"], { home: s.home, cwd: s.proj });
      assert.equal(r.code, 0, r.err);
    }
    const files = {
      user: path.join(s.home, ".claude", "settings.json"),
      project: path.join(s.proj, ".claude", "settings.json"),
      local: path.join(s.proj, ".claude", "settings.local.json"),
    };
    for (const f of Object.values(files)) assert.deepEqual(installedHooks(readJson(f)), ["guard-bash"]);
    process.env.CLAUDE_CODE_HOOKS_HOME = s.home;
    try {
      assert.equal(settingsPath("user", "/x"), files.user);
    } finally {
      delete process.env.CLAUDE_CODE_HOOKS_HOME;
    }
    const st = cli(["status", "--json"], { home: s.home, cwd: s.proj });
    const report = JSON.parse(st.out);
    assert.deepEqual(report.map((/** @type {any} */ r) => r.scope), ["user", "project", "local"]);
    assert.ok(report.every((/** @type {any} */ r) => r.hooks["guard-bash"] === true && r.hooks["auto-format"] === false));
    const one = cli(["status", "--scope", "local"], { home: s.home, cwd: s.proj });
    assert.match(one.out, /^local: /);
    assert.match(one.out, /guard-bash\s+installed/);
    assert.match(one.out, /auto-format\s+not installed/);
    assert.ok(!one.out.includes("user:"));
  } finally {
    s.done();
  }
});

test("--project-dir selects another project", () => {
  const s = sandbox();
  const other = mkTmp();
  try {
    const r = cli(["install", "--project-dir", other, "--hooks", "guard-bash"], { home: s.home, cwd: s.proj });
    assert.equal(r.code, 0, r.err);
    assert.ok(fs.existsSync(path.join(other, ".claude", "settings.json")));
    assert.ok(!fs.existsSync(path.join(s.proj, ".claude")));
  } finally {
    s.done();
    rmTmp(other);
  }
});

test("uninstall removes only our entries and leaves others intact", () => {
  const s = sandbox();
  try {
    const file = path.join(s.proj, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const mine = { type: "command", command: "/abs/path/to/mine.sh" };
    fs.writeFileSync(
      file,
      JSON.stringify({
        env: { A: "1" },
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [mine] }],
          Stop: [{ hooks: [mine] }],
        },
      }),
    );
    cli(["install"], { home: s.home, cwd: s.proj });
    // a group that mixes our handler with someone else's
    const data = readJson(file);
    data.hooks.PreToolUse[0].hooks.push({ type: "command", command: commandFor(HOOKS[2]) });
    fs.writeFileSync(file, JSON.stringify(data));
    const r = cli(["uninstall"], { home: s.home, cwd: s.proj });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Removed \(project\)/);
    const after = readJson(file);
    assert.deepEqual(after.env, { A: "1" });
    assert.deepEqual(after.hooks.Stop, [{ hooks: [mine] }]);
    assert.deepEqual(after.hooks.PreToolUse, [{ matcher: "Bash", hooks: [mine] }]);
    assert.equal(after.hooks.PostToolUse, undefined);
    assert.deepEqual(installedHooks(after), []);
  } finally {
    s.done();
  }
});

test("uninstall --hooks removes a subset; removes the hooks key when empty", () => {
  const s = sandbox();
  try {
    const file = path.join(s.proj, ".claude", "settings.json");
    cli(["install"], { home: s.home, cwd: s.proj });
    cli(["uninstall", "--hooks", "guard-bash"], { home: s.home, cwd: s.proj });
    assert.equal(installedHooks(readJson(file)).length, 3);
    cli(["uninstall"], { home: s.home, cwd: s.proj });
    assert.deepEqual(readJson(file), {});
  } finally {
    s.done();
  }
});

test("uninstall with no file or no entries is a no-op", () => {
  const s = sandbox();
  try {
    const r = cli(["uninstall"], { home: s.home, cwd: s.proj });
    assert.equal(r.code, 0);
    assert.match(r.out, /nothing to remove/);
    assert.ok(!fs.existsSync(path.join(s.proj, ".claude")));
    const file = path.join(s.proj, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"a":1}');
    const r2 = cli(["uninstall"], { home: s.home, cwd: s.proj });
    assert.match(r2.out, /No claude-code-hooks entries/);
    assert.equal(backups(path.dirname(file)).length, 0);
  } finally {
    s.done();
  }
});

test("invalid JSON in settings is reported and the file is left alone", () => {
  const s = sandbox();
  try {
    const file = path.join(s.proj, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ nope");
    const r = cli(["install"], { home: s.home, cwd: s.proj });
    assert.equal(r.code, 1);
    assert.match(r.err, /not valid JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "{ nope");
    fs.writeFileSync(file, "[1]");
    assert.equal(cli(["install"], { home: s.home, cwd: s.proj }).code, 1);
    fs.writeFileSync(file, JSON.stringify({ hooks: [] }));
    assert.equal(cli(["install"], { home: s.home, cwd: s.proj }).code, 1);
    fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: {} } }));
    assert.equal(cli(["install"], { home: s.home, cwd: s.proj }).code, 1);
  } finally {
    s.done();
  }
});

test("empty settings file and a BOM are handled", () => {
  const s = sandbox();
  try {
    const file = path.join(s.proj, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    assert.equal(cli(["install", "--hooks", "guard-bash"], { home: s.home, cwd: s.proj }).code, 0);
    fs.writeFileSync(file, "\uFEFF" + JSON.stringify({ x: 1 }));
    assert.equal(cli(["install", "--hooks", "guard-bash"], { home: s.home, cwd: s.proj }).code, 0);
    assert.equal(readJson(file).x, 1);
  } finally {
    s.done();
  }
});

test("backups taken in the same millisecond do not collide", () => {
  const s = sandbox();
  try {
    const file = path.join(s.proj, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}");
    for (const h of HOOK_NAMES) cli(["install", "--hooks", h], { home: s.home, cwd: s.proj });
    assert.equal(backups(path.dirname(file)).length, 4);
  } finally {
    s.done();
  }
});

test("usage errors return exit code 2", () => {
  const s = sandbox();
  try {
    const bad = [
      [],
      ["frobnicate"],
      ["install", "--scope", "galaxy"],
      ["install", "--hooks", "nope"],
      ["install", "--hooks", ","],
      ["install", "extra"],
      ["status", "extra"],
      ["uninstall", "extra"],
      ["install", "--bogus"],
      ["test"],
      ["test", "guard-bash"],
      ["test", "a", "b", "--input", "x"],
      ["test", "nope", "--input", "x.json"],
    ];
    for (const argv of bad) {
      const r = cli(argv, { home: s.home, cwd: s.proj });
      assert.equal(r.code, 2, argv.join(" "));
      assert.match(r.err, /Error:/);
    }
    const h = cli(["--help"], { home: s.home, cwd: s.proj });
    assert.equal(h.code, 0);
    assert.match(h.out, /Usage:/);
    assert.equal(cli(["help"], { home: s.home, cwd: s.proj }).code, 0);
    assert.equal(cli(["-v"], { home: s.home, cwd: s.proj }).out.trim(), "0.1.0");
  } finally {
    s.done();
  }
});

test("test command: deny, ask, allow and exit codes", () => {
  const s = sandbox();
  try {
    const write = (/** @type {string} */ name, /** @type {unknown} */ body) => {
      const f = path.join(s.proj, name);
      fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
      return f;
    };
    const denyFile = write("deny.json", payload("Read", { file_path: "/abs/path/.env" }));
    const r = cli(["test", "protect-files", "--input", denyFile], { home: s.home, cwd: s.proj });
    assert.equal(r.code, 1);
    assert.match(r.out, /decision: deny/);
    assert.match(r.out, /reason: \[claude-code-hooks:protect-files\]/);
    const askFile = write("ask.json", payload("Bash", { command: "git reset --hard" }));
    const a = cli(["test", "guard-bash", "--input", askFile], { home: s.home, cwd: s.proj });
    assert.equal(a.code, 1);
    assert.match(a.out, /decision: ask/);
    const okFile = write("ok.json", payload("Bash", { command: "ls" }));
    const ok = cli(["test", "guard-bash", "--input", okFile], { home: s.home, cwd: s.proj });
    assert.equal(ok.code, 0);
    assert.match(ok.out, /decision: allow/);
    const badFile = write("bad.json", "{ nope");
    const bad = cli(["test", "guard-bash", "--input", badFile], { home: s.home, cwd: s.proj });
    assert.equal(bad.code, 0);
    assert.match(bad.out, /stderr: .*allowing/);
    const missing = cli(["test", "guard-bash", "--input", path.join(s.proj, "none.json")], { home: s.home, cwd: s.proj });
    assert.equal(missing.code, 1);
    assert.match(missing.err, /Cannot read input file/);
  } finally {
    s.done();
  }
});

test("settings helpers: isOurCommand and uninstallFrom on odd shapes", () => {
  assert.ok(isOurCommand('node "C:\\x\\claude-code-hooks\\src\\hooks\\guard-bash.js"'));
  assert.ok(isOurCommand('node "/x/claude-code-hooks/src/hooks/guard-bash.js"', "guard-bash"));
  assert.ok(!isOurCommand('node "/x/claude-code-hooks/src/hooks/guard-bash.js"', "auto-format"));
  assert.ok(!isOurCommand("echo hi"));
  assert.ok(!isOurCommand(undefined));
  assert.deepEqual(uninstallFrom(null, HOOK_NAMES), []);
  assert.deepEqual(uninstallFrom({}, HOOK_NAMES), []);
  assert.deepEqual(uninstallFrom({ hooks: { PreToolUse: "x" } }, HOOK_NAMES), []);
  const odd = { hooks: { PreToolUse: [null, { matcher: "x" }, { hooks: [] }] } };
  assert.deepEqual(uninstallFrom(odd, HOOK_NAMES), []);
  assert.equal(odd.hooks.PreToolUse.length, 3);
  assert.deepEqual(installedHooks(null), []);
  const data = {};
  installInto(data, ["guard-bash"]);
  assert.deepEqual(installedHooks(data), ["guard-bash"]);
  assert.deepEqual(installedHooks({ hooks: { PreToolUse: [null, { hooks: "x" }] } }), []);
  assert.equal(hookScriptPath(HOOKS[0]).includes("\\"), false);
});

test("readSettings rethrows unexpected read errors", () => {
  const dir = mkTmp();
  try {
    assert.throws(() => readSettings(dir));
  } finally {
    rmTmp(dir);
  }
});

test("e2e: the real CLI process, exit codes and a clean home", () => {
  const s = sandbox();
  try {
    const run = (/** @type {string[]} */ args) =>
      spawnSync(process.execPath, [CLI, ...args], { cwd: s.proj, encoding: "utf8", env: testEnv(s.home) });
    const inst = run(["install", "--scope", "project"]);
    assert.equal(inst.status, 0, inst.stderr);
    assert.ok(fs.existsSync(path.join(s.proj, ".claude", "settings.json")));
    const st = run(["status", "--scope", "project"]);
    assert.equal(st.status, 0);
    assert.match(st.stdout, /protect-files\s+installed/);
    const unk = run(["wat"]);
    assert.equal(unk.status, 2);
    assert.match(unk.stderr, /Unknown command/);
    const ver = run(["--version"]);
    assert.equal(ver.status, 0);
    assert.equal(ver.stdout.trim(), "0.1.0");
    const un = run(["uninstall"]);
    assert.equal(un.status, 0);
    assert.ok(!fs.existsSync(path.join(s.home, ".claude")));
  } finally {
    s.done();
  }
});

test("e2e: an installed hook command runs exactly as Claude Code would run it", () => {
  const s = sandbox();
  try {
    cli(["install", "--hooks", "guard-bash"], { home: s.home, cwd: s.proj });
    const data = readJson(path.join(s.proj, ".claude", "settings.json"));
    const command = data.hooks.PreToolUse[0].hooks[0].command;
    const script = command.slice('node "'.length, -1);
    const r = spawnSync(process.execPath, [script], {
      input: JSON.stringify(payload("Bash", { command: "rm -rf /" })),
      encoding: "utf8",
      env: testEnv(s.home),
    });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  } finally {
    s.done();
  }
});
