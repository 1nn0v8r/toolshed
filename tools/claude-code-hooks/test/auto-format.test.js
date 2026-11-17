// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { evaluate, findFormatter, findPrettier, runPlan, which } from "../src/hooks/auto-format.js";
import { mkTmp, payload, rmTmp, runHookProcess, testEnv } from "./helpers.js";

const FAKE_SCRIPT = `
const fs = require("node:fs");
const [tool, ...args] = process.argv.slice(2);
if (process.env.FAKE_FAIL) process.exit(1);
if (process.env.FAKE_SLEEP) setTimeout(() => {}, 8000);
else {
  const file = args[args.length - 1];
  fs.appendFileSync(file, "\\n/*fmt:" + tool + ":" + args.slice(0, -1).join(" ") + "*/");
}
`;

/**
 * Create fake formatter executables in a bin dir.
 * @param {string} dir
 * @param {string[]} tools
 */
function makeFakeBin(dir, tools) {
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "fake.cjs");
  fs.writeFileSync(script, FAKE_SCRIPT);
  for (const t of tools) {
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(dir, t + ".cmd"), `@"${process.execPath}" "${script}" ${t} %*\r\n`);
    } else {
      const f = path.join(dir, t);
      fs.writeFileSync(f, `#!/bin/sh\nexec "${process.execPath}" "${script}" ${t} "$@"\n`);
      fs.chmodSync(f, 0o755);
    }
  }
}

/**
 * Env whose PATH holds only the given directory.
 * @param {string} home
 * @param {string} pathValue
 * @param {Record<string, string>} [extra]
 */
function envWithPath(home, pathValue, extra = {}) {
  const env = testEnv(home, extra);
  for (const k of Object.keys(env)) if (k.toLowerCase() === "path") delete env[k];
  env.PATH = pathValue;
  return env;
}

/**
 * Project with a fake local prettier.
 * @param {string} proj
 * @param {{ declare?: boolean, config?: boolean }} [opts]
 */
function makeProjectWithPrettier(proj, opts = {}) {
  const pdir = path.join(proj, "node_modules", "prettier");
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, "package.json"), JSON.stringify({ name: "prettier", bin: { prettier: "bin.cjs" } }));
  fs.writeFileSync(
    path.join(pdir, "bin.cjs"),
    `const fs=require("node:fs");const a=process.argv.slice(2);if(process.env.FAKE_FAIL)process.exit(2);if(process.env.FAKE_SLEEP){setTimeout(()=>{},8000);}else{fs.appendFileSync(a[a.length-1],"\\n/*prettier:"+a.slice(0,-1).join(" ")+"*/");}`,
  );
  if (opts.declare !== false) fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ devDependencies: { prettier: "^3.0.0" } }));
  if (opts.config) fs.writeFileSync(path.join(proj, ".prettierrc"), "{}");
}

const post = (/** @type {string} */ file, /** @type {Record<string, unknown>} */ extra = {}) =>
  payload("Write", { file_path: file, content: "x" }, Object.assign({ hook_event_name: "PostToolUse" }, extra));

test("no formatter: silent, file untouched, exit 0", () => {
  const home = mkTmp();
  const proj = mkTmp();
  try {
    const empty = path.join(proj, "emptybin");
    fs.mkdirSync(empty);
    for (const f of ["a.js", "b.py", "c.go", "d.rs", "e.txt", "f.json"]) {
      const file = path.join(proj, f);
      fs.writeFileSync(file, "orig");
      const r = runHookProcess("auto-format", post(file, { cwd: proj }), { env: envWithPath(home, empty) });
      assert.equal(r.status, 0, f);
      assert.equal(r.stdout, "", f);
      assert.equal(fs.readFileSync(file, "utf8"), "orig", f);
    }
  } finally {
    rmTmp(home);
    rmTmp(proj);
  }
});

test("fake local prettier formats js, ts, json, css, md, yaml", async () => {
  const proj = mkTmp();
  try {
    makeProjectWithPrettier(proj);
    for (const f of ["a.js", "b.ts", "c.json", "d.css", "e.md", "f.yaml", "g.tsx", "h.yml"]) {
      const file = path.join(proj, "src", f);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "orig");
      const r = await evaluate(post(file, { cwd: proj }));
      assert.equal(r.decision, "allow");
      assert.match(fs.readFileSync(file, "utf8"), /prettier:--write --ignore-unknown/, f);
    }
  } finally {
    rmTmp(proj);
  }
});

test("prettier is skipped without a declared dependency or config, used with a config", async () => {
  const proj = mkTmp();
  try {
    makeProjectWithPrettier(proj, { declare: false });
    const file = path.join(proj, "a.js");
    fs.writeFileSync(file, "orig");
    await evaluate(post(file));
    assert.equal(fs.readFileSync(file, "utf8"), "orig");
    assert.equal(findPrettier(file), null);
    fs.writeFileSync(path.join(proj, ".prettierrc"), "{}");
    await evaluate(post(file));
    assert.match(fs.readFileSync(file, "utf8"), /prettier:/);
  } finally {
    rmTmp(proj);
  }
});

test("prettier package without a bin entry is ignored; string bin works", () => {
  const proj = mkTmp();
  try {
    makeProjectWithPrettier(proj);
    fs.writeFileSync(path.join(proj, "node_modules", "prettier", "package.json"), JSON.stringify({ name: "prettier" }));
    assert.equal(findPrettier(path.join(proj, "a.js")), null);
    fs.writeFileSync(path.join(proj, "node_modules", "prettier", "package.json"), JSON.stringify({ bin: "bin.cjs" }));
    const plan = findPrettier(path.join(proj, "a.js"));
    assert.ok(plan);
    assert.equal(plan.kind, "node");
  } finally {
    rmTmp(proj);
  }
});

