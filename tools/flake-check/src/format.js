// @ts-check
import { RULES } from "./rules.js";

/**
 * @typedef {import("./rules.js").Finding} Finding
 * @typedef {import("./runner.js").StressRunReport} StressRunReport
 */

/**
 * Summarize static findings counts.
 * @param {Finding[]} findings
 * @returns {{ total: number, errors: number, warnings: number }}
 */
export function summarizeFindings(findings) {
  let errors = 0;
  let warnings = 0;
  for (const f of findings) {
    if (f.severity === "error") errors += 1;
    else warnings += 1;
  }
  return { total: findings.length, errors, warnings };
}

/**
 * Format static scan findings for terminal output.
 * @param {Finding[]} findings
 * @param {{
 *   scannedFiles: number,
 *   skippedLarge?: string[],
 *   strict?: boolean,
 *   quiet?: boolean,
 *   modeLabel?: string,
 * }} meta
 * @returns {string}
 */
export function formatHumanScan(findings, meta) {
  const counts = summarizeFindings(findings);
  const blocked = counts.errors > 0 || (Boolean(meta.strict) && counts.warnings > 0);
  if (meta.quiet && !blocked) return "";

  const lines = [];
  const mode = meta.modeLabel ? ` (${meta.modeLabel})` : "";
  lines.push(`flake-check: scanned ${meta.scannedFiles} test file(s)${mode}`);

  if (meta.skippedLarge && meta.skippedLarge.length > 0) {
    lines.push(`Skipped ${meta.skippedLarge.length} oversized file(s) (> maxFileSizeKB).`);
  }

  if (findings.length > 0) {
    lines.push("");
    lines.push(`Findings (${findings.length}):`);
    for (const f of findings) {
      const tag = f.severity === "error" ? "[ERROR]" : "[WARN] ";
      lines.push(`  ${tag} ${f.ruleId} (${f.file}:${f.line}:${f.column}): ${f.message}`);
      if (f.snippet) {
        lines.push(`          ${f.snippet}`);
      }
      lines.push(`          Fix: ${f.fix}`);
    }
  }

  lines.push("");
  lines.push(`Summary: ${counts.errors} error(s), ${counts.warnings} warning(s)`);
  lines.push(`Status: ${blocked ? "FAILED" : "OK"}`);
  return lines.join("\n") + "\n";
}

/**
 * Format static scan report as JSON.
 * @param {Finding[]} findings
 * @param {{
 *   scannedFiles: number,
 *   skippedLarge?: string[],
 *   strict?: boolean,
 *   version: string,
 * }} meta
 * @returns {string}
 */
export function formatJsonScan(findings, meta) {
  const summary = summarizeFindings(findings);
  const ok = summary.errors === 0 && (!meta.strict || summary.warnings === 0);
  return (
    JSON.stringify(
      {
        tool: "flake-check",
        mode: "scan",
        version: meta.version,
        ok,
        strict: Boolean(meta.strict),
        scannedFiles: meta.scannedFiles,
        skippedLarge: meta.skippedLarge ?? [],
        summary,
        findings,
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Format static scan report as compact Markdown for PR comments or AI context.
 * @param {Finding[]} findings
 * @param {{
 *   scannedFiles: number,
 *   strict?: boolean,
 * }} meta
 * @returns {string}
 */
export function formatMarkdownScan(findings, meta) {
  const summary = summarizeFindings(findings);
  const blocked = summary.errors > 0 || (Boolean(meta.strict) && summary.warnings > 0);
  const lines = [
    `## flake-check static scan (${blocked ? "FAILED" : "OK"})`,
    "",
    `- **Test files scanned:** ${meta.scannedFiles}`,
    `- **Findings:** ${summary.errors} error(s), ${summary.warnings} warning(s)`,
  ];

  if (findings.length > 0) {
    lines.push("", "| Severity | Rule | Location | Message |", "|---|---|---|---|");
    for (const f of findings) {
      const msg = f.message.replace(/\|/g, "\\|");
      lines.push(`| ${f.severity} | \`${f.ruleId}\` | \`${f.file}:${f.line}\` | ${msg} |`);
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * Format static scan report as SARIF 2.1.0.
 * @param {Finding[]} findings
 * @param {{ version: string }} meta
 * @returns {string}
 */
export function formatSarifScan(findings, meta) {
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "flake-check",
            version: meta.version,
            informationUri: "https://github.com/1nn0v8r/toolshed/tree/main/tools/flake-check",
            rules: RULES.map((r) => ({
              id: r.id,
              shortDescription: { text: r.title },
              fullDescription: { text: r.description },
              help: { text: r.fix },
              defaultConfiguration: {
                level: r.severity === "error" ? "error" : "warning",
              },
            })),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.ruleId,
          level: f.severity === "error" ? "error" : "warning",
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file },
                region: {
                  startLine: Math.max(1, f.line),
                  startColumn: Math.max(1, f.column),
                },
              },
            },
          ],
        })),
      },
    ],
  };

  return JSON.stringify(sarif, null, 2) + "\n";
}

