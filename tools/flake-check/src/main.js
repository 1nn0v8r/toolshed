// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, STARTER_CONFIG } from "./config.js";
import {
  formatHumanRun,
  formatHumanScan,
  formatJsonRun,
  formatJsonScan,
  formatMarkdownRun,
  formatMarkdownScan,
  formatRulesList,
  formatSarifScan,
  summarizeFindings,
} from "./format.js";
import { runStressChecks } from "./runner.js";
import { scanRepository } from "./scanner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(here, "..", "package.json");
const VERSION = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;

const HELP_TEXT = `
flake-check - Catch flaky tests and non-deterministic test patterns before CI does.

Usage:
  flake-check [scan] [paths...] [options]     Scan test files for flakiness anti-patterns
  flake-check run [options] -- <command...>   Stress-run a test command N times to detect flakes
  flake-check rules [--config <path>]         List built-in static rules and status
  flake-check init [--force]                  Create a starter .flake-check.json

Scan options:
  --staged              Scan staged git test files
  --changed             Scan modified & untracked test files
  --diff <ref>          Scan test files changed compared to <ref> (e.g. main)
  --strict              Treat warnings as blocking errors (exit 1)
  --ignore-rule <id>    Disable a rule (repeatable)
  --config <path>       Path to .flake-check.json
  --json                Output JSON report
  --md                  Output Markdown summary
  --sarif               Output SARIF 2.1.0 report
  --quiet, -q           Suppress output when status is OK

Run options:
  --runs <n>, -n <n>    Number of repetitions (default: 5)
  --jobs <n>, -j <n>    Concurrent workers (default: 1)
  --stop-on-flake       Stop early once both a pass and a fail occur
  --timeout <ms>        Per-run timeout in milliseconds (default: 60000)
  --cwd <dir>           Working directory for the test command
  --verbose             Print each run's status to stderr as it finishes
  --json                Output JSON report
  --md                  Output Markdown summary
  --quiet, -q           Suppress output when all runs pass

General:
  -h, --help            Show this help message
  -v, --version         Show version
`.trimStart();

/**
 * Parse positive integer flag values strictly.
 * @param {string} flag
 * @param {string | undefined} raw
 * @param {number} min
 * @returns {number}
 */
function parsePositiveInt(flag, raw, min = 1) {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error(`Flag ${flag} requires an integer >= ${min}.`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min) {
    throw new Error(`Flag ${flag} requires an integer >= ${min}.`);
  }
  return n;
}

