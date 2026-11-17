// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { run } from "../src/main.js";
import { cli, envWithoutGit, gitCommitAll, gitInit, tmpDir, writeFiles } from "./helpers.js";

// Canary values: built at runtime so no real-looking secret lives in this file.
const CANARY_A = "canary-" + "A".repeat(12);
const CANARY_B = "canary-" + "B".repeat(12);
const CANARY_C = "canary-" + "C".repeat(12);

/**
 * @param {Record<string, string>} files
 * @param {(dir: string) => void | Promise<void>} fn
 * @param {{ git?: boolean }} [opts]
 */
async function withProject(files, fn, opts = {}) {
  const { dir, cleanup } = tmpDir();
  try {
    writeFiles(dir, files);
    if (opts.git) {
      gitInit(dir);
      gitCommitAll(dir);
    }
    await fn(dir);
  } finally {
    cleanup();
  }
}

test("help and version", () => {
  const h = cli(["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /Usage: env-check/);
  assert.equal(cli(["-h"]).code, 0);
  const v = cli(["--version"]);
  assert.equal(v.code, 0);
  assert.match(v.stdout, /^\d+\.\d+\.\d+\n$/);
  assert.equal(cli(["-v"]).stdout, v.stdout);
});

test("clean project exits 0", async () => {
  await withProject({ "a.js": "process.env.A;", ".env.example": "A=\n" }, (dir) => {
    const r = cli([dir]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK/);
  });
});

test("default dir is the current directory", async () => {
  await withProject({ "a.js": "process.env.A;", ".env.example": "A=\n" }, (dir) => {
    assert.equal(cli([], { cwd: dir }).code, 0);
    assert.equal(cli(["."], { cwd: dir }).code, 0);
  });
});

test("missing from example: exit 1 with file:line", async () => {
  await withProject({ "src/a.js": "\nprocess.env.NEEDS_DOC;", ".env.example": "OTHER=\n" }, (dir) => {
    const r = cli([dir]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /NEEDS_DOC {2}src\/a\.js:2/);
    assert.match(r.stdout, /OTHER/);
  });
});

test("unused example keys are reported but only fail in strict mode", async () => {
  await withProject({ "a.js": "process.env.A;", ".env.example": "A=\nSTALE=\n" }, (dir) => {
    const lax = cli([dir]);
    assert.equal(lax.code, 0);
    assert.match(lax.stdout, /never used in code \(1\)/);
    assert.match(lax.stdout, /STALE/);
    const strict = cli([dir, "--strict"]);
    assert.equal(strict.code, 1);
    assert.match(strict.stdout, /error in strict mode/);
  });
});

test("keys missing from a real .env are reported (default .env and --env)", async () => {
  await withProject(
    { "a.js": "process.env.A; process.env.B;", ".env.example": "A=\nB=\n", ".env": "A=1\n", "other.env": "B=1\n" },
    (dir) => {
      const r = cli([dir]);
      assert.equal(r.code, 1);
      assert.match(r.stdout, /missing from \.env \(1\)/);
      assert.match(r.stdout, /^ {2}B$/m);
      const r2 = cli([dir, "--env", "other.env"]);
      assert.equal(r2.code, 1);
      assert.match(r2.stdout, /missing from other\.env/);
      assert.match(r2.stdout, /^ {2}A$/m);
    },
  );
});

test("no .env present means no env comparison", async () => {
  await withProject({ "a.js": "process.env.A;", ".env.example": "A=\n" }, (dir) => {
    const j = JSON.parse(cli([dir, "--json"]).stdout);
    assert.equal(j.envFile, null);
    assert.deepEqual(j.missingInEnv, []);
  });
});

test("dynamic reads are counted and reported", async () => {
  await withProject({ "a.js": "const k='x';\nprocess.env[k];", ".env.example": "" }, (dir) => {
    const r = cli([dir]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /1 dynamic read that could not be checked: a\.js:2/);
  });
});

test("--ignore names and globs (repeatable, also --ignore=)", async () => {
  await withProject({ "a.js": "process.env.FOO; process.env.BAR_1; process.env.BAR_2; process.env.NODE_ENV; process.env.PORT;", ".env.example": "" }, (dir) => {
    const none = JSON.parse(cli([dir, "--json"]).stdout);
    assert.deepEqual(none.missing.map((/** @type {any} */ m) => m.name), ["BAR_1", "BAR_2", "FOO", "PORT"]);
    const r = cli([dir, "--json", "--ignore", "FOO", "--ignore=BAR_*"]);
    assert.deepEqual(JSON.parse(r.stdout).missing.map((/** @type {any} */ m) => m.name), ["PORT"]);
  });
});

test("config file: example, ignore, paths; CLI --example wins", async () => {
  await withProject(
    {
      ".env-check.json": JSON.stringify({ example: "conf.env", ignore: ["IGN"], paths: ["src"] }),
      "src/a.js": "process.env.A; process.env.IGN;",
      "other/b.js": "process.env.NOT_SCANNED;",
      "conf.env": "A=\n",
      "alt.env": "",
    },
    (dir) => {
      const r = cli([dir, "--json"]);
      assert.equal(r.code, 0, r.stdout);
      const j = JSON.parse(r.stdout);
      assert.equal(j.example.file, "conf.env");
      assert.equal(j.scannedFiles, 1);
      const r2 = cli([dir, "--example", "alt.env", "--json"]);
      assert.equal(r2.code, 1);
      assert.deepEqual(JSON.parse(r2.stdout).missing.map((/** @type {any} */ m) => m.name), ["A"]);
    },
  );
});

test("invalid config exits 2", async () => {
  await withProject({ ".env-check.json": "{bad" }, (dir) => {
    const r = cli([dir]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not valid JSON/);
  });
});

test("usage errors exit 2", async () => {
  await withProject({ "a.js": "" }, (dir) => {
    assert.equal(cli(["--nope"]).code, 2);
    assert.equal(cli([dir, "--example"]).code, 2);
    assert.equal(cli([dir, dir]).code, 2);
    const notDir = cli([path.join(dir, "missing-dir")]);
    assert.equal(notDir.code, 2);
    assert.match(notDir.stderr, /not a directory/);
    assert.equal(cli([path.join(dir, "a.js")]).code, 2);
    const ex = cli([dir, "--example", "nope.env"]);
    assert.equal(ex.code, 2);
    assert.match(ex.stderr, /example file not found/);
    const env = cli([dir, "--env", "nope.env"]);
    assert.equal(env.code, 2);
    assert.match(env.stderr, /env file not found/);
    assert.equal(ex.stdout, "");
  });
});

test("missing default example: everything is missing, note is shown", async () => {
  await withProject({ "a.js": "process.env.A;" }, (dir) => {
    const r = cli([dir]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /was not found/);
  });
});

test("--fix appends missing keys, keeps content, and is idempotent (LF)", async () => {
  await withProject({ "a.js": "process.env.ZED; process.env.ALPHA;", ".env.example": "# header\nKEEP=1" }, (dir) => {
    const file = path.join(dir, ".env.example");
    const r = cli([dir, "--fix"]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /Added to \.env\.example \(2\): ALPHA, ZED/);
    const after = fs.readFileSync(file, "utf8");
    assert.equal(after, "# header\nKEEP=1\n\n# Added by env-check\nALPHA=\nZED=\n");
    const again = cli([dir, "--fix"]);
    assert.equal(again.code, 0);
    assert.equal(fs.readFileSync(file, "utf8"), after);
    assert.equal(cli([dir]).code, 0);
  });
});

test("--fix preserves CRLF line endings", async () => {
  await withProject({ "a.js": "process.env.NEWKEY;", ".env.example": "KEEP=1\r\nOTHER=2\r\n" }, (dir) => {
    cli([dir, "--fix"]);
    const after = fs.readFileSync(path.join(dir, ".env.example"), "utf8");
    assert.equal(after, "KEEP=1\r\nOTHER=2\r\n\r\n# Added by env-check\r\nNEWKEY=\r\n");
    assert.ok(!/[^\r]\n/.test(after), "no bare LF introduced");
  });
});

test("--fix creates the example file when it does not exist", async () => {
  await withProject({ "a.js": "process.env.A;" }, (dir) => {
    const r = cli([dir, "--fix"]);
    assert.equal(r.code, 0);
    assert.equal(fs.readFileSync(path.join(dir, ".env.example"), "utf8"), "# Added by env-check\nA=\n");
    const custom = cli([dir, "--fix", "--example", "custom.env"]);
    assert.equal(custom.code, 0);
    assert.ok(fs.existsSync(path.join(dir, "custom.env")));
  });
});

test("--fix still fails for other problems (strict unused, missing in .env)", async () => {
  await withProject({ "a.js": "process.env.A;", ".env.example": "STALE=\n", ".env": "STALE=1\n" }, (dir) => {
    assert.equal(cli([dir, "--fix", "--strict"]).code, 1);
  });
});

test("--fix with nothing missing does not touch the file", async () => {
  await withProject({ "a.js": "process.env.A;", ".env.example": "A=\n" }, (dir) => {
    const file = path.join(dir, ".env.example");
    const before = fs.statSync(file).mtimeMs;
    cli([dir, "--fix"]);
    assert.equal(fs.statSync(file).mtimeMs, before);
  });
});

test("--json output is valid and complete", async () => {
  await withProject({ "a.js": "process.env.NEW1;\nprocess.env[k];", ".env.example": "OLD=\n", ".env": "OLD=1\n" }, (dir) => {
    const r = cli([dir, "--json", "--strict"]);
    assert.equal(r.code, 1);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false);
    assert.equal(j.strict, true);
    assert.equal(j.mode, "walk");
    assert.deepEqual(j.missing, [{ name: "NEW1", locations: [{ file: "a.js", line: 1 }] }]);
    assert.deepEqual(j.unused, ["OLD"]);
    assert.deepEqual(j.dynamic, { count: 1, locations: [{ file: "a.js", line: 2 }] });
    assert.deepEqual(j.envFile, { file: ".env", found: true });
    assert.deepEqual(j.fixed, []);
  });
});

test("git mode respects .gitignore and includes untracked files", async () => {
  await withProject(
    { ".gitignore": "ignored/\n", "tracked.js": "process.env.TRACKED;", "ignored/x.js": "process.env.IGNORED;", ".env.example": "TRACKED=\nUNTRACKED=\n" },
    (dir) => {
      writeFiles(dir, { "later.js": "process.env.UNTRACKED;" });
      const j = JSON.parse(cli([dir, "--json"]).stdout);
      assert.equal(j.mode, "git");
      assert.equal(j.ok, true, JSON.stringify(j));
      assert.equal(j.scannedFiles, 2);
    },
    { git: true },
  );
});

test("git mode works from a subdirectory and a deleted tracked file is skipped", async () => {
  await withProject(
    { "pkg/a.js": "process.env.PKG;", "pkg/.env.example": "PKG=\n", "gone.js": "process.env.GONE;" },
    (dir) => {
      fs.rmSync(path.join(dir, "gone.js"));
      const r = cli([path.join(dir, "pkg"), "--json"]);
      assert.equal(JSON.parse(r.stdout).mode, "git");
      assert.equal(r.code, 0);
      assert.equal(cli([dir, "--json"]).code, 1, "GONE is no longer scanned but PKG is undocumented at the root");
    },
    { git: true },
  );
});

test("falls back to a directory walk when git is not installed", async () => {
  await withProject({ ".gitignore": "x\n", "a.js": "process.env.A;", ".env.example": "A=\n", "node_modules/m/i.js": "process.env.DEP;" }, (dir) => {
    gitInit(dir);
    const r = cli([dir, "--json"], { env: envWithoutGit() });
    const j = JSON.parse(r.stdout);
    assert.equal(j.mode, "walk");
    assert.equal(j.ok, true, r.stdout + r.stderr);
  });
});

test("non-git folder uses a directory walk and skips default excludes", async () => {
  await withProject({ "a.py": 'os.environ["PYV"]', "venv/.venv/x.py": 'os.environ["SKIP"]', ".env.example": "PYV=\n" }, (dir) => {
    const j = JSON.parse(cli([dir, "--json"]).stdout);
    assert.equal(j.mode, "walk");
    assert.equal(j.ok, true);
  });
});

test("files over 2 MB are skipped and reported", async () => {
  await withProject({ "big.js": "x".repeat(2 * 1024 * 1024 + 10), ".env.example": "" }, (dir) => {
    const r = cli([dir]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Skipped 1 file larger than 2 MB/);
  });
});

test("every supported language end to end", async () => {
  await withProject(
    {
      "a.ts": 'process.env.L_JS; import.meta.env.L_VITE; Deno.env.get("L_DENO"); Bun.env.L_BUN; const { L_DESTR } = process.env;',
      "a.py": 'os.getenv("L_PY")',
      "a.go": 'os.Getenv("L_GO")',
      "a.rb": 'ENV["L_RB"]',
      "a.php": "getenv('L_PHP')",
      "a.rs": 'env::var("L_RS")',
      "docker-compose.yml": "x: ${L_COMPOSE:-d}",
      ".env.example": "",
    },
    (dir) => {
      const j = JSON.parse(cli([dir, "--json"]).stdout);
      assert.deepEqual(
        j.missing.map((/** @type {any} */ m) => m.name),
        ["L_BUN", "L_COMPOSE", "L_DENO", "L_DESTR", "L_GO", "L_JS", "L_PHP", "L_PY", "L_RB", "L_RS", "L_VITE"],
      );
    },
  );
});

test("values from .env and .env.example never appear in any output", async () => {
  await withProject(
    {
      "a.js": "process.env.KEY_A; process.env.KEY_B; process.env.KEY_NEW;",
      ".env.example": `KEY_A=${CANARY_A}\nKEY_B="${CANARY_B}"\nKEY_STALE='${CANARY_C}'\n`,
      ".env": `KEY_A=${CANARY_A}\nexport KEY_B="${CANARY_B}"\nKEY_EXTRA=${CANARY_C}\n`,
    },
    (dir) => {
      const canaries = [CANARY_A, CANARY_B, CANARY_C];
      for (const args of [[dir], [dir, "--json"], [dir, "--strict"], [dir, "--json", "--strict"], [dir, "--fix"], [dir, "--env", ".env", "--json"], [dir, "--example", ".env"], [dir, "--env", ".env.example"]]) {
        const r = cli(args);
        for (const c of canaries) {
          assert.ok(!r.stdout.includes(c), `stdout leaked a value for ${args.join(" ")}`);
          assert.ok(!r.stderr.includes(c), `stderr leaked a value for ${args.join(" ")}`);
        }
      }
    },
  );
});

test("run(): captured io for success and usage errors", async () => {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  assert.equal(await run(["--bogus"], { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }), 2);
  assert.match(err.join(""), /Run "env-check --help"/);
  await withProject({ "a.js": "process.env.A;", ".env.example": "A=\n" }, async (dir) => {
    assert.equal(await run(["."], { cwd: dir, stdout: (s) => out.push(s) }), 0);
  });
  assert.ok(out.join("").includes("OK"));
});

test("run(): a non-usage failure maps to exit 2 without a stack trace", async () => {
  await withProject({ "a.js": "process.env.A;", ".env.example": "A=\n" }, async (dir) => {
    // The example path is a directory: it "exists" as a path but cannot be read as a file.
    fs.mkdirSync(path.join(dir, "exdir"));
    fs.writeFileSync(path.join(dir, ".env-check.json"), JSON.stringify({ example: "exdir" }));
    /** @type {string[]} */
    const err = [];
    const code = await run(["--fix"], { cwd: dir, stderr: (s) => err.push(s) });
    assert.equal(code, 2);
    assert.match(err.join(""), /env-check: /);
    assert.ok(!err.join("").includes("    at "));
  });
});
