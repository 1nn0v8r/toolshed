// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyPath, evaluate } from "../src/hooks/protect-files.js";
import { decisionOf, mkTmp, payload, rmTmp, runHookProcess } from "./helpers.js";

/**
 * @param {string} tool
 * @param {Record<string, unknown>} ti
 * @param {Record<string, any>} [cfg]
 */
const run = (tool, ti, cfg) => evaluate(payload(tool, ti), cfg).decision;

test("denied file names for Read and Write on POSIX and Windows paths", () => {
  const denied = [
    "/abs/path/.env",
    "/abs/path/.env.local",
    "/abs/path/.env.production",
    "C:\\proj\\.env",
    "C:\\proj\\.ENV",
    "/a/server.pem",
    "/a/server.key",
    "/a/bundle.p12",
    "/a/bundle.pfx",
    "/home/u/.ssh/id_rsa",
    "/home/u/.ssh/id_ed25519",
    "/home/u/.ssh/config",
    "C:\\Users\\me\\.ssh\\known_hosts",
    "/a/id_rsa_work",
    "/a/credentials.json",
    "/home/u/.aws/credentials",
    "C:\\Users\\me\\.aws\\credentials",
  ];
  for (const p of denied) {
    assert.equal(run("Read", { file_path: p }), "deny", `Read ${p}`);
    assert.equal(run("Write", { file_path: p, content: "x" }), "deny", `Write ${p}`);
  }
});

test("allowed file names", () => {
  const ok = [
    "/a/.env.example",
    "/a/.env.sample",
    "/a/.env.template",
    "/a/.envrc",
    "/a/src/env.js",
    "/a/README.md",
    "/home/u/.ssh_notes.txt",
    "/a/id_rsa.pub",
    "/a/keyboard.txt",
    "/a/credentials.md",
    "/a/.aws/config",
  ];
  for (const p of ok) assert.equal(run("Read", { file_path: p }), "allow", p);
});

test(".npmrc and .pypirc: reads allowed, writes denied", () => {
  assert.equal(run("Read", { file_path: "/p/.npmrc" }), "allow");
  assert.equal(run("Write", { file_path: "/p/.npmrc", content: "a=b" }), "deny");
  assert.equal(run("Edit", { file_path: "/p/.npmrc", old_string: "a", new_string: "b" }), "deny");
  assert.equal(run("Read", { file_path: "C:\\p\\.pypirc" }), "allow");
  assert.equal(run("MultiEdit", { file_path: "C:\\p\\.pypirc", edits: [] }), "deny");
});

test("Edit, MultiEdit and NotebookEdit paths are checked", () => {
  assert.equal(run("Edit", { file_path: "/p/.env", old_string: "a", new_string: "b" }), "deny");
  assert.equal(run("MultiEdit", { file_path: "/p/.env", edits: [] }), "deny");
  assert.equal(run("NotebookEdit", { notebook_path: "/p/.env" }), "deny");
});

test("missing or malformed fields allow", () => {
  assert.equal(evaluate({}).decision, "allow");
  assert.equal(evaluate({ tool_name: "Read" }).decision, "allow");
  assert.equal(evaluate({ tool_name: "Read", tool_input: { file_path: 5 } }).decision, "allow");
  assert.equal(evaluate({ tool_name: "Read", tool_input: { file_path: "" } }).decision, "allow");
  assert.equal(evaluate({ tool_name: "Bash", tool_input: {} }).decision, "allow");
  assert.equal(evaluate({ tool_name: "Bash", tool_input: { command: 5 } }).decision, "allow");
  assert.equal(evaluate({ tool_name: "Read", tool_input: "nope" }).decision, "allow");
  assert.equal(classifyPath(/** @type {any} */ (null)), null);
});

test("config extra and allow globs", () => {
  assert.equal(run("Read", { file_path: "/p/secrets/a.txt" }), "allow");
  assert.equal(run("Read", { file_path: "/p/secrets/a.txt" }, { extra: ["secrets/**"] }), "deny");
  assert.equal(run("Read", { file_path: "/p/.env" }, { allow: ["/p/.env"] }), "allow");
  assert.equal(run("Read", { file_path: "/p/fixtures/.env" }, { allow: ["fixtures/**"] }), "allow");
  assert.equal(run("Read", { file_path: "/p/a.key" }, { allow: ["*.key"], extra: ["*.key"] }), "allow");
});