test("package.json with a prettier key counts as configured", () => {
  const proj = mkTmp();
  try {
    makeProjectWithPrettier(proj, { declare: false });
    fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ prettier: { semi: false } }));
    assert.ok(findPrettier(path.join(proj, "a.js")));
    fs.writeFileSync(path.join(proj, "package.json"), "{ broken");
    assert.equal(findPrettier(path.join(proj, "a.js")), null);
  } finally {
    rmTmp(proj);
  }
});

test("e2e: fake ruff, black, gofmt and rustfmt on PATH", () => {
  const home = mkTmp();
  const proj = mkTmp();
  try {
    const bin = path.join(proj, "bin");
    makeFakeBin(bin, ["ruff", "gofmt", "rustfmt"]);
    const cases = /** @type {[string, RegExp][]} */ ([
      ["a.py", /fmt:ruff:format/],
      ["b.go", /fmt:gofmt:-w/],
      ["c.rs", /fmt:rustfmt:/],
    ]);
    for (const [f, re] of cases) {
      const file = path.join(proj, f);
      fs.writeFileSync(file, "orig");
      const r = runHookProcess("auto-format", post(file, { cwd: proj }), { env: envWithPath(home, bin) });
      assert.equal(r.status, 0, f);
      assert.equal(r.stdout, "", f);
      assert.match(fs.readFileSync(file, "utf8"), re, f);
    }
    const bin2 = path.join(proj, "bin2");
    makeFakeBin(bin2, ["black"]);
    const py = path.join(proj, "d.py");
    fs.writeFileSync(py, "orig");
    runHookProcess("auto-format", post(py, { cwd: proj }), { env: envWithPath(home, bin2) });
    assert.match(fs.readFileSync(py, "utf8"), /fmt:black:-q/);
  } finally {
    rmTmp(home);
    rmTmp(proj);
  }
});

test("e2e: a failing formatter never blocks", () => {
  const home = mkTmp();
  const proj = mkTmp();
  try {
    const bin = path.join(proj, "bin");
    makeFakeBin(bin, ["ruff"]);
    const file = path.join(proj, "a.py");
    fs.writeFileSync(file, "orig");
    const r = runHookProcess("auto-format", post(file, { cwd: proj }), { env: envWithPath(home, bin, { FAKE_FAIL: "1" }) });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(fs.readFileSync(file, "utf8"), "orig");
  } finally {
    rmTmp(home);
    rmTmp(proj);
  }
});

test("timeout kills a hanging formatter and still exits 0", () => {
  const home = mkTmp();
  const proj = mkTmp();
  try {
    makeProjectWithPrettier(proj);
    fs.mkdirSync(path.join(proj, ".claude"));
    fs.writeFileSync(path.join(proj, ".claude", "hooks.config.json"), JSON.stringify({ "auto-format": { timeoutMs: 400 } }));
    const file = path.join(proj, "a.js");
    fs.writeFileSync(file, "orig");
    const started = Date.now();
    const r = runHookProcess("auto-format", post(file, { cwd: proj }), { env: testEnv(home, { FAKE_SLEEP: "1" }) });
    assert.equal(r.status, 0);
    assert.ok(Date.now() - started < 7000, "should not wait for the sleeping formatter");
  } finally {
    rmTmp(home);
    rmTmp(proj);
  }
});

test("config: disable and ignore; relative paths resolve against cwd", async () => {
  const proj = mkTmp();
  try {
    makeProjectWithPrettier(proj);
    const file = path.join(proj, "a.js");
    fs.writeFileSync(file, "orig");
    await evaluate(post(file), { disable: true });
    assert.equal(fs.readFileSync(file, "utf8"), "orig");
    await evaluate(post(file), { ignore: ["*.js"] });
    assert.equal(fs.readFileSync(file, "utf8"), "orig");
    await evaluate(post("a.js", { cwd: proj }));
    assert.match(fs.readFileSync(file, "utf8"), /prettier:/);
  } finally {
    rmTmp(proj);
  }
});

test("missing file, directory, missing path and unknown extension are ignored", async () => {
  const proj = mkTmp();
  try {
    makeProjectWithPrettier(proj);
    assert.equal((await evaluate(post(path.join(proj, "nope.js")))).decision, "allow");
    assert.equal((await evaluate(post(proj))).decision, "allow");
    assert.equal((await evaluate({ tool_input: {} })).decision, "allow");
    assert.equal((await evaluate({})).decision, "allow");
    const txt = path.join(proj, "a.txt");
    fs.writeFileSync(txt, "orig");
    assert.equal(findFormatter(txt), null);
    await evaluate(post(txt));
    assert.equal(fs.readFileSync(txt, "utf8"), "orig");
  } finally {
    rmTmp(proj);
  }
});

test("which finds executables on PATH and returns null otherwise", () => {
  const dir = mkTmp();
  const saved = process.env.PATH;
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === "path") || "PATH";
  try {
    makeFakeBin(dir, ["mytool"]);
    process.env[key] = dir;
    assert.ok(which("mytool"));
    assert.equal(which("definitely-not-installed-tool"), null);
  } finally {
    process.env[key] = saved;
    rmTmp(dir);
  }
});

test("runPlan resolves even when the program is missing", async () => {
  const dir = mkTmp();
  try {
    await runPlan({ file: path.join(dir, "does-not-exist"), args: [], cwd: dir, kind: "exe" }, 1000);
  } finally {
    rmTmp(dir);
  }
});
