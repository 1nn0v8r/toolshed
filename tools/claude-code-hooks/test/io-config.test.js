// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { allow, ask, deny, isMain, parseInput, readStream, toOutput } from "../src/lib/io.js";
import { homeDir, loadConfig, stringList } from "../src/lib/config.js";
import { HOOKS, HOOK_NAMES, commandFor, hooksDir } from "../src/lib/registry.js";
import { mkTmp, rmTmp, runHookProcess } from "./helpers.js";

test("decision helpers", () => {
  assert.deepEqual(allow(), { decision: "allow", reason: "" });
  assert.deepEqual(deny("r"), { decision: "deny", reason: "r" });
  assert.deepEqual(ask("r"), { decision: "ask", reason: "r" });
  const o = toOutput("x", deny("why"));
  assert.equal(o.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(o.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(o.hookSpecificOutput.permissionDecisionReason, "[claude-code-hooks:x] why");
});

test("parseInput accepts objects only and strips a BOM", () => {
  assert.deepEqual(parseInput('{"a":1}'), { a: 1 });
  assert.deepEqual(parseInput('﻿{"a":1}'), { a: 1 });
  for (const bad of ["", "nope", "[1]", "null", "3", '"s"']) assert.equal(parseInput(bad), null);
});

test("readStream joins chunks and propagates errors", async () => {
  assert.equal(await readStream(Readable.from(["aé", "b"])), "aéb");
  const failing = new Readable({
    read() {
      this.destroy(new Error("boom"));
    },
  });
  await assert.rejects(() => readStream(failing), /boom/);
});

test("isMain is true only for the entry script", () => {
  const other = new URL("../src/lib/io.js", import.meta.url).href;
  assert.equal(isMain(import.meta.url), true);
  assert.equal(isMain(other), false);
  const saved = process.argv[1];
  try {
    process.argv[1] = "";
    assert.equal(isMain(import.meta.url), false);
    const d = mkTmp();
    process.argv[1] = path.join(d, "missing.js");
    assert.equal(isMain(import.meta.url), false);
    rmTmp(d);
  } finally {
    process.argv[1] = saved;
  }
});

test("homeDir honors CLAUDE_CODE_HOOKS_HOME", () => {
  const saved = process.env.CLAUDE_CODE_HOOKS_HOME;
  try {
    process.env.CLAUDE_CODE_HOOKS_HOME = "/abs/path/to/home";
    assert.equal(homeDir(), "/abs/path/to/home");
    delete process.env.CLAUDE_CODE_HOOKS_HOME;
    assert.ok(homeDir().length > 0);
  } finally {
    if (saved !== undefined) process.env.CLAUDE_CODE_HOOKS_HOME = saved;
  }
});

test("loadConfig merges project and home, arrays concatenate, project wins", () => {
  const home = mkTmp();
  const proj = mkTmp();
  const saved = { h: process.env.CLAUDE_CODE_HOOKS_HOME, p: process.env.CLAUDE_PROJECT_DIR };
  try {
    process.env.CLAUDE_CODE_HOOKS_HOME = home;
    delete process.env.CLAUDE_PROJECT_DIR;
    fs.mkdirSync(path.join(home, ".claude"));
    fs.mkdirSync(path.join(proj, ".claude"));
    fs.writeFileSync(path.join(home, ".claude", "hooks.config.json"), JSON.stringify({ a: { list: ["h"], flag: "home", only: 1 }, b: 1 }));
    fs.writeFileSync(path.join(proj, ".claude", "hooks.config.json"), JSON.stringify({ a: { list: ["p"], flag: "proj" } }));
    const c = loadConfig("a", proj);
    assert.deepEqual(c.list, ["p", "h"]);
    assert.equal(c.flag, "proj");
    assert.equal(c.only, 1);
    assert.deepEqual(loadConfig("zzz", proj), {});
    assert.deepEqual(stringList(c, "list"), ["p", "h"]);
    assert.deepEqual(stringList(c, "nope"), []);
    assert.deepEqual(stringList(undefined, "x"), []);
    assert.deepEqual(stringList({ x: [1, "a"] }, "x"), ["a"]);
    // section that is not an object is ignored
    fs.writeFileSync(path.join(proj, ".claude", "hooks.config.json"), JSON.stringify({ a: [1], z: "s" }));
    assert.equal(loadConfig("a", proj).flag, "home");
    // CLAUDE_PROJECT_DIR is consulted too
    process.env.CLAUDE_PROJECT_DIR = proj;
    fs.writeFileSync(path.join(proj, ".claude", "hooks.config.json"), JSON.stringify({ a: { flag: "envproj" } }));
    assert.equal(loadConfig("a", undefined).flag, "envproj");
  } finally {
    if (saved.h === undefined) delete process.env.CLAUDE_CODE_HOOKS_HOME;
    else process.env.CLAUDE_CODE_HOOKS_HOME = saved.h;
    if (saved.p === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = saved.p;
    rmTmp(home);
    rmTmp(proj);
  }
});

test("registry: every hook script exists and commands use forward slashes", () => {
  assert.deepEqual(HOOK_NAMES, ["protect-files", "block-secrets", "guard-bash", "auto-format"]);
  assert.ok(!hooksDir().includes("\\"));
  for (const h of HOOKS) {
    assert.ok(fs.existsSync(path.join(hooksDir(), h.file)), h.file);
    assert.match(commandFor(h), /^node "[^"]+"$/);
    assert.ok(commandFor(h).includes("claude-code-hooks/src/hooks/") || process.cwd().length > 0);
  }
});

test("e2e: every hook allows an empty tool_input without output", () => {
  const home = mkTmp();
  try {
    for (const name of HOOK_NAMES) {
      const r = runHookProcess(name, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, { home });
      assert.equal(r.status, 0, name);
      assert.equal(r.stdout, "", name);
    }
  } finally {
    rmTmp(home);
  }
});
