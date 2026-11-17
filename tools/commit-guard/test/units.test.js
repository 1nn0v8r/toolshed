// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { parseArgs } from "../src/args.js";
import { ConfigError, defaultConfig, loadConfig, resolveRules, validateConfig } from "../src/config.js";
import { parseDiff } from "../src/diff.js";
import { formatFinding, formatJson, formatRules, formatSummary, summarize } from "../src/format.js";
import { globToRegExp, makeMatcher } from "../src/glob.js";
import { MARKER, hookScript } from "../src/hook.js";
import { RULES } from "../src/rules.js";
import { IGNORE_MARKER, isBinary, scanFileRules, scanLines, textToLines } from "../src/scan.js";
import { ELL, fake, rmDir, tmpDir } from "./helpers.js";

describe("parseDiff", () => {
  it("returns real line numbers for added lines across hunks", () => {
    const diff = [
      "diff --git a/src/a.js b/src/a.js",
      "index 111..222 100644",
      "--- a/src/a.js",
      "+++ b/src/a.js",
      "@@ -3,0 +4,2 @@ ctx",
      "+first",
      "+second",
      "@@ -10 +12 @@",
      "-old",
      "+new",
      "\\ No newline at end of file",
      "diff --git a/b.txt b/b.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/b.txt",
      "@@ -0,0 +1,2 @@",
      "+x",
      "++++ looks like a header but is content",
      "",
    ].join("\n");
    const files = parseDiff(diff);
    assert.equal(files.length, 2);
    assert.equal(files[0].path, "src/a.js");
    assert.deepEqual(files[0].added, [
      { line: 4, text: "first" },
      { line: 5, text: "second" },
      { line: 12, text: "new" },
    ]);
    assert.equal(files[1].path, "b.txt");
    assert.deepEqual(files[1].added, [
      { line: 1, text: "x" },
      { line: 2, text: "+++ looks like a header but is content" },
    ]);
  });
  it("skips deleted files and binary files, strips CR", () => {
    const diff = [
      "diff --git a/gone.txt b/gone.txt",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      "diff --git a/w.txt b/w.txt",
      "--- a/w.txt",
      "+++ b/w.txt\t",
      "@@ -0,0 +1 @@",
      "+crlf line\r",
    ].join("\n");
    const files = parseDiff(diff);
    assert.deepEqual(files.map((f) => f.path), ["w.txt"]);
    assert.deepEqual(files[0].added, [{ line: 1, text: "crlf line" }]);
  });
  it("handles quoted paths with escapes and empty input", () => {
    const diff = ['diff --git "a/sp\\"q" "b/sp\\"q"', '+++ "b/sp\\"q\\303\\251\\t"', "@@ -0,0 +1 @@", "+v"].join("\n");
    assert.equal(parseDiff(diff)[0].path, 'sp"q\u00e9\t');
    assert.deepEqual(parseDiff(""), []);
  });
});

describe("globs", () => {
  it("matches names, directories and ** patterns", () => {
    const m = makeMatcher(["*.lock", "dist/", "docs/**/*.md", "/root-only.txt", "src/gen?.js", "a/**"]);
    assert.equal(m("package.lock"), true);
    assert.equal(m("deep/dir/yarn.lock"), true);
    assert.equal(m("dist/x.js"), true);
    assert.equal(m("pkg/dist/x.js"), true);
    assert.equal(m("docs/a/b/c.md"), true);
    assert.equal(m("docs/c.md"), true);
    assert.equal(m("docs/c.txt"), false);
    assert.equal(m("root-only.txt"), true);
    assert.equal(m("sub/root-only.txt"), false);
    assert.equal(m("src/gen1.js"), true);
    assert.equal(m("src/gen12.js"), false);
    assert.equal(m("a\\b\\c"), true);
    assert.equal(m("src/app.js"), false);
  });
  it("escapes regex characters and handles ./ prefix", () => {
    assert.equal(globToRegExp("./a+b(1).txt").test("a+b(1).txt"), true);
    assert.equal(globToRegExp("a.b").test("axb"), false);
  });
  it("supports ** without a slash", () => {
    assert.equal(globToRegExp("src**").test("src/x/y"), true);
  });
});

