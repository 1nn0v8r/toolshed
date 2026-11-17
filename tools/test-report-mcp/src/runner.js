// @ts-check
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseByFormat } from "./parsers.js";
import { clipEnd, isInside, tailLines } from "./util.js";

/** @typedef {import("./parsers.js").Report} Report */
/**
 * @typedef {{
 *   cmd: string, args: string[], format: string, source: "file" | "stdout",
 *   display: string, alternates?: string[], note?: string
 * }} Invocation
 */

export const RUNNERS = ["vitest", "jest", "node:test", "mocha", "pytest", "go"];
export const DEFAULT_TIMEOUT = 300000;
export const MAX_TIMEOUT = 900000;
const MAX_CAPTURE = 64 * 1024 * 1024;

/**
 * Find a package's JS bin entry in node_modules, walking up from dir to root.
 * @param {string} dir
 * @param {string} root
 * @param {string} pkg
 * @param {string} [binName]
 * @returns {string | null}
 */
export function findNodeBin(dir, root, pkg, binName = pkg) {
  let cur = dir;
  for (;;) {
    const pj = path.join(cur, "node_modules", pkg, "package.json");
    if (fs.existsSync(pj)) {
      try {
        const meta = JSON.parse(fs.readFileSync(pj, "utf8"));
        const bin = typeof meta.bin === "string" ? meta.bin : meta.bin?.[binName] ?? Object.values(meta.bin ?? {})[0];
        if (typeof bin === "string") {
          const entry = path.join(path.dirname(pj), bin);
          if (fs.existsSync(entry)) return entry;
        }
      } catch {
        /* try parent */
      }
    }
    if (cur === root || !isInside(root, cur)) return null;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** @type {boolean | undefined} */
let junitSupportCache;
/** Whether this Node ships the junit test reporter. */
export function nodeSupportsJunit() {
  const forced = process.env.TEST_REPORT_NODE_REPORTER;
  if (forced === "tap") return false;
  if (forced === "junit") return true;
  if (junitSupportCache === undefined) {
    const r = spawnSync(
      process.execPath,
      ["-e", "try{process.exit(typeof require('node:test/reporters').junit==='function'?0:1)}catch{process.exit(1)}"],
      { windowsHide: true },
    );
    junitSupportCache = r.status === 0;
  }
  return junitSupportCache;
}

/** @returns {string[]} */
export function pythonCandidates() {
  if (process.env.TEST_REPORT_PYTHON) return [process.env.TEST_REPORT_PYTHON];
  return process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} root
 * @param {string} reportPath
 */
function displayCommand(cmd, args, root, reportPath) {
  const base = path.basename(cmd, path.extname(cmd));
  const shown = [base, ...args].map((a) => {
    let s = a.split(reportPath).join("<report>");
    if (root) s = s.split(root).join(".");
    return /\s/.test(s) ? JSON.stringify(s) : s;
  });
  return shown.join(" ");
}

/**
 * Build the command for a runner. With `dry`, a missing local binary yields a placeholder instead of throwing.
 * @param {string} runner
 * @param {{root: string, dir: string, filter?: string, files?: string[], reportPath: string, dry?: boolean}} o
 * @returns {Invocation}
 */
export function buildInvocation(runner, o) {
  const { root, dir, filter, reportPath } = o;
  const files = (o.files ?? []).map((f) => {
    const rel = path.relative(dir, f) || ".";
    return rel.startsWith("-") ? `.${path.sep}${rel}` : rel;
  });
  /**
   * @param {string} pkg
   * @param {string[]} args
   * @param {string} format
   * @param {"file" | "stdout"} source
   * @param {string} [binName]
   * @returns {Invocation}
   */
  const node = (pkg, args, format, source, binName) => {
    const entry = findNodeBin(dir, root, pkg, binName);
    if (!entry) {
      if (!o.dry) throw new Error(`${pkg} not found in node_modules (searched from the working directory up to the repo root). Run npm install first.`);
      return { cmd: "node", args: [`<node_modules/${pkg}>`, ...args], format, source, display: `${pkg} ${args.join(" ")}`.replace(reportPath, "<report>") };
    }
    const all = [entry, ...args];
    return { cmd: process.execPath, args: all, format, source, display: displayCommand(process.execPath, [`node_modules/${pkg}/${path.basename(entry)}`, ...args], root, reportPath) };
  };

  switch (runner) {
    case "vitest":
      return node("vitest", ["run", "--reporter=junit", `--outputFile=${reportPath}`, ...(filter ? [`--testNamePattern=${filter}`] : []), ...files], "junit", "file");
    case "jest":
      return node("jest", ["--json", `--outputFile=${reportPath}`, ...(filter ? [`--testNamePattern=${filter}`] : []), ...files], "jest-json", "file");
    case "mocha":
      return node("mocha", ["--reporter", "json", "--reporter-option", `output=${reportPath}`, ...(filter ? [`--grep=${filter}`] : []), ...files], "mocha-json", "file");
    case "node:test": {
      const common = ["--test", ...(filter ? [`--test-name-pattern=${filter}`] : [])];
      if (nodeSupportsJunit()) {
        const args = ["--test-reporter=junit", `--test-reporter-destination=${reportPath}`, ...common, ...files];
        return { cmd: process.execPath, args, format: "junit", source: "file", display: displayCommand(process.execPath, args, root, reportPath) };
      }
      const args = ["--test-reporter=tap", ...common, ...files];
      return { cmd: process.execPath, args, format: "tap", source: "stdout", display: displayCommand(process.execPath, args, root, reportPath), note: "This Node has no junit reporter, parsed TAP from stdout." };
    }
    case "pytest": {
      const args = ["-m", "pytest", `--junitxml=${reportPath}`, "-o", "junit_family=xunit1", "--tb=short", ...(filter ? ["-k", filter] : []), ...files];
      const cands = pythonCandidates();
      return { cmd: cands[0], args, alternates: cands.slice(1), format: "junit", source: "file", display: displayCommand(cands[0], args, root, reportPath) };
    }
    case "go": {
      const pkgs = [...new Set(files.map((f) => {
        const d = path.dirname(f);
        const rel = d === "." ? "." : d.split(path.sep).join("/");
        return rel === "." ? "." : rel.startsWith("..") ? rel : `./${rel}`;
      }))];
      const args = ["test", "-json", ...(filter ? ["-run", filter] : []), ...(pkgs.length ? pkgs : ["./..."])];
      return { cmd: "go", args, format: "go-json", source: "stdout", display: displayCommand("go", args, root, reportPath) };
    }
    default:
      throw new Error(`Unknown runner: ${runner}. Use one of ${RUNNERS.join(", ")}.`);
  }
}

/**
 * Kill a process and its children.
 * @param {import("node:child_process").ChildProcess} child
 */
function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * @typedef {{code: number | null, signal: string | null, stdout: string, stderr: string, timedOut: boolean, spawnError?: NodeJS.ErrnoException}} ExecResult
 */

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd: string, timeoutMs: number}} o
 * @returns {Promise<ExecResult>}
 */
