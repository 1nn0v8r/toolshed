// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, parseSize, UsageError } from "../src/args.js";

test("defaults", () => {
  const o = parseArgs([]);
  assert.deepEqual(o.paths, []);
  assert.equal(o.maxFileSize, 256 * 1024);
  assert.equal(o.maxTokens, null);
  assert.equal(o.order, "priority");
  assert.equal(o.format, "md");
  assert.equal(o.out, null);
  assert.equal(o.lineNumbers, false);
  assert.equal(o.allowEnv, false);
  assert.equal(o.defaultExcludes, true);
});

test("positionals, repeatable include and exclude, both value styles", () => {
  const o = parseArgs(["src", "lib", "--include", "*.js", "--include=*.ts", "--exclude", "a", "--exclude=b"]);
  assert.deepEqual(o.paths, ["src", "lib"]);
  assert.deepEqual(o.include, ["*.js", "*.ts"]);
  assert.deepEqual(o.exclude, ["a", "b"]);
});

test("flags and values", () => {
  const o = parseArgs([
    "--max-tokens", "500", "--order", "path", "--format=xml", "--out", "x.md",
    "--line-numbers", "--allow-env", "--no-default-excludes", "--max-file-size", "10k",
  ]);
  assert.equal(o.maxTokens, 500);
  assert.equal(o.order, "path");
  assert.equal(o.format, "xml");
  assert.equal(o.out, "x.md");
  assert.equal(o.lineNumbers, true);
  assert.equal(o.allowEnv, true);
  assert.equal(o.defaultExcludes, false);
  assert.equal(o.maxFileSize, 10240);
});

test("help and version, long and short", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--version"]).version, true);
  assert.equal(parseArgs(["-v"]).version, true);
});

test("-- ends option parsing, lone dash is a positional", () => {
  assert.deepEqual(parseArgs(["--", "--weird", "-x"]).paths, ["--weird", "-x"]);
  assert.deepEqual(parseArgs(["-"]).paths, ["-"]);
});

test("parseSize", () => {
  assert.equal(parseSize("4096"), 4096);
  assert.equal(parseSize("1k"), 1024);
  assert.equal(parseSize("2KB"), 2048);
  assert.equal(parseSize("1m"), 1048576);
  assert.equal(parseSize("1.5k"), 1536);
  assert.equal(parseSize("7b"), 7);
  assert.throws(() => parseSize("abc"), UsageError);
  assert.throws(() => parseSize("0"), UsageError);
  assert.throws(() => parseSize("-5"), UsageError);
});

/** @type {[string[], RegExp][]} */
const BAD = [
  [["--nope"], /unknown option --nope/],
  [["-z"], /unknown option -z/],
  [["--include"], /needs a value/],
  [["--include", "--exclude"], /needs a value/],
  [["--out="], /non-empty/],
  [["--max-tokens", "0"], /positive whole number/],
  [["--max-tokens", "abc"], /positive whole number/],
  [["--max-tokens", "1.5"], /positive whole number/],
  [["--max-tokens", "99999999999999999999"], /positive whole number/],
  [["--order", "random"], /--order/],
  [["--format", "json"], /--format/],
  [["--max-file-size", "big"], /invalid size/],
  [["--line-numbers=yes"], /does not take a value/],
];
for (const [argv, re] of BAD) {
  test(`usage error: ${argv.join(" ")}`, () => {
    assert.throws(() => parseArgs(argv), (e) => e instanceof UsageError && re.test(e.message));
  });
}
