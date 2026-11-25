// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run } from "../src/main.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

/**
 * Create an isolated temporary project directory cleaned up after test.
 * @param {import("node:test").TestContext} t
 * @returns {string}
 */
function makeTempProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rules-sync-test-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * Invoke run() and capture stdout/stderr/exitCode.
 * @param {string[]} argv
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function execCli(argv) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const code = await run(argv, {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

test("help and version flags exit 0", async () => {
  const h = await execCli(["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /Usage:/);

  const v = await execCli(["--version"]);
  assert.equal(v.code, 0);
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("init creates starter AGENTS.md and .agent-rules.json, respects dry-run and force", async (t) => {
  const dir = makeTempProject(t);

  const dry = await execCli(["init", dir, "--dry-run", "--json"]);
  assert.equal(dry.code, 0);
  const dryJson = JSON.parse(dry.stdout);
  assert.equal(dryJson.dryRun, true);
  assert.equal(fs.existsSync(path.join(dir, ".agent-rules.json")), false);

  const res = await execCli(["init", dir]);
  assert.equal(res.code, 0);
  assert.equal(fs.existsSync(path.join(dir, "AGENTS.md")), true);
  assert.equal(fs.existsSync(path.join(dir, ".agent-rules.json")), true);

  const second = await execCli(["init", dir]);
  assert.equal(second.code, 2);

  const forced = await execCli(["init", dir, "--force", "--mode", "pointer"]);
  assert.equal(forced.code, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".agent-rules.json"), "utf8"));
  assert.equal(cfg.mode, "pointer");
});

test("init seeds AGENTS.md from existing CLAUDE.md when AGENTS.md is missing", async (t) => {
  const dir = makeTempProject(t);
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Existing Claude Rules\nRun `pnpm test`.\n", "utf8");

  const res = await execCli(["init", dir, "--json"]);
  assert.equal(res.code, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.createdSource, true);
  assert.equal(data.seededFrom, "CLAUDE.md");
  assert.match(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /Existing Claude Rules/);
});

test("sync copy mode writes targets, generates Cursor .mdc frontmatter, and preserves custom notes", async (t) => {
  const dir = makeTempProject(t);
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    "# Repo Rules\n\nUse `npm test` to run tests.\n",
    "utf8",
  );
  // Pre-existing CLAUDE.md with user notes and CRLF
  fs.writeFileSync(
    path.join(dir, "CLAUDE.md"),
    "<!-- agent-rules-sync:start -->\r\nold\r\n<!-- agent-rules-sync:end -->\r\n\r\n## Claude-Only\r\nKeep this section.\r\n",
    "utf8",
  );

  const syncRes = await execCli([
    "sync",
    dir,
    "--targets",
    "claude,copilot,cursor,gemini",
  ]);
  assert.equal(syncRes.code, 0);

  const claudeText = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
  assert.ok(claudeText.includes("\r\n"), "preserves CRLF line endings");
  assert.match(claudeText, /Use `npm test` to run tests\./);
  assert.match(claudeText, /## Claude-Only/);
  assert.match(claudeText, /Keep this section\./);

  const mdcText = fs.readFileSync(path.join(dir, ".cursor/rules/project.mdc"), "utf8");
  assert.match(mdcText, /^---\n[\s\S]*alwaysApply: true\n---/);
  assert.match(mdcText, /Use `npm test` to run tests\./);

  const copilotText = fs.readFileSync(path.join(dir, ".github/copilot-instructions.md"), "utf8");
  assert.match(copilotText, /Use `npm test` to run tests\./);

  // check should now pass
  const checkRes = await execCli([
    "check",
    dir,
    "--targets",
    "claude,copilot,cursor,gemini",
  ]);
  assert.equal(checkRes.code, 0);
});

test("sync pointer mode writes relative links and @imports", async (t) => {
  const dir = makeTempProject(t);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Canonical\n", "utf8");

  const res = await execCli([
    "sync",
    dir,
    "--mode",
    "pointer",
    "--targets",
    "claude,copilot,cursor",
  ]);
  assert.equal(res.code, 0);

  const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
  assert.match(claude, /^@AGENTS\.md$/m);

  const copilot = fs.readFileSync(path.join(dir, ".github/copilot-instructions.md"), "utf8");
  assert.match(copilot, /\.\.\/AGENTS\.md/);

  const cursor = fs.readFileSync(path.join(dir, ".cursor/rules/project.mdc"), "utf8");
  assert.match(cursor, /\.\.\/\.\.\/AGENTS\.md/);
});

test("diff and check detect drift after editing source", async (t) => {
  const dir = makeTempProject(t);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Rules v1\n", "utf8");
  fs.writeFileSync(
    path.join(dir, ".agent-rules.json"),
    JSON.stringify({ source: "AGENTS.md", mode: "copy", targets: ["CLAUDE.md"] }),
    "utf8",
  );

  assert.equal((await execCli(["sync", dir])).code, 0);
  assert.equal((await execCli(["diff", dir])).code, 0);

  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Rules v2\n", "utf8");

  const diffRes = await execCli(["diff", dir]);
  assert.equal(diffRes.code, 1);
  assert.match(diffRes.stdout, /-+# Rules v1|- # Rules v1|-# Rules v1/);
  assert.match(diffRes.stdout, /\+# Rules v2/);

  const checkRes = await execCli(["check", dir, "--json"]);
  assert.equal(checkRes.code, 1);
  const json = JSON.parse(checkRes.stdout);
  assert.equal(json.ok, false);
  assert.equal(json.targets[0].status, "drifted");
});

test("check detects broken @imports and Markdown links while ignoring code blocks and npm scopes", async (t) => {
  const dir = makeTempProject(t);
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "real.md"), "# Real\n", "utf8");

  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    [
      "# Rules",
      "",
      "See [real](docs/real.md) and [external](https://example.com) and [anchor](#rules).",
      "Install `@types/node` via npm.",
      "",
      "```markdown",
      "@docs/ignored-in-fence.md",
      "[ignored](docs/ignored.md)",
      "```",
      "",
      "@docs/missing.md",
      "Also check [broken](docs/nope.md).",
      "",
    ].join("\n"),
    "utf8",
  );

  const res = await execCli(["check", dir, "--json"]);
  assert.equal(res.code, 1);
  const data = JSON.parse(res.stdout);
  assert.equal(data.brokenRefs.length, 2);
  assert.equal(data.brokenRefs[0].ref, "docs/missing.md");
  assert.equal(data.brokenRefs[0].kind, "at-import");
  assert.equal(data.brokenRefs[1].ref, "docs/nope.md");
  assert.equal(data.brokenRefs[1].kind, "markdown-link");
});

test("check detects package-manager contradictions and enforces --max-tokens", async (t) => {
  const dir = makeTempProject(t);
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    "# Project\nRun `pnpm install` and `pnpm test`.\nNever use `npm install`.\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "CLAUDE.md"),
    "# Claude\nRun `npm install` and `npm test`.\n",
    "utf8",
  );

  // Without --strict, contradiction is a warning (exit 0)
  const warnRes = await execCli(["check", dir, "--json"]);
  assert.equal(warnRes.code, 0);
  const warnData = JSON.parse(warnRes.stdout);
  assert.equal(warnData.contradictions.length, 1);
  assert.equal(warnData.contradictions[0].topic, "package-manager");

  // With --strict, contradiction fails (exit 1)
  const strictRes = await execCli(["check", dir, "--strict"]);
  assert.equal(strictRes.code, 1);

  // Token budget check
  const budgetRes = await execCli(["check", dir, "--max-tokens", "5", "--json"]);
  assert.equal(budgetRes.code, 1);
  const budgetData = JSON.parse(budgetRes.stdout);
  assert.ok(budgetData.files.some((/** @type {{ overBudget: boolean }} */ f) => f.overBudget));
});

test("rejects path traversal and invalid arguments with exit code 2", async (t) => {
  const dir = makeTempProject(t);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Rules\n", "utf8");

  const traversal = await execCli(["sync", dir, "--targets", "../escape.md"]);
  assert.equal(traversal.code, 2);

  const badFlag = await execCli(["check", dir, "--unknown-flag"]);
  assert.equal(badFlag.code, 2);

  const missingDir = await execCli(["check", path.join(dir, "does-not-exist")]);
  assert.equal(missingDir.code, 2);
});

test("CLI binary runs end-to-end via node child process", (t) => {
  const dir = makeTempProject(t);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# CLI Smoke Test\n", "utf8");

  const initProc = spawnSync(process.execPath, [CLI_PATH, "init", dir], { encoding: "utf8" });
  assert.equal(initProc.status, 0, initProc.stderr);

  const syncProc = spawnSync(process.execPath, [CLI_PATH, "sync", dir], { encoding: "utf8" });
  assert.equal(syncProc.status, 0, syncProc.stderr);

  const checkProc = spawnSync(process.execPath, [CLI_PATH, "check", dir], { encoding: "utf8" });
  assert.equal(checkProc.status, 0, checkProc.stderr);
  assert.match(checkProc.stdout, /All checks passed\./);
});