describe("config", () => {
  it("accepts a full valid config", () => {
    const cfg = validateConfig({
      rules: { "path.personal": "error", "secret.jwt": "off", "text.typography": "warn" },
      allow: ["^FIXTURE_"],
      ignoreFiles: ["fixtures/**"],
      maxFileSizeKB: 10,
    });
    assert.equal(cfg.maxFileSizeKB, 10);
    assert.deepEqual(cfg.allow, ["^FIXTURE_"]);
  });
  const bad = [
    [[], "JSON object"],
    [null, "JSON object"],
    [{ nope: 1 }, "unknown config key"],
    [{ rules: [] }, '"rules" must be an object'],
    [{ rules: { "no.such": "off" } }, "unknown rule id"],
    [{ rules: { "secret.jwt": "maybe" } }, "must be"],
    [{ allow: "x" }, "array of strings"],
    [{ ignoreFiles: [1] }, "array of strings"],
    [{ allow: ["("] }, "invalid regex"],
    [{ maxFileSizeKB: 0 }, "positive"],
    [{ maxFileSizeKB: "big" }, "positive"],
  ];
  for (const [value, text] of bad) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      assert.throws(() => validateConfig(value), (e) => e instanceof ConfigError && String(e.message).includes(String(text)));
    });
  }
  it("loadConfig returns defaults when missing, parses BOM files, and reports errors", () => {
    const dir = tmpDir();
    try {
      assert.deepEqual(loadConfig(dir), defaultConfig());
      fs.writeFileSync(path.join(dir, ".commit-guard.json"), "\uFEFF" + JSON.stringify({ maxFileSizeKB: 5 }));
      assert.equal(loadConfig(dir).maxFileSizeKB, 5);
      fs.writeFileSync(path.join(dir, ".commit-guard.json"), "{ not json");
      assert.throws(() => loadConfig(dir), /not valid JSON/);
      fs.writeFileSync(path.join(dir, ".commit-guard.json"), '{"rules":{"x":"off"}}');
      assert.throws(() => loadConfig(dir), /\.commit-guard\.json: unknown rule id/);
      fs.rmSync(path.join(dir, ".commit-guard.json"));
      fs.mkdirSync(path.join(dir, ".commit-guard.json"));
      assert.throws(() => loadConfig(dir), /cannot read/);
    } finally {
      rmDir(dir);
    }
  });
  it("resolveRules applies off, warn and error levels", () => {
    const rules = resolveRules(
      validateConfig({ rules: { "secret.jwt": "off", "path.personal": "error", "text.typography": "warn" } }),
    );
    const by = Object.fromEntries(rules.map((r) => [r.id, r]));
    assert.equal(by["secret.jwt"].enabled, false);
    assert.equal(by["path.personal"].severity, "error");
    assert.equal(by["text.typography"].enabled, true);
    assert.equal(by["text.typography"].severity, "warn");
    assert.equal(RULES.find((r) => r.id === "secret.jwt")?.enabled, true, "table is not mutated");
  });
});

describe("scan", () => {
  const opts = { rules: resolveRules(defaultConfig()), allow: /** @type {RegExp[]} */ ([]), maxFileSizeKB: 1 };
  it("textToLines handles CRLF, LF, BOM and trailing newline", () => {
    assert.deepEqual(textToLines("a\r\nb\nc"), [
      { line: 1, text: "a" },
      { line: 2, text: "b" },
      { line: 3, text: "c" },
    ]);
    assert.equal(textToLines("\uFEFFx")[0].text, "x");
    assert.equal(textToLines("a\n").length, 2);
    assert.equal(textToLines("").length, 1);
  });
  it("isBinary detects NUL bytes", () => {
    assert.equal(isBinary(Buffer.from([1, 2, 0, 3])), true);
    assert.equal(isBinary(Buffer.from("plain text")), false);
    assert.equal(isBinary(Buffer.alloc(0)), false);
  });
  it("reports line and column", () => {
    const f = scanLines("a.js", [{ line: 7, text: `  k = "${fake.aws()}"` }], opts);
    assert.equal(f.length, 1);
    assert.equal(f[0].line, 7);
    assert.equal(f[0].column, 8);
    assert.equal(f[0].rule, "secret.aws-access-key");
  });
  it("suppresses lines with the inline marker", () => {
    const line = `k = "${fake.aws()}" // ${IGNORE_MARKER}`;
    assert.deepEqual(scanLines("a.js", [{ line: 1, text: line }], opts), []);
  });
  it("suppresses via allow regexes on the line or on the match", () => {
    const text = `FIXTURE_KEY = "${fake.aws()}"`;
    assert.deepEqual(scanLines("a.js", [{ line: 1, text }], { ...opts, allow: [/^FIXTURE_/] }), []);
    assert.deepEqual(scanLines("a.js", [{ line: 1, text }], { ...opts, allow: [/^AKIAQ7/] }), []);
    assert.equal(scanLines("a.js", [{ line: 1, text }], { ...opts, allow: [/nomatch/] }).length, 1);
  });
  it("skips disabled rules", () => {
    const off = resolveRules(validateConfig({ rules: { "secret.aws-access-key": "off" } }));
    assert.deepEqual(scanLines("a.js", [{ line: 1, text: fake.aws() }], { ...opts, rules: off }), []);
  });
  it("typography is off by default and on when enabled", () => {
    const text = `a${ELL}`;
    assert.deepEqual(scanLines("a.md", [{ line: 1, text }], opts), []);
    const on = resolveRules(validateConfig({ rules: { "text.typography": "error" } }));
    const f = scanLines("a.md", [{ line: 1, text }], { ...opts, rules: on });
    assert.equal(f[0].severity, "error");
  });
  it("file rules: env and size", () => {
    assert.equal(scanFileRules(".env", 10, opts)[0].rule, "file.env");
    assert.deepEqual(scanFileRules(".env.example", 10, opts), []);
    const big = scanFileRules("big.bin", 2048, opts);
    assert.equal(big.length, 1);
    assert.equal(big[0].rule, "file.large");
    assert.equal(big[0].severity, "warn");
    assert.deepEqual(scanFileRules("small.txt", 1024, opts), []);
    assert.deepEqual(scanFileRules("unknown-size.txt", undefined, opts), []);
    const none = resolveRules(validateConfig({ rules: { "file.env": "off", "file.large": "off" } }));
    assert.deepEqual(scanFileRules(".env", 99999, { ...opts, rules: none }), []);
  });
});

