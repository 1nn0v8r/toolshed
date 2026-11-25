// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDiff } from "../src/analyze.js";
import { parseUnifiedDiff } from "../src/parser.js";
import { formatJson, formatMarkdown, formatText } from "../src/report.js";

test("detects risk flags, lockfile noise, package.json deltas, and symbols", () => {
  const diff = [
    "diff --git a/package-lock.json b/package-lock.json",
    "index 1111111..2222222 100644",
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -1,2 +1,4 @@",
    "+  \"chalk\": \"5.0.0\"",
    "+  \"extra\": \"1.0.0\"",
    "diff --git a/package.json b/package.json",
    "index 1111111..2222222 100644",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -5,4 +5,5 @@",
    "   \"dependencies\": {",
    "+    \"chalk\": \"^5.3.0\",",
    "-    \"old-pkg\": \"^1.0.0\"",
    "   }",
    "diff --git a/src/auth.ts b/src/auth.ts",
    "index 1111111..2222222 100644",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1,3 +1,8 @@",
    "+export function verifyToken(token: any) {",
    "+  // @ts-ignore bypass check",
    "+  console.log(token);",
    "+  // TODO: tighten check",
    "+  return Boolean(token);",
    "+}",
    "diff --git a/test/auth.test.ts b/test/auth.test.ts",
    "index 1111111..2222222 100644",
    "--- a/test/auth.test.ts",
    "+++ b/test/auth.test.ts",
    "@@ -1,5 +1,5 @@",
    "-it('validates token', () => {",
    "-  expect(verifyToken('abc')).toBe(true);",
    "-  expect(verifyToken('')).toBe(false);",
    "+it.skip('validates token', () => {",
    "+  expect(verifyToken('abc')).toBe(true);",
    " });"
  ].join("\n");

  const parsed = parseUnifiedDiff(diff);
  const report = analyzeDiff(parsed, { scope: "main..HEAD", rawDiffText: diff });

  assert.equal(report.riskLevel, "high");
  assert.equal(report.stats.totalFiles, 4);
  assert.equal(report.stats.meaningfulFiles, 3);
  assert.equal(report.stats.noiseFiles, 1);

  const flagIds = new Set(report.flags.map((f) => f.id));
  assert.ok(flagIds.has("test-skip"));
  assert.ok(flagIds.has("assertion-removed"));
  assert.ok(flagIds.has("type-suppression"));
  assert.ok(flagIds.has("sensitive-surface"));
  assert.ok(flagIds.has("debug-leftover"));
  assert.ok(flagIds.has("todo-added"));
  assert.ok(!flagIds.has("unpaired-source"));

  const pkgFile = report.files.find((f) => f.path === "package.json");
  assert.ok(pkgFile?.packageDelta);
  assert.deepEqual(pkgFile.packageDelta.addedDeps, ["chalk"]);
  assert.deepEqual(pkgFile.packageDelta.removedDeps, ["old-pkg"]);

  const authFile = report.files.find((f) => f.path === "src/auth.ts");
  assert.ok(authFile?.symbols.includes("verifyToken"));

  const textOut = formatText(report, { maxTokens: 500 });
  assert.match(textOut, /Risk: HIGH/);
  assert.match(textOut, /Noise \/ Lockfiles Summarized \(1\)/);
  assert.match(textOut, /package\.json delta: \+deps: chalk \| -deps: old-pkg/);
  assert.ok(!textOut.includes("--- package-lock.json ---"));

  const mdOut = formatMarkdown(report, { maxTokens: 0 });
  assert.match(mdOut, /## Diff Brief: `main\.\.HEAD`/);
  assert.ok(!mdOut.includes("### Key Hunks"));

  const jsonOut = JSON.parse(formatJson(report));
  assert.equal(jsonOut.riskLevel, "high");
  assert.equal(jsonOut.stats.noiseFiles, 1);
});

test("flags unpaired source changes when no tests are modified", () => {
  const lines = [
    "diff --git a/src/worker.js b/src/worker.js",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/worker.js",
    "@@ -0,0 +1,18 @@"
  ];
  for (let i = 1; i <= 18; i += 1) {
    lines.push(`+export const v${i} = ${i};`);
  }
  const diff = lines.join("\n");
  const report = analyzeDiff(parseUnifiedDiff(diff), { rawDiffText: diff });
  assert.ok(report.flags.some((f) => f.id === "unpaired-source"));
  assert.equal(report.riskLevel, "medium");
});

test("clips key hunks when maxTokens budget is tight", () => {
  const lines = [
    "diff --git a/src/a.js b/src/a.js",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1,1 +1,20 @@"
  ];
  for (let i = 1; i <= 20; i += 1) {
    lines.push(`+const item_${i} = "some long line of code to consume budget ${i}";`);
  }
  lines.push(
    "diff --git a/src/b.js b/src/b.js",
    "--- a/src/b.js",
    "+++ b/src/b.js",
    "@@ -1,1 +1,20 @@"
  );
  for (let i = 1; i <= 20; i += 1) {
    lines.push(`+const second_${i} = "another long line of code to consume budget ${i}";`);
  }

  const diff = lines.join("\n");
  const report = analyzeDiff(parseUnifiedDiff(diff), { rawDiffText: diff });
  const textOut = formatText(report, { maxTokens: 120 });
  assert.match(textOut, /omitted due to --max-tokens 120|clipped to token budget/);
});
