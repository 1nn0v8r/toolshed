// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MODEL, HELP, UsageError, parseArgs } from "../src/args.js";

test("defaults", () => {
  const o = parseArgs([]);
  assert.deepEqual(o.paths, []);
  assert.equal(o.exact, false);
  assert.equal(o.model, DEFAULT_MODEL);
  assert.equal(o.top, null);
  assert.equal(o.budget, null);
  assert.equal(o.stdin, false);
});

test("paths and flags", () => {
  const o = parseArgs(["a", "b", "--exact", "--by-dir", "--json", "--top", "3", "--budget", "100", "--model", "m1", "-"]);
  assert.deepEqual(o.paths, ["a", "b"]);
  assert.equal(o.exact && o.byDir && o.json && o.stdin, true);
  assert.equal(o.top, 3);
  assert.equal(o.budget, 100);
  assert.equal(o.model, "m1");
});

test("inline = values", () => {
  const o = parseArgs(["--top=5", "--budget=0", "--model=x"]);
  assert.equal(o.top, 5);
  assert.equal(o.budget, 0);
  assert.equal(o.model, "x");
});

test("help and version aliases", () => {
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-v"]).version, true);
  assert.equal(parseArgs(["--version"]).version, true);
});

test("double dash treats the rest as paths", () => {
  const o = parseArgs(["--json", "--", "--weird", "-x"]);
  assert.deepEqual(o.paths, ["--weird", "-x"]);
});

test("usage errors", () => {
  assert.throws(() => parseArgs(["--nope"]), UsageError);
  assert.throws(() => parseArgs(["-z"]), /unknown option -z/);
  assert.throws(() => parseArgs(["--top"]), /--top needs/);
  assert.throws(() => parseArgs(["--top", "abc"]), /--top needs/);
  assert.throws(() => parseArgs(["--top", "-1"]), UsageError);
  assert.throws(() => parseArgs(["--top", "0"]), /at least 1/);
  assert.throws(() => parseArgs(["--budget", "1.5"]), /--budget needs/);
  assert.throws(() => parseArgs(["--budget"]), /--budget needs/);
  assert.throws(() => parseArgs(["--model"]), /--model needs a value/);
  assert.throws(() => parseArgs(["--model="]), /--model needs a value/);
});

test("help text mentions every option", () => {
  for (const f of ["--exact", "--model", "--top", "--by-dir", "--json", "--budget", "--help", "--version"]) {
    assert.ok(HELP.includes(f), f);
  }
});