/**
 * Parse CLI arguments into a structured command request.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const dashDashIdx = argv.indexOf("--");
  const headArgs = dashDashIdx >= 0 ? argv.slice(0, dashDashIdx) : argv;
  const cmdArgs = dashDashIdx >= 0 ? argv.slice(dashDashIdx + 1) : [];

  let subcommand = "scan";
  let idx = 0;
  if (headArgs[0] && !headArgs[0].startsWith("-")) {
    if (["scan", "run", "stress", "rules", "init"].includes(headArgs[0])) {
      subcommand = headArgs[0] === "stress" ? "run" : headArgs[0];
      idx = 1;
    }
  } else if (dashDashIdx >= 0 && headArgs.length === 0) {
    subcommand = "run";
  }

  /** @type {{
   *   subcommand: string,
   *   targets: string[],
   *   cmdArgs: string[],
   *   staged: boolean,
   *   changed: boolean,
   *   diffRef: string | undefined,
   *   strict: boolean | undefined,
   *   quiet: boolean,
   *   verbose: boolean,
   *   force: boolean,
   *   stopOnFlake: boolean,
   *   format: "human" | "json" | "md" | "sarif",
   *   configPath: string | undefined,
   *   cwdOverride: string | undefined,
   *   ignoreRules: string[],
   *   runs: number | undefined,
   *   jobs: number | undefined,
   *   timeoutMs: number | undefined,
   *   help: boolean,
   *   version: boolean,
   * }} */
  const opts = {
    subcommand,
    targets: [],
    cmdArgs,
    staged: false,
    changed: false,
    diffRef: undefined,
    strict: undefined,
    quiet: false,
    verbose: false,
    force: false,
    stopOnFlake: false,
    format: "human",
    configPath: undefined,
    cwdOverride: undefined,
    ignoreRules: [],
    runs: undefined,
    jobs: undefined,
    timeoutMs: undefined,
    help: false,
    version: false,
  };

  for (let i = idx; i < headArgs.length; i++) {
    const a = headArgs[i];
    if (a === "-h" || a === "--help") {
      opts.help = true;
    } else if (a === "-v" || a === "--version") {
      opts.version = true;
    } else if (a === "--staged") {
      opts.staged = true;
    } else if (a === "--changed") {
      opts.changed = true;
    } else if (a === "--diff") {
      const val = headArgs[++i];
      if (!val) throw new Error("--diff requires a git ref.");
      opts.diffRef = val;
    } else if (a.startsWith("--diff=")) {
      opts.diffRef = a.slice(7);
    } else if (a === "--strict") {
      opts.strict = true;
    } else if (a === "--quiet" || a === "-q") {
      opts.quiet = true;
    } else if (a === "--verbose") {
      opts.verbose = true;
    } else if (a === "--force") {
      opts.force = true;
    } else if (a === "--stop-on-flake") {
      opts.stopOnFlake = true;
    } else if (a === "--json") {
      opts.format = "json";
    } else if (a === "--md" || a === "--markdown") {
      opts.format = "md";
    } else if (a === "--sarif") {
      opts.format = "sarif";
    } else if (a === "--config") {
      const val = headArgs[++i];
      if (!val) throw new Error("--config requires a file path.");
      opts.configPath = val;
    } else if (a.startsWith("--config=")) {
      opts.configPath = a.slice(9);
    } else if (a === "--cwd") {
      const val = headArgs[++i];
      if (!val) throw new Error("--cwd requires a directory path.");
      opts.cwdOverride = val;
    } else if (a.startsWith("--cwd=")) {
      opts.cwdOverride = a.slice(6);
    } else if (a === "--ignore-rule") {
      const val = headArgs[++i];
      if (!val) throw new Error("--ignore-rule requires a rule ID.");
      opts.ignoreRules.push(val);
    } else if (a.startsWith("--ignore-rule=")) {
      opts.ignoreRules.push(a.slice(14));
    } else if (a === "--runs" || a === "-n") {
      opts.runs = parsePositiveInt(a, headArgs[++i], 1);
    } else if (a.startsWith("--runs=")) {
      opts.runs = parsePositiveInt("--runs", a.slice(7), 1);
    } else if (a === "--jobs" || a === "-j") {
      opts.jobs = parsePositiveInt(a, headArgs[++i], 1);
    } else if (a.startsWith("--jobs=")) {
      opts.jobs = parsePositiveInt("--jobs", a.slice(7), 1);
    } else if (a === "--timeout") {
      opts.timeoutMs = parsePositiveInt("--timeout", headArgs[++i], 100);
    } else if (a.startsWith("--timeout=")) {
      opts.timeoutMs = parsePositiveInt("--timeout", a.slice(10), 100);
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      if (subcommand === "run" && opts.cmdArgs.length === 0) {
        // Support `flake-check run npm test` without `--`
        opts.cmdArgs = headArgs.slice(i);
        break;
      }
      opts.targets.push(a);
    }
  }

  // Convenience: `flake-check --runs 3 -- npm test` defaults to run mode
  if (subcommand === "scan" && opts.cmdArgs.length > 0) {
    opts.subcommand = "run";
  }

  return opts;
}

/**
 * CLI entrypoint.
 * @param {string[]} argv
 * @param {{ cwd?: string, out?: (s: string) => void, err?: (s: string) => void }} [io]
 * @returns {Promise<number>}
 */
