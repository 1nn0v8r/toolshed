// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { compare, makeIgnore } from "../src/check.js";
import { loadConfig, UsageError } from "../src/config.js";
import { parseEnvKeys } from "../src/envfile.js";
import { listFiles, restrictToPaths } from "../src/files.js";
import { appendKeys, fixExampleFile } from "../src/fix.js";
import { formatJson, formatText } from "../src/report.js";
import { tmpDir, writeFiles } from "./helpers.js";

test("parseEnvKeys: plain, export, comments, blanks, spaces", () => {
  const keys = parseEnvKeys("# c\n\nA=1\nexport B=2\n  C = 3\nD=\n#E=5\nnot a pair\n1BAD=x\n").map((k) => k.key);
  assert.deepEqual(keys, ["A", "B", "C", "D"]);
});

test("parseEnvKeys: CRLF and old Mac line endings, BOM", () => {
  assert.deepEqual(parseEnvKeys("﻿A=1\r\nB=2\r\n").map((k) => k.key), ["A", "B"]);
  assert.deepEqual(parseEnvKeys("A=1\rB=2\r").map((k) => k.key), ["A", "B"]);
});

test("parseEnvKeys: quoted values, including multi-line and embedded =", () => {
  const text = 'A="x=1"\nB=\'y\'\nC="line one\nINSIDE=notakey\nline three"\nD=`t`\nE="esc \\" still\nF2=inside"\nG=ok\n';
  assert.deepEqual(parseEnvKeys(text).map((k) => k.key), ["A", "B", "C", "D", "E", "G"]);
});

test("parseEnvKeys: unterminated quote consumes the rest without throwing", () => {
  assert.deepEqual(parseEnvKeys('A="never closed\nB=2').map((k) => k.key), ["A"]);
});

test("parseEnvKeys: records line numbers and never exposes values", () => {
  const keys = parseEnvKeys("\nA=secretvalue\n");
  assert.deepEqual(keys, [{ key: "A", line: 2 }]);
  assert.ok(!JSON.stringify(keys).includes("secretvalue"));
});

test("makeIgnore: built-ins, exact names, globs; PORT is not ignored", () => {
  const ig = makeIgnore(["MY_*", "EXACT", "A?C"]);
  for (const n of ["NODE_ENV", "PATH", "HOME", "CI", "MY_THING", "EXACT", "ABC"]) assert.equal(ig(n), true, n);
  for (const n of ["PORT", "EXACTLY", "AC", "OTHER", "XMY_THING"]) assert.equal(ig(n), false, n);
  assert.equal(makeIgnore(["a.b"])("aXb"), false);
});

test("compare: missing, unused, missingInEnv and ignores", () => {
  const used = new Map([
    ["B", [{ file: "x.js", line: 1 }]],
    ["A", [{ file: "y.js", line: 2 }]],
    ["NODE_ENV", [{ file: "x.js", line: 3 }]],
    ["SKIP_ME", [{ file: "x.js", line: 4 }]],
  ]);
  const r = compare(used, new Set(["A", "OLD", "STALE_IGNORED"]), new Set(["A"]), makeIgnore(["SKIP_ME", "STALE_*"]));
  assert.deepEqual(r.missing.map((m) => m.name), ["B"]);
  assert.deepEqual(r.unused, ["OLD"]);
  assert.deepEqual(r.missingInEnv, ["OLD"]);
  assert.deepEqual(compare(used, new Set(["A"]), null, () => false).missingInEnv, []);
});

test("loadConfig: missing, valid, and every kind of invalid", () => {
  const { dir, cleanup } = tmpDir();
  try {
    assert.deepEqual(loadConfig(dir), {});
    const write = (/** @type {string} */ s) => fs.writeFileSync(path.join(dir, ".env-check.json"), s);
    write('﻿{"example":"x.env","ignore":["A"],"paths":["src"]}');
    assert.deepEqual(loadConfig(dir), { example: "x.env", ignore: ["A"], paths: ["src"] });
    for (const bad of ["{nope", "[]", "null", '{"example":3}', '{"example":""}', '{"ignore":"A"}', '{"paths":[1]}']) {
      write(bad);
      assert.throws(() => loadConfig(dir), UsageError, bad);
    }
    fs.rmSync(path.join(dir, ".env-check.json"));
    fs.mkdirSync(path.join(dir, ".env-check.json"));
    assert.throws(() => loadConfig(dir), UsageError);
  } finally {
    cleanup();
  }
});

test("appendKeys: LF, CRLF, no trailing newline, empty file, preserves content", () => {
  assert.equal(appendKeys("A=1\n", ["B", "C"]), "A=1\n\n# Added by env-check\nB=\nC=\n");
  assert.equal(appendKeys("A=1\r\nB=2\r\n", ["C"]), "A=1\r\nB=2\r\n\r\n# Added by env-check\r\nC=\r\n");
  assert.equal(appendKeys("A=1", ["B"]), "A=1\n\n# Added by env-check\nB=\n");
  assert.equal(appendKeys("A=1\r\nB=2", ["C"]), "A=1\r\nB=2\r\n\r\n# Added by env-check\r\nC=\r\n");
  assert.equal(appendKeys("", ["B"]), "# Added by env-check\nB=\n");
});