describe("parseArgs", () => {
  it("parses check variants", () => {
    const r = /** @type {any} */ (parseArgs(["check", "--staged", "--json"]));
    assert.equal(r.parsed.command, "check");
    assert.equal(r.parsed.flags.staged, true);
    assert.equal(r.parsed.flags.json, true);
    assert.deepEqual(/** @type {any} */ (parseArgs(["check", "a.js", "b.js"])).parsed.files, ["a.js", "b.js"]);
    assert.deepEqual(/** @type {any} */ (parseArgs(["check", "--", "--odd"])).parsed.files, ["--odd"]);
    assert.equal(/** @type {any} */ (parseArgs(["install", "--force"])).parsed.flags.force, true);
  });
  it("handles help and version", () => {
    assert.ok("help" in parseArgs(["--help"]));
    assert.ok("help" in parseArgs(["-h"]));
    assert.ok("help" in parseArgs(["help"]));
    assert.ok("version" in parseArgs(["--version"]));
    assert.ok("version" in parseArgs(["-v"]));
  });
  it("rejects bad usage", () => {
    const cases = [
      [[], "missing command"],
      [["nope"], "unknown command"],
      [["check", "--bogus"], "unknown option"],
      [["check", "-x"], "unknown option"],
      [["check", "--force"], "not valid"],
      [["install", "--json"], "not valid"],
      [["install", "file.js"], "does not take file"],
      [["check", "--staged", "--all"], "not both"],
      [["check", "--all", "a.js"], "cannot be combined"],
    ];
    for (const [argv, text] of cases) {
      const r = /** @type {any} */ (parseArgs(/** @type {string[]} */ (argv)));
      assert.ok(r.error && r.error.includes(text), JSON.stringify(argv) + " -> " + JSON.stringify(r));
    }
  });
});

describe("format", () => {
  const findings = [
    { path: "a.js", line: 3, column: 1, severity: /** @type {const} */ ("error"), rule: "secret.jwt", message: "m" },
    { path: "b.js", line: 0, column: 0, severity: /** @type {const} */ ("warn"), rule: "file.large", message: "n" },
  ];
  it("formats lines, summaries and json", () => {
    assert.equal(formatFinding(findings[0]), "a.js:3  error  secret.jwt  m");
    const s = summarize(findings, 2);
    assert.deepEqual(s, { errors: 1, warnings: 1, filesScanned: 2 });
    assert.equal(formatSummary(s), "commit-guard: 1 error, 1 warning (2 files scanned)");
    assert.equal(formatSummary({ errors: 2, warnings: 0, filesScanned: 1 }), "commit-guard: 2 errors, 0 warnings (1 file scanned)");
    assert.equal(formatSummary({ errors: 0, warnings: 0, filesScanned: 0 }), "commit-guard: no problems found (0 files scanned)");
    const j = JSON.parse(formatJson(findings, s));
    assert.equal(j.ok, false);
    assert.equal(j.findings.length, 2);
    assert.equal(JSON.parse(formatJson([], summarize([], 0))).ok, true);
  });
  it("formats the rules table", () => {
    const t = formatRules(resolveRules(defaultConfig()));
    assert.ok(t.split("\n")[0].startsWith("id"));
    assert.ok(/text\.typography\s+warn\s+no\s/.test(t));
  });
});

describe("hookScript", () => {
  it("is POSIX sh with a marker and a quoted forward-slash path", () => {
    const s = hookScript("/abs/path/with space/src/cli.js");
    const lines = s.split("\n");
    assert.equal(lines[0], "#!/bin/sh");
    assert.equal(lines[1], MARKER);
    assert.equal(lines[2], 'exec node "/abs/path/with space/src/cli.js" check --staged');
    assert.ok(!s.includes("\r"));
  });
  it("normalises Windows separators and escapes shell metacharacters", () => {
    const s = hookScript("D:\\tools\\a$b`c\"d\\src\\cli.js");
    assert.ok(s.includes('"D:/tools/a\\$b\\`c\\"d/src/cli.js"'), s);
  });
});
