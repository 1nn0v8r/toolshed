// @ts-check
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_OPTIONS,
  discoverSkillFiles,
  loadSkillLintRc,
  UsageError,
} from "./discovery.js";
import { lintSkills } from "./rules.js";

/**
 * @typedef {import('./discovery.js').LintOptions} LintOptions
 * @typedef {import('./rules.js').LintReport} LintReport
 */

const HELP_TEXT = `skill-lint - Validate Agent Skills (SKILL.md), audit startup token budgets, and check bundled safety

Usage:
  skill-lint [paths...] [options]
  skill-lint check [paths...] [options]
  skill-lint init <dir> [--force]

Options:
  --budget <tokens>          Fail (exit 1) if total startup index tokens exceed <tokens>
  --max-body-lines <n>       Warn when SKILL.md body exceeds <n> lines (default: 500)
  --max-body-tokens <n>      Warn when SKILL.md body exceeds <n> tokens (default: 4000)
  --max-desc-chars <n>       Warn when description exceeds <n> chars (default: 300)
  --ignore-rule <rule>       Suppress a lint rule ID (repeatable)
  --allow-field <key>        Allow an extra frontmatter field (repeatable)
  --strict                   Treat warnings as errors (exit 1)
  --verbose                  Include info-level findings in text output
  --json                     Print the full report as JSON
  --force                    Overwrite an existing SKILL.md during "init"
  -h, --help                 Show this help message
  -v, --version              Show version
`;

const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * @returns {string}
 */
function readVersion() {
  const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{
   *   command: 'check' | 'init',
   *   help: boolean,
   *   version: boolean,
   *   targets: string[],
   *   budget?: number,
   *   maxBodyLines?: number,
   *   maxBodyTokens?: number,
   *   maxDescriptionChars?: number,
   *   ignoreRules: string[],
   *   allowedFrontmatterKeys: string[],
   *   strict?: boolean,
   *   verbose: boolean,
   *   json: boolean,
   *   force: boolean,
   * }} */
  const parsed = {
    command: "check",
    help: false,
    version: false,
    targets: [],
    ignoreRules: [],
    allowedFrontmatterKeys: [],
    verbose: false,
    json: false,
    force: false,
  };

  /** @param {string} flag @param {string | undefined} val */
  const requireStr = (flag, val) => {
    if (val === undefined) throw new UsageError(`Option ${flag} requires a value`);
    return val;
  };

  /** @param {string} flag @param {string | undefined} val */
  const requireInt = (flag, val) => {
    const s = requireStr(flag, val);
    if (!/^\d+$/.test(s)) throw new UsageError(`Option ${flag} expects a non-negative integer, got "${s}"`);
    return Number.parseInt(s, 10);
  };

  let positionalIdx = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
    } else if (arg === "-v" || arg === "--version") {
      parsed.version = true;
    } else if (arg === "--budget") {
      parsed.budget = requireInt(arg, argv[++i]);
    } else if (arg.startsWith("--budget=")) {
      parsed.budget = requireInt("--budget", arg.slice("--budget=".length));
    } else if (arg === "--max-body-lines") {
      parsed.maxBodyLines = requireInt(arg, argv[++i]);
    } else if (arg.startsWith("--max-body-lines=")) {
      parsed.maxBodyLines = requireInt("--max-body-lines", arg.slice("--max-body-lines=".length));
    } else if (arg === "--max-body-tokens") {
      parsed.maxBodyTokens = requireInt(arg, argv[++i]);
    } else if (arg.startsWith("--max-body-tokens=")) {
      parsed.maxBodyTokens = requireInt("--max-body-tokens", arg.slice("--max-body-tokens=".length));
    } else if (arg === "--max-desc-chars") {
      parsed.maxDescriptionChars = requireInt(arg, argv[++i]);
    } else if (arg.startsWith("--max-desc-chars=")) {
      parsed.maxDescriptionChars = requireInt("--max-desc-chars", arg.slice("--max-desc-chars=".length));
    } else if (arg === "--ignore-rule") {
      parsed.ignoreRules.push(requireStr(arg, argv[++i]));
    } else if (arg.startsWith("--ignore-rule=")) {
      parsed.ignoreRules.push(arg.slice("--ignore-rule=".length));
    } else if (arg === "--allow-field") {
      parsed.allowedFrontmatterKeys.push(requireStr(arg, argv[++i]));
    } else if (arg.startsWith("--allow-field=")) {
      parsed.allowedFrontmatterKeys.push(arg.slice("--allow-field=".length));
    } else if (arg === "--strict") {
      parsed.strict = true;
    } else if (arg === "--verbose") {
      parsed.verbose = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--force") {
      parsed.force = true;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else {
      if (positionalIdx === 0 && (arg === "check" || arg === "init")) {
        parsed.command = arg;
      } else {
        parsed.targets.push(arg);
      }
      positionalIdx++;
    }
  }

  return parsed;
}

/**
 * Format a LintReport as human-readable terminal text.
 * @param {LintReport} report
 * @param {{ showInfo?: boolean }} [opts]
 * @returns {string}
 */