test("fixExampleFile: writes, creates missing file, no-op for no keys, rethrows other errors", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const f = path.join(dir, ".env.example");
    assert.equal(fixExampleFile(f, []), false);
    assert.equal(fs.existsSync(f), false);
    assert.equal(fixExampleFile(f, ["A"]), true);
    assert.equal(fs.readFileSync(f, "utf8"), "# Added by env-check\nA=\n");
    assert.throws(() => fixExampleFile(dir, ["A"]));
  } finally {
    cleanup();
  }
});

test("restrictToPaths", () => {
  const files = ["a.js", "src/b.js", "src/deep/c.js", "srcx/d.js", "lib/e.js"];
  assert.deepEqual(restrictToPaths(files, ["src"]), ["src/b.js", "src/deep/c.js"]);
  assert.deepEqual(restrictToPaths(files, ["./src/", "a.js"]), ["a.js", "src/b.js", "src/deep/c.js"]);
  assert.deepEqual(restrictToPaths(files, ["src\\deep"]), ["src/deep/c.js"]);
  assert.deepEqual(restrictToPaths(files, []), files);
  assert.deepEqual(restrictToPaths(files, ["."]), files);
});

test("listFiles: walk mode applies default excludes and skips unreadable dirs", async () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFiles(dir, {
      "a.js": "",
      "src/b.js": "",
      "node_modules/x/i.js": "",
      ".git/h.js": "",
      "dist/d.js": "",
      "build/d.js": "",
      "coverage/d.js": "",
      "vendor/d.js": "",
      ".venv/d.py": "",
    });
    const r = await listFiles(dir);
    assert.equal(r.mode, "walk");
    assert.deepEqual(r.files, ["a.js", "src/b.js"]);
  } finally {
    cleanup();
  }
});

/** @type {import("../src/report.js").Result} */
const base = {
  dir: ".",
  example: { file: ".env.example", found: true },
  envFile: null,
  scannedFiles: 1,
  skippedLargeFiles: 0,
  mode: "git",
  strict: false,
  missing: [],
  unused: [],
  missingInEnv: [],
  dynamic: [],
  fixed: [],
  ok: true,
};

test("formatText: clean, singular and plural wording", () => {
  assert.match(formatText(base), /scanned 1 file \(git\)/);
  assert.match(formatText(base), /OK\n$/);
  assert.match(formatText({ ...base, scannedFiles: 2, mode: "walk" }), /scanned 2 files \(directory walk\)/);
});

test("formatText: every section", () => {
  const locs = Array.from({ length: 7 }, (_, i) => ({ file: "f.js", line: i + 1 }));
  const text = formatText({
    ...base,
    ok: false,
    strict: true,
    example: { file: ".env.example", found: false },
    envFile: { file: ".env", found: true },
    missing: [{ name: "NEW_VAR", locations: locs }],
    unused: ["OLD"],
    missingInEnv: ["LOCAL"],
    dynamic: [{ file: "g.js", line: 9 }],
    skippedLargeFiles: 2,
  });
  assert.match(text, /Note: \.env\.example was not found/);
  assert.match(text, /missing from \.env\.example \(1\)/);
  assert.match(text, /NEW_VAR {2}f\.js:1, f\.js:2, f\.js:3, f\.js:4, f\.js:5 \(\+2 more\)/);
  assert.match(text, /never used in code \(1, error in strict mode\)/);
  assert.match(text, /missing from \.env \(1\)/);
  assert.match(text, /1 dynamic read that could not be checked: g\.js:9/);
  assert.match(text, /Skipped 2 files larger than 2 MB/);
  assert.match(text, /Problems found\./);
  assert.match(formatText({ ...base, dynamic: [{ file: "a", line: 1 }, { file: "b", line: 2 }] }), /2 dynamic reads/);
  assert.match(formatText({ ...base, skippedLargeFiles: 1 }), /Skipped 1 file larger/);
  assert.match(formatText({ ...base, fixed: ["Z"] }), /Added to \.env\.example \(1\): Z/);
});

test("formatJson: shape", () => {
  const parsed = JSON.parse(formatJson({ ...base, dynamic: [{ file: "a.js", line: 1 }] }));
  assert.deepEqual(parsed.dynamic, { count: 1, locations: [{ file: "a.js", line: 1 }] });
  assert.equal(parsed.ok, true);
});

test("makeIgnore: OS built-ins match case-insensitively, user patterns stay case-sensitive", () => {
  const ignored = makeIgnore(["MyVar"]);
  for (const name of ["PATHEXT", "ProgramFiles", "ProgramW6432", "ProgramFiles(x86)", "windir", "SystemRoot", "XDG_CONFIG_HOME", "path"]) {
    assert.equal(ignored(name), true, name);
  }
  assert.equal(ignored("MyVar"), true);
  assert.equal(ignored("MYVAR"), false);
  assert.equal(ignored("DATABASE_URL"), false);
  assert.equal(ignored("PORT"), false);
});
