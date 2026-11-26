// @ts-check
import { RULES } from "./rules.js";

/**
 * @typedef {import("./rules.js").Finding} Finding
 * @typedef {import("./rules.js").RuleDef} RuleDef
 */

/**
 * Summarize findings counts.
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
 * Format findings as a concise human-readable report.
 * @param {Finding[]} findings
 * @param {{
 *   scannedFiles: number,
 *   skippedLarge?: string[],
 *   mcpItems?: number,
 *   strict?: boolean,
 *   quiet?: boolean,
 *   modeLabel?: string,
 * }} meta
 * @returns {string}
 */
export function formatHumanCheck(findings, meta) {
  const counts = summarizeFindings(findings);
  const blocked = counts.errors > 0 || (Boolean(meta.strict) && counts.warnings > 0);
  if (meta.quiet && !blocked) return "";

  const lines = [];
  const scopeParts = [`${meta.scannedFiles} file(s)`];
  if (meta.mcpItems && meta.mcpItems > 0) {
    scopeParts.push(`${meta.mcpItems} MCP item(s)`);
  }
  const mode = meta.modeLabel ? ` (${meta.modeLabel})` : "";
  lines.push(`prompt-shield: scanned ${scopeParts.join(", ")}${mode}`);

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
    }
  }

  lines.push("");
  lines.push(`Summary: ${counts.errors} error(s), ${counts.warnings} warning(s)`);
  lines.push(`Status: ${blocked ? "FAILED" : "OK"}`);
  return lines.join("\n") + "\n";
}

/**
 * Format check report as JSON.
 * @param {Finding[]} findings
 * @param {{
 *   scannedFiles: number,
 *   skippedLarge?: string[],
 *   mcpItems?: number,
 *   strict?: boolean,
 *   version: string,
 * }} meta
 * @returns {string}
 */
export function formatJsonCheck(findings, meta) {
  const summary = summarizeFindings(findings);
  const ok = summary.errors === 0 && (!meta.strict || summary.warnings === 0);
  return (
    JSON.stringify(
      {
        tool: "prompt-shield",
        version: meta.version,
        ok,
        strict: Boolean(meta.strict),
        scannedFiles: meta.scannedFiles,
        mcpItems: meta.mcpItems ?? 0,
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
 * Format check report as SARIF 2.1.0 for GitHub Code Scanning / CI.
 * @param {Finding[]} findings
 * @param {{ version: string }} meta
 * @returns {string}
 */
export function formatSarifCheck(findings, meta) {
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "prompt-shield",
            version: meta.version,
            informationUri: "https://github.com/1nn0v8r/toolshed/tree/main/tools/prompt-shield",
            rules: RULES.map((r) => ({
              id: r.id,
              shortDescription: { text: r.description },
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
 * Format `strip` command output.
 * @param {{
 *   scannedCount: number,
 *   modifiedFiles: Array<{ file: string, removedCount: number, countsByRule: Record<string, number> }>,
 *   totalRemoved: number,
 * }} result
 * @param {{ dryRun?: boolean, json?: boolean, version: string }} opts
 * @returns {string}
 */
export function formatStripResult(result, opts) {
  if (opts.json) {
    return (
      JSON.stringify(
        {
          tool: "prompt-shield",
          version: opts.version,
          dryRun: Boolean(opts.dryRun),
          scannedFiles: result.scannedCount,
          modifiedCount: result.modifiedFiles.length,
          totalRemoved: result.totalRemoved,
          modifiedFiles: result.modifiedFiles,
        },
        null,
        2,
      ) + "\n"
    );
  }

  const lines = [];
  const verb = opts.dryRun ? "Would strip" : "Stripped";
  if (result.modifiedFiles.length === 0) {
    lines.push(`prompt-shield: scanned ${result.scannedCount} file(s); no invisible Unicode found.`);
  } else {
    lines.push(
      `prompt-shield: ${verb} ${result.totalRemoved} invisible character(s) across ${result.modifiedFiles.length} file(s):`,
    );
    for (const item of result.modifiedFiles) {
      lines.push(`  - ${item.file} (${item.removedCount} removed)`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Format `rules` subcommand output.
 * @param {RuleDef[]} rules
 * @param {Set<string>} ignored
 * @param {boolean} asJson
 * @returns {string}
 */
export function formatRulesList(rules, ignored, asJson) {
  if (asJson) {
    return (
      JSON.stringify(
        rules.map((r) => ({
          ...r,
          enabled: !ignored.has(r.id),
        })),
        null,
        2,
      ) + "\n"
    );
  }
  const lines = ["prompt-shield rules:"];
  for (const r of rules) {
    const state = ignored.has(r.id) ? "disabled" : r.severity.toUpperCase().padEnd(5);
    lines.push(`  [${state}] ${r.id.padEnd(32)} ${r.description}`);
  }
  return lines.join("\n") + "\n";
}