/**
 * Format stress-run report for terminal output.
 * @param {StressRunReport} report
 * @param {{ quiet?: boolean }} [meta]
 * @returns {string}
 */
export function formatHumanRun(report, meta = {}) {
  if (meta.quiet && report.verdict === "PASS") return "";

  const lines = [
    `flake-check run: ${report.command}`,
    `Completed ${report.completedRuns}/${report.totalRuns} run(s)${report.stoppedEarly ? " (stopped early on flake)" : ""}: ${report.passedRuns} passed, ${report.failedRuns} failed`,
    `Timing: min=${report.timing.minMs}ms median=${report.timing.medianMs}ms p95=${report.timing.p95Ms}ms max=${report.timing.maxMs}ms (CV ${report.timing.cvPercent}%)`,
  ];

  const flakyCases = report.testCases.filter((c) => c.flaky);
  const failingCases = report.testCases.filter((c) => !c.flaky && c.failed > 0);

  if (flakyCases.length > 0) {
    lines.push("", `Flaky test cases (${flakyCases.length}):`);
    for (const c of flakyCases) {
      lines.push(`  [FLAKY] ${c.name} (${c.passed}/${c.runs} passed, ${c.failed}/${c.runs} failed)`);
    }
  }

  if (failingCases.length > 0) {
    lines.push("", `Consistently failing test cases (${failingCases.length}):`);
    for (const c of failingCases) {
      lines.push(`  [FAIL]  ${c.name} (${c.failed}/${c.runs} failed)`);
    }
  }

  const failedRuns = report.runs.filter((r) => !r.passed);
  if (failedRuns.length > 0) {
    lines.push("", "Sample failure output:");
    const sample = failedRuns[0];
    const tag = sample.timedOut ? "TIMEOUT" : `exit ${sample.exitCode}`;
    lines.push(`  Run #${sample.runIndex} (${tag}, ${sample.durationMs}ms):`);
    if (sample.failureSnippet) {
      for (const line of sample.failureSnippet.split("\n")) {
        lines.push(`    ${line}`);
      }
    }
  }

  lines.push("", `Verdict: ${report.verdict}`);
  return lines.join("\n") + "\n";
}

/**
 * Format stress-run report as JSON.
 * @param {StressRunReport} report
 * @param {{ version: string }} meta
 * @returns {string}
 */
export function formatJsonRun(report, meta) {
  return (
    JSON.stringify(
      {
        tool: "flake-check",
        mode: "run",
        version: meta.version,
        ok: report.verdict === "PASS",
        ...report,
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Format stress-run report as Markdown.
 * @param {StressRunReport} report
 * @returns {string}
 */
export function formatMarkdownRun(report) {
  const lines = [
    `## flake-check stress run (${report.verdict})`,
    "",
    `- **Command:** \`${report.command}\``,
    `- **Runs:** ${report.passedRuns}/${report.completedRuns} passed (${report.failedRuns} failed)`,
    `- **Timing:** min ${report.timing.minMs}ms | median ${report.timing.medianMs}ms | p95 ${report.timing.p95Ms}ms | max ${report.timing.maxMs}ms (CV ${report.timing.cvPercent}%)`,
  ];

  const flakyCases = report.testCases.filter((c) => c.flaky);
  if (flakyCases.length > 0) {
    lines.push("", "### Flaky test cases", "", "| Test case | Passed | Failed |", "|---|---|---|");
    for (const c of flakyCases) {
      lines.push(`| \`${c.name.replace(/\|/g, "\\|")}\` | ${c.passed}/${c.runs} | ${c.failed}/${c.runs} |`);
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * Format the rules table.
 * @param {Set<string>} ignored
 * @returns {string}
 */
export function formatRulesList(ignored) {
  const lines = ["flake-check rules:", ""];
  for (const r of RULES) {
    const status = ignored.has(r.id) ? "disabled" : "enabled ";
    lines.push(`  ${r.id.padEnd(24)} ${r.severity.padEnd(6)} [${status}]  ${r.description}`);
  }
  lines.push("");
  return lines.join("\n");
}
