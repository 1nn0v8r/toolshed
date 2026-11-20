// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run } from "../src/main.js";

/**
 * Creates an in-memory or temporary project directory.
 *
 * @param {Record<string, string>} files
 * @returns {string} temp directory path
 */
function createFixture(files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dep-check-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(tmp, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }
  return tmp;
}

test("cli: --help displays help and exits 0", async () => {
  let out = "";
  const code = await run(["--help"], {
    stdout: (s) => { out += s; }
  });
  assert.equal(code, 0);
  assert.match(out, /Usage: dep-check/);
});

test("cli: --version displays version and exits 0", async () => {
  let out = "";
  const code = await run(["--version"], {
    stdout: (s) => { out += s; }
  });
  assert.equal(code, 0);
  assert.match(out, /^0\.1\.0/);
});

test("cli: missing package.json exits 2 with error", async () => {
  let err = "";
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-check-empty-"));
  const code = await run([], {
    cwd: emptyDir,
    stderr: (s) => { err += s; }
  });
  assert.equal(code, 2);
  assert.match(err, /package\.json not found/);
});

test("cli: clean project exits 0", async () => {
  const dir = createFixture({
    "package.json": JSON.stringify({
      dependencies: {
        chalk: "^5.0.0"
      }
    }),
    "src/index.js": 'import chalk from "chalk"; console.log(chalk.blue("hello"));'
  });

  let out = "";
  const code = await run([], {
    cwd: dir,
    stdout: (s) => { out += s; }
  });

  assert.equal(code, 0);
  assert.match(out, /all dependencies look clean/);
});

test("cli: missing dependency exits 1 by default", async () => {
  const dir = createFixture({
    "package.json": JSON.stringify({
      dependencies: {}
    }),
    "src/index.js": 'import uninstalled from "uninstalled-pkg";'
  });

  let out = "";
  const code = await run([], {
    cwd: dir,
    stdout: (s) => { out += s; }
  });

  assert.equal(code, 1);
  assert.match(out, /Missing dependencies/);
  assert.match(out, /uninstalled-pkg/);
});

test("cli: unused dependency exits 0 by default, exits 1 with --fail-on-unused", async () => {
  const dir = createFixture({
    "package.json": JSON.stringify({
      dependencies: {
        unused: "^1.0.0"
      }
    }),
    "src/index.js": 'console.log("nothing imported");'
  });

  let out1 = "";
  const code1 = await run([], {
    cwd: dir,
    stdout: (s) => { out1 += s; }
  });
  assert.equal(code1, 0);
  assert.match(out1, /Unused dependencies/);

  let out2 = "";
  const code2 = await run(["--fail-on-unused"], {
    cwd: dir,
    stdout: (s) => { out2 += s; }
  });
  assert.equal(code2, 1);
  assert.match(out2, /Unused dependencies/);
});

test("cli: --ignore suppresses warnings for specified package", async () => {
  const dir = createFixture({
    "package.json": JSON.stringify({
      dependencies: {
        ignoredPkg: "^1.0.0",
        anotherIgnored: "^1.0.0"
      }
    }),
    "src/index.js": 'console.log("nothing");'
  });

  let out = "";
  const code = await run(["--ignore", "ignoredPkg,anotherIgnored"], {
    cwd: dir,
    stdout: (s) => { out += s; }
  });

  assert.equal(code, 0);
  assert.match(out, /all dependencies look clean/);
});

test("cli: --json emits parseable JSON report", async () => {
  const dir = createFixture({
    "package.json": JSON.stringify({
      dependencies: {
        foo: "^1.0.0"
      }
    }),
    "src/index.js": 'import foo from "foo";'
  });

  let out = "";
  const code = await run(["--json"], {
    cwd: dir,
    stdout: (s) => { out += s; }
  });

  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.scannedFilesCount, 1);
  assert.equal(parsed.missingDependencies.length, 0);
});
