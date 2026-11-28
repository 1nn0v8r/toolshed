// @ts-check
import path from "node:path";
import { spawn } from "node:child_process";
import { aggregateTestCases, parseTestCases, stripAnsi } from "./parsers.js";

/**
 * @typedef {import("./parsers.js").ParsedTestCase} ParsedTestCase
 * @typedef {import("./parsers.js").AggregatedTestCase} AggregatedTestCase
 * @typedef {{
 *   runIndex: number,
 *   passed: boolean,
 *   exitCode: number | null,
 *   timedOut: boolean,
 *   durationMs: number,
 *   cases: ParsedTestCase[],
 *   failureSnippet: string,
 * }} SingleRunResult
 * @typedef {{
 *   minMs: number,
 *   medianMs: number,
 *   p95Ms: number,
 *   maxMs: number,
 *   meanMs: number,
 *   cvPercent: number,
 * }} TimingStats
 * @typedef {{
 *   verdict: "PASS" | "FLAKY" | "FAIL",
 *   command: string,
 *   totalRuns: number,
 *   completedRuns: number,
 *   passedRuns: number,
 *   failedRuns: number,
 *   stoppedEarly: boolean,
 *   timing: TimingStats,
 *   runs: SingleRunResult[],
 *   testCases: AggregatedTestCase[],
 * }} StressRunReport
 */

/**
 * Compute timing statistics from run durations in milliseconds.
 * @param {number[]} durations
 * @returns {TimingStats}
 */
export function computeTimingStats(durations) {
  if (durations.length === 0) {
    return { minMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0, meanMs: 0, cvPercent: 0 };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const n = sorted.length;
  const minMs = sorted[0];
  const maxMs = sorted[n - 1];
  const medianMs =
    n % 2 === 1 ? sorted[(n - 1) / 2] : Math.round((sorted[n / 2 - 1] + sorted[n / 2]) / 2);
  const p95Idx = Math.min(n - 1, Math.ceil(n * 0.95) - 1);
  const p95Ms = sorted[p95Idx];
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const meanMs = Math.round(sum / n);

  let cvPercent = 0;
  if (n > 1 && meanMs > 0) {
    const variance =
      sorted.reduce((acc, v) => acc + (v - sum / n) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);
    cvPercent = Math.round((stdDev / (sum / n)) * 1000) / 10;
  }

  return { minMs, medianMs, p95Ms, maxMs, meanMs, cvPercent };
}

/**
 * Extract a concise tail/error snippet from failed run output.
 * @param {string} output
 * @returns {string}
 */
function extractFailureSnippet(output) {
  const clean = stripAnsi(output)
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (clean.length === 0) return "";
  const errIdx = clean.findIndex((l) =>
    /\b(?:Error|AssertionError|FAIL|FAILED|not ok|panic:)\b/.test(l),
  );
  const slice =
    errIdx >= 0
      ? clean.slice(Math.max(0, errIdx - 1), errIdx + 8)
      : clean.slice(-8);
  return slice.join("\n").slice(0, 800);
}

/**
 * Execute one command run with timeout handling.
 * @param {string[]} cmdArgs
 * @param {{ cwd: string, timeoutMs: number }} opts
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean, durationMs: number, output: string }>}
 */
function executeOnce(cmdArgs, opts) {
  return new Promise((resolve) => {
    const [bin, ...args] = cmdArgs;
    const isDirectNodeOrAbs =
      bin === process.execPath || path.isAbsolute(bin) || bin === "node";
    const useShell = process.platform === "win32" && !isDirectNodeOrAbs;

    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(bin, args, {
      cwd: opts.cwd,
      shell: useShell,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1500).unref();
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 512_000) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 512_000) stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: 127,
        timedOut: false,
        durationMs: Date.now() - start,
        output: `${stdout}\n${stderr}\n${err.message}`,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        timedOut,
        durationMs: Date.now() - start,
        output: [stdout, stderr].filter(Boolean).join("\n"),
      });
    });
  });
}

/**
 * Run a test command repeatedly to detect intermittent failures and timing outliers.
 * @param {string[]} cmdArgs
 * @param {{
 *   cwd: string,
 *   runs: number,
 *   jobs: number,
 *   timeoutMs: number,
 *   stopOnFlake?: boolean,
 *   onProgress?: (res: SingleRunResult) => void,
 * }} options
 * @returns {Promise<StressRunReport>}
 */
export async function runStressChecks(cmdArgs, options) {
  const totalRuns = Math.max(1, options.runs);
  const concurrency = Math.min(totalRuns, Math.max(1, options.jobs));
  /** @type {SingleRunResult[]} */
  const results = [];
  let nextRun = 1;
  let sawPass = false;
  let sawFail = false;
  let stoppedEarly = false;

  async function worker() {
    while (true) {
      if (options.stopOnFlake && sawPass && sawFail) {
        stoppedEarly = true;
        return;
      }
      const runIndex = nextRun++;
      if (runIndex > totalRuns) return;

      const execRes = await executeOnce(cmdArgs, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
      });

      const passed = !execRes.timedOut && execRes.exitCode === 0;
      if (passed) sawPass = true;
      else sawFail = true;

      const cases = parseTestCases(execRes.output);
      /** @type {SingleRunResult} */
      const item = {
        runIndex,
        passed,
        exitCode: execRes.exitCode,
        timedOut: execRes.timedOut,
        durationMs: execRes.durationMs,
        cases,
        failureSnippet: passed ? "" : extractFailureSnippet(execRes.output),
      };
      results.push(item);
      options.onProgress?.(item);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  results.sort((a, b) => a.runIndex - b.runIndex);

  const passedRuns = results.filter((r) => r.passed).length;
  const failedRuns = results.length - passedRuns;
  /** @type {"PASS" | "FLAKY" | "FAIL"} */
  const verdict =
    failedRuns === 0 ? "PASS" : passedRuns === 0 ? "FAIL" : "FLAKY";

  const timing = computeTimingStats(results.map((r) => r.durationMs));
  const testCases = aggregateTestCases(results.map((r) => r.cases));

  return {
    verdict,
    command: cmdArgs.join(" "),
    totalRuns,
    completedRuns: results.length,
    passedRuns,
    failedRuns,
    stoppedEarly,
    timing,
    runs: results,
    testCases,
  };
}
