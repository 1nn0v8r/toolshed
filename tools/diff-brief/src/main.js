// @ts-check
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { analyzeDiff, riskRank } from "./analyze.js";
import { loadConfig } from "./config.js";
import { fetchGitDiff, getRepoRoot } from "./git.js";
import { parseUnifiedDiff } from "./parser.js";
import { formatJson, formatMarkdown, formatText } from "./report.js";

export const HELP = `diff-brief: summarize sprawling git diffs into token-compact review briefs

Usage: diff-brief [range] [options]

Options:
  --path <dir>            Repository directory (default: current directory)
  --staged                Inspect staged changes (--cached)
  --unstaged              Inspect unstaged working tree changes
  --all                   Inspect all staged + unstaged changes vs HEAD
  --base <ref>            Compare <ref>...HEAD (merge-base diff)
  --commit <sha>          Inspect a single commit
  --diff-file <file>      Read unified diff from file ("-" for stdin)
  --stdin                 Read unified diff from standard input
  --format <type>         Output format: text, md, json (default: text)
  --max-tokens <n>        Token budget for key hunks (default: 1800, 0 = summary only)
  --no-hunks              Omit diff hunks (same as --max-tokens 0)
  --include-noise         Include lockfile and generated file hunks
  --ignore <glob>         Ignore matching file path (repeatable)
  --fail-on <level>       Exit 1 if risk is >= low, medium, or high
  --fail-on-flag <id>     Exit 1 if specific risk flag id triggers (repeatable)
  -h, --help              Show this help
  -v, --version           Show the version

Config: .diffbriefrc.json or "diff-brief" key in package.json.
Exit codes: 0 clean or below fail threshold, 1 fail threshold exceeded, 2 usage error.
`;

/** @returns {string} */
function getVersion() {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return String(pkg.version);
}

/**
 * Custom error class for invalid CLI arguments or missing inputs.
 */
export class UsageError extends Error {
  /** @param {string} msg */
  constructor(msg) {
    super(msg);
    this.name = "UsageError";
  }
}

/**
 * Run diff-brief CLI logic.
 *
 * @param {string[]} argv
 * @param {{
 *   stdout?: (s: string) => void,
 *   stderr?: (s: string) => void,
 *   stdinText?: string,
 *   cwd?: string
 * }} [io]
 * @returns {Promise<number>}
 */
export async function run(argv, io = {}) {
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s));

  try {
    return await runInner(argv, io.cwd ?? process.cwd(), io.stdinText, stdout);
  } catch (err) {
    if (err instanceof UsageError) {
      stderr(`${err.message}\n`);
      return 2;
    }
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`diff-brief error: ${msg}\n`);
    return 2;
  }
}

/**
 * Read stdin completely as UTF-8.
 *
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/**
 * @param {string[]} argv
 * @param {string} cwd
 * @param {string|undefined} stdinText
 * @param {(s: string) => void} stdout
 * @returns {Promise<number>}
 */