export async function run(argv, io = {}) {
  const cwd = io.cwd ?? process.cwd();
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`flake-check: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  if (opts.help) {
    out(HELP_TEXT);
    return 0;
  }

  if (opts.version) {
    out(`flake-check ${VERSION}\n`);
    return 0;
  }

  let loaded;
  try {
    loaded = loadConfig(cwd, opts.configPath);
  } catch (e) {
    err(`flake-check: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const { config } = loaded;

  if (opts.subcommand === "init") {
    const targetPath = path.join(cwd, ".flake-check.json");
    if (fs.existsSync(targetPath) && !opts.force) {
      err(`flake-check: ${targetPath} already exists (pass --force to overwrite).\n`);
      return 2;
    }
    fs.writeFileSync(targetPath, STARTER_CONFIG, "utf8");
    out(`Created ${targetPath}\n`);
    return 0;
  }

  if (opts.subcommand === "rules") {
    const ignored = new Set([...config.ignoreRules, ...opts.ignoreRules]);
    out(formatRulesList(ignored));
    return 0;
  }

  if (opts.subcommand === "run") {
    if (opts.cmdArgs.length === 0) {
      err("flake-check: `run` requires a test command (e.g. `flake-check run -- npm test`).\n");
      return 2;
    }
    const runCwd = opts.cwdOverride ? path.resolve(cwd, opts.cwdOverride) : cwd;
    if (!fs.existsSync(runCwd) || !fs.statSync(runCwd).isDirectory()) {
      err(`flake-check: --cwd directory does not exist: ${runCwd}\n`);
      return 2;
    }

    const runs = opts.runs ?? config.runs;
    const jobs = opts.jobs ?? config.jobs;
    const timeoutMs = opts.timeoutMs ?? config.timeoutMs;

    const report = await runStressChecks(opts.cmdArgs, {
      cwd: runCwd,
      runs,
      jobs,
      timeoutMs,
      stopOnFlake: opts.stopOnFlake,
      onProgress: (res) => {
        if (opts.verbose && opts.format === "human" && !opts.quiet) {
          const tag = res.passed ? "PASS" : res.timedOut ? "TIMEOUT" : "FAIL";
          err(`  run #${res.runIndex}/${runs}: ${tag} (${res.durationMs}ms)\n`);
        }
      },
    });

    if (opts.format === "json") {
      out(formatJsonRun(report, { version: VERSION }));
    } else if (opts.format === "md") {
      out(formatMarkdownRun(report));
    } else if (opts.format === "sarif") {
      err("flake-check: --sarif is only supported for `scan`.\n");
      return 2;
    } else {
      out(formatHumanRun(report, { quiet: opts.quiet }));
    }

    return report.verdict === "PASS" ? 0 : 1;
  }

  // Static scan
  const strict = opts.strict ?? config.strict;
  let scanRes;
  try {
    scanRes = scanRepository({
      cwd,
      targets: opts.targets,
      staged: opts.staged,
      changed: opts.changed,
      diffRef: opts.diffRef,
      config,
      extraIgnoreRules: opts.ignoreRules,
    });
  } catch (e) {
    err(`flake-check: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  const modeLabel = opts.staged
    ? "staged tests"
    : opts.diffRef
      ? `diff vs ${opts.diffRef}`
      : opts.changed
        ? "changed tests"
        : opts.targets.length > 0
          ? "targeted scan"
          : "repo scan";

  if (opts.format === "json") {
    out(
      formatJsonScan(scanRes.findings, {
        scannedFiles: scanRes.scannedFiles,
        skippedLarge: scanRes.skippedLarge,
        strict,
        version: VERSION,
      }),
    );
  } else if (opts.format === "md") {
    out(
      formatMarkdownScan(scanRes.findings, {
        scannedFiles: scanRes.scannedFiles,
        strict,
      }),
    );
  } else if (opts.format === "sarif") {
    out(formatSarifScan(scanRes.findings, { version: VERSION }));
  } else {
    out(
      formatHumanScan(scanRes.findings, {
        scannedFiles: scanRes.scannedFiles,
        skippedLarge: scanRes.skippedLarge,
        strict,
        quiet: opts.quiet,
        modeLabel,
      }),
    );
  }

  const summary = summarizeFindings(scanRes.findings);
  const blocked = summary.errors > 0 || (strict && summary.warnings > 0);
  return blocked ? 1 : 0;
}