export function formatHumanReport(report, opts = {}) {
  const lines = [];
  lines.push(`skill-lint: scanned ${report.skillCount} skill(s) (offline estimate: chars / 4)`);
  lines.push("");

  if (report.skillCount === 0) {
    lines.push("No SKILL.md files found.");
    return lines.join("\n") + "\n";
  }

  lines.push("Skills:");
  lines.push("  startup  body_tok  lines  refs  scripts  skill");
  for (const s of report.skills) {
    lines.push(
      `  ${formatNum(s.startupTokens).padStart(7)}  ${formatNum(s.bodyTokens).padStart(8)}  ${String(s.bodyLines).padStart(5)}  ${String(s.refCount).padStart(4)}  ${String(s.scriptCount).padStart(7)}  ${s.name} (${s.file})`,
    );
  }
  lines.push("");

  const visible = opts.showInfo
    ? report.findings
    : report.findings.filter((f) => f.severity !== "info");

  if (visible.length > 0) {
    lines.push(`Findings (${visible.length}):`);
    for (const f of visible) {
      const tag = `[${f.severity.toUpperCase()}]`.padEnd(7);
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`  ${tag} ${f.rule} (${loc}): ${f.message}`);
    }
    lines.push("");
  }

  const hiddenInfo = opts.showInfo ? 0 : report.counts.info;
  const infoNote = hiddenInfo > 0 ? ` (${hiddenInfo} info hidden; pass --verbose to show)` : "";

  lines.push(
    `Totals: ${formatNum(report.startupTokens)} startup index tokens, ${formatNum(report.totalBodyTokens)} body tokens (${formatNum(report.totalTokens)} total)`,
  );
  if (report.budget !== null) {
    if (report.budgetExceededBy > 0) {
      lines.push(
        `Startup budget: EXCEEDED ${formatNum(report.budget)} token budget by ${formatNum(report.budgetExceededBy)} tokens`,
      );
    } else {
      lines.push(
        `Startup budget: OK (${formatNum(report.startupTokens)} / ${formatNum(report.budget)} tokens)`,
      );
    }
  }
  lines.push(
    `Summary: ${report.counts.error} errors, ${report.counts.warn} warnings, ${report.counts.info} info${infoNote}`,
  );
  lines.push(report.ok ? "Status: OK" : "Status: Problems found.");
  return lines.join("\n") + "\n";
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatNum(n) {
  return n.toLocaleString("en-US");
}

/**
 * Create a starter SKILL.md inside targetDir.
 * @param {string} targetDir
 * @param {string} cwd
 * @param {boolean} force
 * @param {(s: string) => void} out
 * @returns {number}
 */
function runInit(targetDir, cwd, force, out) {
  const dirPath = path.resolve(cwd, targetDir);
  const skillName = path.basename(dirPath);
  if (!SKILL_NAME_RE.test(skillName) || skillName.length > 64) {
    throw new UsageError(
      `Directory name "${skillName}" is not a valid skill name (use 1-64 lowercase letters, digits, and single hyphens)`,
    );
  }
  const skillFile = path.join(dirPath, "SKILL.md");
  if (existsSync(skillFile) && !force) {
    throw new UsageError(`${path.relative(cwd, skillFile)} already exists (pass --force to overwrite)`);
  }

  mkdirSync(dirPath, { recursive: true });
  const title = skillName
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  const template = `---
name: ${skillName}
description: Describe what ${skillName} does and when the agent should use it.
---

# ${title}

## When to use

- Explain the specific tasks or file patterns that trigger this skill.

## Steps

1. Inspect the relevant files before editing.
2. Apply changes and verify with project checks.
`;

  writeFileSync(skillFile, template, "utf8");
  out(`Created ${path.relative(cwd, skillFile).replace(/\\/g, "/")}\n`);
  return 0;
}

/**
 * Run the CLI.
 * @param {string[]} argv
 * @param {{
 *   cwd: string,
 *   out: (s: string) => void,
 *   err: (s: string) => void,
 * }} io
 * @returns {number}
 */
export function run(argv, io) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      io.out(HELP_TEXT);
      return 0;
    }
    if (args.version) {
      io.out(`skill-lint ${readVersion()}\n`);
      return 0;
    }

    if (args.command === "init") {
      if (args.targets.length !== 1) {
        throw new UsageError('Usage: skill-lint init <dir> [--force]');
      }
      return runInit(args.targets[0], io.cwd, args.force, io.out);
    }

    const rc = loadSkillLintRc(io.cwd);
    /** @type {LintOptions} */
    const options = {
      ...DEFAULT_OPTIONS,
      ...rc,
      ...(args.budget !== undefined ? { budget: args.budget } : {}),
      ...(args.maxBodyLines !== undefined ? { maxBodyLines: args.maxBodyLines } : {}),
      ...(args.maxBodyTokens !== undefined ? { maxBodyTokens: args.maxBodyTokens } : {}),
      ...(args.maxDescriptionChars !== undefined
        ? { maxDescriptionChars: args.maxDescriptionChars }
        : {}),
      ...(args.strict !== undefined ? { strict: args.strict } : {}),
      ignoreRules: [...(rc.ignoreRules ?? []), ...args.ignoreRules],
      allowedFrontmatterKeys: [
        ...(rc.allowedFrontmatterKeys ?? []),
        ...args.allowedFrontmatterKeys,
      ],
    };

    const files = discoverSkillFiles(args.targets, io.cwd);
    const report = lintSkills({ files, cwd: io.cwd, options });

    if (args.json) {
      io.out(JSON.stringify(report, null, 2) + "\n");
    } else {
      io.out(formatHumanReport(report, { showInfo: args.verbose }));
    }

    return report.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`skill-lint: ${err.message}\n`);
      return 2;
    }
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`skill-lint: ${msg}\n`);
    return 2;
  }
}