async function runInner(argv, cwd, stdinText, stdout) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        path: { type: "string" },
        staged: { type: "boolean", default: false },
        unstaged: { type: "boolean", default: false },
        all: { type: "boolean", default: false },
        base: { type: "string" },
        commit: { type: "string" },
        "diff-file": { type: "string" },
        stdin: { type: "boolean", default: false },
        format: { type: "string", default: "text" },
        "max-tokens": { type: "string" },
        "no-hunks": { type: "boolean", default: false },
        "include-noise": { type: "boolean", default: false },
        ignore: { type: "string", multiple: true, default: [] },
        "fail-on": { type: "string" },
        "fail-on-flag": { type: "string", multiple: true, default: [] },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false }
      }
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  const { values, positionals } = parsed;
  if (values.help) {
    stdout(HELP);
    return 0;
  }
  if (values.version) {
    stdout(`${getVersion()}\n`);
    return 0;
  }

  const format = values.format ?? "text";
  if (!["text", "md", "json"].includes(format)) {
    throw new UsageError(`Unsupported --format "${format}". Expected text, md, or json.`);
  }

  if (values["fail-on"] && !["low", "medium", "high"].includes(values["fail-on"])) {
    throw new UsageError(`Unsupported --fail-on "${values["fail-on"]}". Expected low, medium, or high.`);
  }

  const targetDir = path.resolve(cwd, values.path ?? ".");
  const repoRoot = getRepoRoot(targetDir);
  const configDir = repoRoot ?? targetDir;
  const config = loadConfig(configDir);

  let maxTokens = config.maxTokens;
  if (values["no-hunks"]) {
    maxTokens = 0;
  } else if (values["max-tokens"] !== undefined) {
    maxTokens = Number(values["max-tokens"]);
    if (!Number.isFinite(maxTokens) || maxTokens < 0) {
      throw new UsageError(`Invalid --max-tokens "${values["max-tokens"]}". Expected a non-negative integer.`);
    }
  }

  const mergedIgnore = [...config.ignore, ...(values.ignore ?? [])];
  const mergedFailFlags = new Set([...config.failOnFlags, ...(values["fail-on-flag"] ?? [])]);
  const failOn = /** @type {"low"|"medium"|"high"|null} */ (values["fail-on"] ?? config.failOn);

  /** @type {string} */
  let scope = "";
  /** @type {string} */
  let diffText = "";
  /** @type {string[]} */
  let commits = [];

  if (values.stdin || values["diff-file"] === "-") {
    scope = "stdin diff";
    diffText = stdinText !== undefined ? stdinText : await readStdin();
  } else if (values["diff-file"]) {
    const filePath = path.resolve(cwd, values["diff-file"]);
    if (!fs.existsSync(filePath)) {
      throw new UsageError(`Diff file not found: ${filePath}`);
    }
    scope = path.basename(filePath);
    diffText = fs.readFileSync(filePath, "utf8");
  } else {
    if (!repoRoot) {
      throw new UsageError(`Not inside a git repository: ${targetDir}. Pass --diff-file or --stdin.`);
    }

    const modeFlags = [
      values.staged ? "staged" : null,
      values.unstaged ? "unstaged" : null,
      values.all ? "all" : null,
      values.base ? "base" : null,
      values.commit ? "commit" : null
    ].filter(Boolean);

    if (modeFlags.length > 1) {
      throw new UsageError(`Conflicting mode options: ${modeFlags.join(", ")}. Choose only one.`);
    }
    if (positionals.length > 1) {
      throw new UsageError(`Unexpected extra arguments: ${positionals.slice(1).join(" ")}`);
    }
    if (positionals.length === 1 && modeFlags.length > 0) {
      throw new UsageError(`Cannot combine positional range "${positionals[0]}" with --${modeFlags[0]}.`);
    }

    /** @type {"auto"|"staged"|"unstaged"|"all"|"range"|"base"|"commit"} */
    let mode = "auto";
    /** @type {string|undefined} */
    let target;

    if (values.staged) mode = "staged";
    else if (values.unstaged) mode = "unstaged";
    else if (values.all) mode = "all";
    else if (values.base) {
      mode = "base";
      target = values.base;
    } else if (values.commit) {
      mode = "commit";
      target = values.commit;
    } else if (positionals.length === 1) {
      mode = "range";
      target = positionals[0];
    }

    const fetched = fetchGitDiff(repoRoot, { mode, target });
    scope = fetched.scope;
    diffText = fetched.diffText;
    commits = fetched.commits;
  }

  const parsedFiles = parseUnifiedDiff(diffText);
  const report = analyzeDiff(parsedFiles, {
    scope,
    commits,
    rawDiffText: diffText,
    config: {
      ...config,
      ignore: mergedIgnore,
      maxTokens
    }
  });

  const includeNoise = Boolean(values["include-noise"]);
  if (format === "json") {
    stdout(formatJson(report));
  } else if (format === "md") {
    stdout(formatMarkdown(report, { maxTokens, includeNoise }));
  } else {
    stdout(formatText(report, { maxTokens, includeNoise }));
  }

  if (failOn && riskRank(report.riskLevel) >= riskRank(failOn)) {
    return 1;
  }
  if (mergedFailFlags.size > 0 && report.flags.some((f) => mergedFailFlags.has(f.id))) {
    return 1;
  }
  return 0;
}
