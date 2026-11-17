// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, UsageError } from "../src/args.js";

test("defaults", () => {
  const o = parseArgs([]);
  assert.equal(o.tagPrefix, "v");
  assert.equal(o.versionLabel, "Unreleased");
  assert.equal(o.hash, true);
  assert.equal(o.includeMerges, false);
  assert.equal(o.write, null);
});

test("value flags in both forms", () => {
  const o = parseArgs(["--tag-prefix", "repo-pack@", "--from=abc", "--to", "def", "--path", "tools/x", "--scope=x", "--version-label", "1.2.3", "--date", "2026-02-28", "--write=CHANGELOG.md"]);
  assert.equal(o.tagPrefix, "repo-pack@");
  assert.equal(o.from, "abc");
  assert.equal(o.to, "def");
  assert.equal(o.path, "tools/x");
  assert.equal(o.scope, "x");
  assert.equal(o.versionLabel, "1.2.3");
  assert.equal(o.date, "2026-02-28");
  assert.equal(o.write, "CHANGELOG.md");
});

test("boolean flags", () => {
  const o = parseArgs(["--include-merges", "--all", "--no-hash", "--json", "-h", "-V"]);
  assert.deepEqual([o.includeMerges, o.all, o.hash, o.json, o.help, o.cliVersion], [true, true, false, true, true, true]);
  assert.equal(parseArgs(["--cli-version"]).cliVersion, true);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("empty tag prefix is allowed", () => {
  assert.equal(parseArgs(["--tag-prefix", ""]).tagPrefix, "");
});

test("usage errors", () => {
  assert.throws(() => parseArgs(["--bogus"]), UsageError);
  assert.throws(() => parseArgs(["-x"]), /unknown option/);
  assert.throws(() => parseArgs(["stray"]), /unexpected argument/);
  assert.throws(() => parseArgs(["--from"]), /needs a value/);
  assert.throws(() => parseArgs(["--from="]), /non-empty/);
  assert.throws(() => parseArgs(["--json=1"]), /does not take a value/);
  assert.throws(() => parseArgs(["--date", "2026-13-01"]), /invalid --date/);
  assert.throws(() => parseArgs(["--date", "2026-02-30"]), /invalid --date/);
  assert.throws(() => parseArgs(["--date", "tomorrow"]), /invalid --date/);
});
