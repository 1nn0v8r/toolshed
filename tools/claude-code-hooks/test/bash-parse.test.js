// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { cmdName, parseCommand, splitLevel, unwrap } from "../src/lib/bash-parse.js";

/** @param {string} c */
const words = (c) => splitLevel(c).segments.map((s) => s.words);

test("cmdName strips directories and .exe", () => {
  assert.equal(cmdName("/usr/bin/Git"), "git");
  assert.equal(cmdName("C:\\tools\\RM.EXE"), "rm");
});

test("splits on && || ; | and newlines", () => {
  assert.deepEqual(words("a && b || c; d | e\nf"), [["a"], ["b"], ["c"], ["d"], ["e"], ["f"]]);
  assert.deepEqual(words("a\r\nb"), [["a"], ["b"]]);
  assert.deepEqual(
    splitLevel("a && b | c").segments.map((s) => s.op),
    ["&&", "|", ""],
  );
});

test("quotes keep operators and spaces inside words", () => {
  assert.deepEqual(words("echo 'a && b' \"c; d\" e"), [["echo", "a && b", "c; d", "e"]]);
  assert.deepEqual(words('echo "say \\"hi\\""'), [["echo", 'say "hi"']]);
  assert.deepEqual(words("echo a\\ b"), [["echo", "a b"]]);
  assert.deepEqual(words("echo ''"), [["echo", ""]]);
  assert.deepEqual(words("echo 'unterminated"), [["echo", "unterminated"]]);
});

test("redirects are separated from words", () => {
  const s = splitLevel("echo hi > out.txt 2>&1 >> log.txt &> all.txt < in.txt").segments[0];
  assert.deepEqual(s.words, ["echo", "hi"]);
  assert.deepEqual(
    s.redirects.map((r) => r.target),
    ["out.txt", "log.txt", "all.txt", "in.txt"],
  );
  assert.deepEqual(words("cat>x"), [["cat"]]);
  assert.equal(splitLevel("cat>x").segments[0].redirects[0].target, "x");
});

test("command substitution is returned separately", () => {
  const r = splitLevel('echo $(rm -rf x) "`ls`" "$(pwd)" <(cat y)');
  assert.deepEqual(r.subs, ["rm -rf x", "ls", "pwd", "cat y"]);
  assert.equal(splitLevel("echo `unterminated").subs.length, 1);
});

test("empty and whitespace-only input", () => {
  assert.deepEqual(splitLevel("").segments, []);
  assert.deepEqual(splitLevel("   ").segments, []);
  assert.deepEqual(splitLevel(";;").segments, []);
});

test("trailing operator and background", () => {
  const segs = splitLevel("sleep 1 &").segments;
  assert.equal(segs.length, 1);
  assert.equal(segs[0].op, "&");
  assert.deepEqual(splitLevel("a |& b").segments.map((s) => s.op), ["|&", ""]);
});

test("unwrap removes env assignments and wrappers", () => {
  assert.deepEqual(unwrap(["FOO=1", "sudo", "-u", "root", "rm", "x"]), ["rm", "x"]);
  assert.deepEqual(unwrap(["env", "A=b", "git", "status"]), ["git", "status"]);
  assert.deepEqual(unwrap(["timeout", "5", "ls"]), ["ls"]);
  assert.deepEqual(unwrap(["nice", "-n", "5", "ls"]), ["ls"]);
  assert.deepEqual(unwrap([]), []);
});

test("parseCommand recurses into substitutions and bash -c", () => {
  const levels = parseCommand('bash -c "git reset --hard" && echo $(whoami)');
  const flat = levels.flat().map((s) => s.words[0]);
  assert.ok(flat.includes("git"));
  assert.ok(flat.includes("whoami"));
  assert.deepEqual(parseCommand("eval 'rm -rf x'").flat().map((s) => s.words[0]), ["eval", "rm"]);
  assert.deepEqual(parseCommand("bash -lc 'ls'").flat().map((s) => s.words[0]), ["bash", "ls"]);
});

test("parseCommand limits recursion depth", () => {
  let cmd = "ls";
  for (let i = 0; i < 10; i++) cmd = `bash -c '${cmd.replace(/'/g, "")}'`;
  assert.ok(Array.isArray(parseCommand(cmd)));
  // @ts-expect-error non-string input is tolerated
  assert.deepEqual(parseCommand(5), []);
});