export function execCapture(cmd, args, o) {
  return new Promise((resolve) => {
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, NO_COLOR: "1", CI: "1" };
    delete env.NODE_TEST_CONTEXT;
    delete env.FORCE_COLOR;
    let child;
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, spawnError: /** @type {NodeJS.ErrnoException} */ (e) });
      return;
    }
    let out = "", err = "", timedOut = false, done = false;
    child.stdout.setEncoding("utf8").on("data", (d) => { if (out.length < MAX_CAPTURE) out += d; });
    child.stderr.setEncoding("utf8").on("data", (d) => { if (err.length < MAX_CAPTURE) err += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, o.timeoutMs);
    /** @param {ExecResult} r */
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.on("error", (e) => finish({ code: null, signal: null, stdout: out, stderr: err, timedOut, spawnError: /** @type {NodeJS.ErrnoException} */ (e) }));
    child.on("close", (code, signal) => finish({ code, signal, stdout: out, stderr: err, timedOut }));
  });
}

/**
 * @typedef {{
 *   runner: string, command: string, exitCode: number | null, timedOut: boolean,
 *   report?: Report, crashTail?: string, notes: string[]
 * }} RunOutcome
 */

/**
 * Run tests and parse the machine-readable report.
 * @param {{root: string, dir: string, runner: string, filter?: string, files?: string[], timeoutMs: number}} o
 * @returns {Promise<RunOutcome>}
 */
export async function runTests(o) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-report-"));
  const reportPath = path.join(tmp, "report.out");
  try {
    const inv = buildInvocation(o.runner, { root: o.root, dir: o.dir, filter: o.filter, files: o.files, reportPath });
    /** @type {string[]} */
    const notes = inv.note ? [inv.note] : [];
    /** @type {ExecResult} */
    let res = await execCapture(inv.cmd, inv.args, { cwd: o.dir, timeoutMs: o.timeoutMs });
    for (const alt of inv.alternates ?? []) {
      if (res.spawnError?.code !== "ENOENT") break;
      res = await execCapture(alt, inv.args, { cwd: o.dir, timeoutMs: o.timeoutMs });
    }
    const base = { runner: o.runner, command: inv.display, exitCode: res.code, timedOut: res.timedOut, notes };
    const combined = `${res.stdout}\n${res.stderr}`;
    const crash = (/** @type {string} */ why) => {
      notes.push(why);
      const tail = tailLines(combined || (res.spawnError ? String(res.spawnError.message) : ""), 60).join("\n");
      return { ...base, crashTail: clipEnd(tail, 8000) };
    };
    if (res.spawnError) return crash(`Could not start ${inv.cmd}: ${res.spawnError.code ?? res.spawnError.message}. Is it installed and on PATH?`);
    if (res.timedOut) return crash(`Timed out after ${o.timeoutMs} ms and was killed. Showing the last output.`);

    /** @type {string | undefined} */
    let text;
    if (inv.source === "stdout") {
      text = res.stdout;
    } else if (fs.existsSync(reportPath) && fs.statSync(reportPath).size > 0) {
      text = fs.readFileSync(reportPath, "utf8");
    } else if (inv.format === "mocha-json") {
      const i = res.stdout.search(/^\{\s*\n\s*"stats"/m);
      if (i >= 0) text = res.stdout.slice(i);
    }
    if (text === undefined || !text.trim()) {
      return crash(`The runner exited with code ${res.code} before producing a report. Showing the last output.`);
    }
    try {
      const report = parseByFormat(inv.format, text, { roots: roots(o.root) });
      if (report.summary.total === 0 && report.failures.length === 0 && res.code) {
        notes.push(`Runner exited with code ${res.code} and reported no tests.`);
        return { ...base, report, crashTail: clipEnd(tailLines(combined, 60).join("\n"), 8000) };
      }
      if (res.code && report.failures.length === 0 && report.summary.failed + report.summary.errors === 0) {
        notes.push(`Runner exited with code ${res.code} but the report lists no failures.`);
      }
      return { ...base, report };
    } catch (e) {
      return crash(`The report could not be parsed (${/** @type {Error} */ (e).message}). Showing the last output.`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Root path variants (symlink-resolved too) used to relativize output.
 * @param {string} root
 */
export function roots(root) {
  const out = [root];
  try {
    const r = fs.realpathSync(root);
    if (r !== root) out.push(r);
  } catch {
    /* ignore */
  }
  return out;
}

