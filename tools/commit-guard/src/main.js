// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.js";
import { ConfigError, loadConfig, resolveRules } from "./config.js";
import { parseDiff } from "./diff.js";
import { formatFinding, formatJson, formatRules, formatSummary, summarize } from "./format.js";
import { GitMissingError, repoRoot, stagedDiff, stagedFiles, stagedSizes, trackedFiles } from "./git.js";
import { makeMatcher } from "./glob.js";
import { installHook, uninstallHook } from "./hook.js";
import { isBinary, scanFileRules, scanLines, textToLines } from "./scan.js";

export const VERSION = "0.1.0";
/** Content larger than this is not read for content rules (file.large still applies). */
export const MAX_CONTENT_BYTES = 16 * 1024 * 1024;

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");

const HELP = `commit-guard ${VERSION}
Block commits that contain secrets, personal paths, .env files and oversized files.

Usage:
  commit-guard check [--staged | --all | <files...>] [--json]
  commit-guard install [--force]
  commit-guard uninstall
  commit-guard rules [--json]

Commands:
  check       scan staged additions (default), all tracked files, or the files given
  install     write a git pre-commit hook that runs "check --staged"
  uninstall   remove the hook, only if commit-guard installed it
  rules       list rules and whether they are enabled

Options:
  --staged    scan only added lines of the staged diff (default for check)
  --all       scan every tracked file
  --json      machine-readable output (check, rules)
  --force     replace an existing pre-commit hook (it is backed up)
  -h, --help  show this help
  -v, --version

Exit codes: 0 no errors, 1 errors found, 2 usage or config error.
Config: .commit-guard.json at the repo root.
`;

/**
 * @typedef {{
 *   cwd: string,
 *   out: (s: string) => void,
 *   err: (s: string) => void,
 *   cliPath?: string,
 * }} IO
 */

/** @param {string} p */
const slash = (p) => p.replace(/\\/g, "/");

/**
 * Run the CLI. Returns the process exit code.
 * @param {string[]} argv
 * @param {IO} io
 * @returns {number}
 */
export function run(argv, io) {
  const res = parseArgs(argv);
  if ("help" in res) {
    io.out(HELP);
    return 0;
  }
  if ("version" in res) {
    io.out(VERSION + "\n");
    return 0;
  }
  if ("error" in res) {
    io.err(`commit-guard: ${res.error}\nRun "commit-guard --help" for usage.\n`);
    return 2;
  }
  const { parsed } = res;
  try {
    switch (parsed.command) {
      case "check":
        return runCheck(parsed, io);
      case "rules":
        return runRules(parsed, io);
      case "install":
      case "uninstall":
        return runHook(parsed, io);
      /* c8 ignore next 2 */
      default:
        return 2;
    }
  } catch (e) {
    if (e instanceof ConfigError || e instanceof GitMissingError) {
      io.err(`commit-guard: ${e.message}\n`);
      return 2;
    }
    io.err(`commit-guard: ${/** @type {Error} */ (e).message}\n`);
    return 2;
  }
}

/**
 * @param {import('./args.js').Parsed} parsed
 * @param {IO} io
 */
function runRules(parsed, io) {
  const root = repoRoot(io.cwd) ?? io.cwd;
  const rules = resolveRules(loadConfig(root));
  if (parsed.flags.json) {
    io.out(JSON.stringify(rules.map(({ id, description, severity, enabled }) => ({ id, description, severity, enabled })), null, 2) + "\n");
  } else {
    io.out(formatRules(rules) + "\n");
  }
  return 0;
}

/**
 * @param {import('./args.js').Parsed} parsed
 * @param {IO} io
 */
function runHook(parsed, io) {
  const root = repoRoot(io.cwd);
  if (!root) {
    io.err("commit-guard: not inside a git repository\n");
    return 2;
  }
  const r =
    parsed.command === "install"
      ? installHook(root, { force: parsed.flags.force, cliPath: io.cliPath ?? CLI_PATH })
      : uninstallHook(root);
  (r.code === 0 ? io.out : io.err)(r.message + "\n");
  return r.code;
}

/**
 * @param {import('./args.js').Parsed} parsed
 * @param {IO} io
 */
function runCheck(parsed, io) {
  const explicit = parsed.files.length > 0;
  const mode = explicit ? "files" : parsed.flags.all ? "all" : "staged";
  const root = repoRoot(io.cwd);
  if (!root && mode !== "files") {
    io.err("commit-guard: not inside a git repository\n");
    return 2;
  }
  const base = root ?? io.cwd;
  const cfg = loadConfig(base);
  const opts = {
    rules: resolveRules(cfg),
    allow: cfg.allow.map((p) => new RegExp(p)),
    maxFileSizeKB: cfg.maxFileSizeKB,
  };
  const ignored = makeMatcher(cfg.ignoreFiles);

  /** @type {import('./scan.js').Finding[]} */
  const findings = [];
  let scanned = 0;

  /**
   * @param {string} abs
   * @param {string} rel
   * @param {number} size
   */
  const scanWorkingFile = (abs, rel, size) => {
    scanned++;
    findings.push(...scanFileRules(rel, size, opts));
    if (size > MAX_CONTENT_BYTES) return;
    const buf = fs.readFileSync(abs);
    if (isBinary(buf)) return;
    findings.push(...scanLines(rel, textToLines(buf.toString("utf8")), opts));
  };

  if (mode === "staged") {
    const rootDir = /** @type {string} */ (root);
    const diffs = new Map(parseDiff(stagedDiff(rootDir)).map((d) => [d.path, d]));
    const files = stagedFiles(rootDir).filter((f) => !ignored(slash(f)));
    const sizes = stagedSizes(rootDir, files);
    for (const f of files) {
      scanned++;
      findings.push(...scanFileRules(slash(f), sizes.get(f), opts));
      const d = diffs.get(f);
      if (d) findings.push(...scanLines(slash(f), d.added, opts));
    }
  } else if (mode === "all") {
    const rootDir = /** @type {string} */ (root);
    for (const f of trackedFiles(rootDir)) {
      const rel = slash(f);
      if (ignored(rel)) continue;
      const abs = path.join(rootDir, f);
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      scanWorkingFile(abs, rel, st.size);
    }
  } else {
    for (const f of parsed.files) {
      const abs = path.resolve(io.cwd, f);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        io.err(`commit-guard: cannot read ${f}\n`);
        return 2;
      }
      if (!st.isFile()) {
        io.err(`commit-guard: ${f} is not a file\n`);
        return 2;
      }
      let rel = slash(path.relative(base, abs));
      if (rel.startsWith("..") || path.isAbsolute(rel)) rel = slash(abs);
      if (ignored(rel)) continue;
      scanWorkingFile(abs, rel, st.size);
    }
  }

  findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.column - b.column));
  const summary = summarize(findings, scanned);
  if (parsed.flags.json) {
    io.out(formatJson(findings, summary) + "\n");
  } else {
    for (const f of findings) io.out(formatFinding(f) + "\n");
    io.out(formatSummary(summary) + "\n");
    if (summary.errors > 0) {
      io.out(
        'Fix the findings, add "commit-guard: ignore" to a line, or add allow/ignoreFiles to .commit-guard.json.\n',
      );
    }
  }
  return summary.errors > 0 ? 1 : 0;
}