test("bash: reading and writing sensitive files is denied", () => {
  const denied = [
    "cat .env",
    "cat ./.env.local",
    "less /abs/path/.env",
    "head -n 5 .env",
    "tail -f C:\\proj\\.env",
    "cp .env /tmp/x",
    "cp /tmp/x .env",
    "mv .env .env.bak",
    "rm .env",
    "echo KEY=1 > .env",
    "echo KEY=1 >> .env.local",
    "echo KEY=1 | tee .env",
    "printf x >.env",
    "cat < .env",
    "sed -i s/a/b/ .env",
    "grep TOKEN .env",
    "source .env",
    ". .env",
    "cat ~/.ssh/id_rsa",
    "cat ~/.aws/credentials",
    "cat server.pem",
    "scp -i id_ed25519 a b:c",
    "cd x && cat .env",
    "ls; cat .env",
    "bash -c 'cat .env'",
    "sudo cat /etc/x.key",
    "git show HEAD:.env",
    "git add .env",
    "dd if=.env of=/tmp/x",
    "FOO=bar cat .env",
    "echo hi > id_rsa",
    "echo hi 2> .env",
    "echo hi &> .env",
    "echo '{}' > credentials.json",
    "docker run -v .env:/x img",
  ];
  for (const c of denied) assert.equal(run("Bash", { command: c }), "deny", c);
});

test("bash: harmless mentions are allowed", () => {
  const ok = [
    "ls -la",
    "ls .env",
    "echo .env",
    "echo .env >> .gitignore",
    "cat .env.example",
    "cat README.md",
    "git status",
    "git check-ignore .env",
    "docker run --env-file .env img",
    "docker run --env-file=.env img",
    "npm test",
    "cat .npmrc",
    "grep registry .npmrc",
    "cat < .npmrc",
    "ssh host",
    "stat .env",
    "git commit -m 'update .env handling'",
    "",
    "   ",
  ];
  for (const c of ok) assert.equal(run("Bash", { command: c }), "allow", c);
});

test("bash: .npmrc writes denied, and allow globs apply", () => {
  assert.equal(run("Bash", { command: "echo x > .npmrc" }), "deny");
  assert.equal(run("Bash", { command: "sed -i s/a/b/ .npmrc" }), "deny");
  assert.equal(run("Bash", { command: "npm config set x y --userconfig .npmrc" }), "deny");
  assert.equal(run("Bash", { command: "cat .env" }, { allow: [".env"] }), "allow");
  assert.equal(run("Bash", { command: "cat build/x.txt" }, { extra: ["build/**"] }), "deny");
});

test("reason names the path and does not echo file content", () => {
  const r = evaluate(payload("Read", { file_path: "/p/.env" }));
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /\/p\/\.env/);
});

test("e2e: spawns the script and prints the deny JSON", () => {
  const home = mkTmp();
  try {
    const r = runHookProcess("protect-files", payload("Read", { file_path: "/abs/path/.env" }), { home });
    assert.equal(r.status, 0);
    const d = decisionOf(r.stdout);
    assert.equal(d.decision, "deny");
    assert.equal(d.event, "PreToolUse");
    assert.match(d.reason, /protect-files/);
    const ok = runHookProcess("protect-files", payload("Read", { file_path: "/abs/path/a.txt" }), { home });
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout, "");
  } finally {
    rmTmp(home);
  }
});

test("e2e: bash payload on Windows style path", () => {
  const home = mkTmp();
  try {
    const r = runHookProcess("protect-files", payload("Bash", { command: "type C:\\proj\\.env" }), { home });
    assert.equal(decisionOf(r.stdout).decision, "deny");
  } finally {
    rmTmp(home);
  }
});

test("e2e: project config file adds extra globs", () => {
  const home = mkTmp();
  const proj = mkTmp();
  try {
    fs.mkdirSync(`${proj}/.claude`);
    fs.writeFileSync(`${proj}/.claude/hooks.config.json`, JSON.stringify({ "protect-files": { extra: ["private/**"] } }));
    const r = runHookProcess("protect-files", payload("Read", { file_path: "/x/private/a.txt" }, { cwd: proj }), { home });
    assert.equal(decisionOf(r.stdout).decision, "deny");
  } finally {
    rmTmp(home);
    rmTmp(proj);
  }
});

test("e2e: malformed and empty input allow with a note", () => {
  const home = mkTmp();
  try {
    for (const bad of ["{not json", "", "[]", "null", "42"]) {
      const r = runHookProcess("protect-files", bad, { home });
      assert.equal(r.status, 0, bad);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /allowing/);
    }
  } finally {
    rmTmp(home);
  }
});

