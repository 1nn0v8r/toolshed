// @ts-check
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { compareDependencies } from "./compare.js";
import { loadConfig, loadPackageJson } from "./config.js";
import { categorizeFile, listFiles, restrictToPaths } from "./files.js";
import { formatJson, formatText } from "./report.js";
import { scanImports } from "./scan.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const HELP = `dep-check: check for unused, missing, and misplaced dependencies

Usage: dep-check [dir] [options]

Options:
  --path <dir>            Project directory to scan (default: current directory)
  --package-json <file>   Custom path to package.json (default: <dir>/package.json)
  --ignore <pkg>          Package or wildcard pattern to ignore (repeatable)
  --ignore-dev            Ignore all devDependencies from unused checks
  --fail-on-unused        Exit with code 1 if unused dependencies are found
  --fail-on-missing       Exit with code 1 if missing dependencies are found (default: true)
  --fail-on-misplaced     Exit with code 1 if misplaced dependencies are found
  --strict                Enable --fail-on-unused, --fail-on-missing, and --fail-on-misplaced
  --json                  Print the report as JSON
  -h, --help              Show this help
  -v, --version           Show the version

Config: a .depcheckrc.json or "dep-check" field in package.json may set options.
Exit codes: 0 clean or within tolerance, 1 policy violations found, 2 usage error.
`;

/** @returns {string} */
function getVersion() {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return String(pkg.version);
}

/**
 * Custom error class for invalid CLI usage or missing config.
 */
export class UsageError extends Error {
  /** @param {string} msg */
  constructor(msg) {
    super(msg);
    this.name = "UsageError";
  }
}

/**
 * Runs dep-check logic.
 *
 * @param {string[]} argv
 * @param {{ stdout?: (s: string) => void, stderr?: (s: string) => void, cwd?: string }} [io]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, io = {}) {
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s));

  try {
    return await runInner(argv, io.cwd ?? process.cwd(), stdout);
  } catch (err) {
    if (err instanceof UsageError) {
      stderr(`${err.message}\n`);
      return 2;
    }
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`dep-check error: ${msg}\n`);
    return 2;
  }
}

/**
 * Inner execution function.
 *
 * @param {string[]} argv
 * @param {string} cwd
 * @param {(s: string) => void} stdout
 * @returns {Promise<number>}
 */
async function runInner(argv, cwd, stdout) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        path: { type: "string" },
        "package-json": { type: "string" },
        ignore: { type: "string", multiple: true },
        "ignore-dev": { type: "boolean", default: false },
        "fail-on-unused": { type: "boolean", default: false },
        "fail-on-missing": { type: "boolean" },
        "fail-on-misplaced": { type: "boolean", default: false },
        strict: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false }
      },
      allowPositionals: true
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UsageError(`Invalid options: ${msg}`);
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

  const targetDir = path.resolve(cwd, values.path || positionals[0] || ".");
  const pkgJsonPath = values["package-json"]
    ? path.resolve(cwd, values["package-json"])
    : path.join(targetDir, "package.json");

  const pkgData = loadPackageJson(pkgJsonPath);
  const fileConfig = loadConfig(targetDir, pkgData);

  // Merge CLI flags with config file defaults
  const cliIgnores = (values.ignore || []).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  const fileIgnores = (fileConfig.ignore || []).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  const mergedIgnores = [...fileIgnores, ...cliIgnores];
  const ignoreDev = values["ignore-dev"] || fileConfig.ignoreDev || false;

  const isStrict = Boolean(values.strict);
  const failOnUnused = isStrict || values["fail-on-unused"] || fileConfig.failOnUnused || false;
  const failOnMissing = isStrict || (values["fail-on-missing"] !== undefined
    ? values["fail-on-missing"]
    : fileConfig.failOnMissing);
  const failOnMisplaced = isStrict || values["fail-on-misplaced"] || fileConfig.failOnMisplaced || false;

  const pathsFilter = fileConfig.paths || [];

  // 1. List files
  const { files } = await listFiles(targetDir);
  const filteredFiles = restrictToPaths(files, pathsFilter);

  // 2. Scan files
  /** @type {import("./compare.js").ScannedFile[]} */
  const scannedFiles = [];
  for (const relFile of filteredFiles) {
    const absPath = path.join(targetDir, relFile);
    try {
      const stat = fs.statSync(absPath);
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = fs.readFileSync(absPath, "utf8");
      const imports = scanImports(content);
      const category = categorizeFile(relFile);
      scannedFiles.push({
        file: relFile,
        category,
        imports
      });
    } catch {
      // Skip unreadable files
      continue;
    }
  }

  // 3. Compare dependencies
  const result = compareDependencies(pkgData, scannedFiles, {
    ignore: mergedIgnores,
    ignoreDev
  });

  // 4. Output report
  if (values.json) {
    stdout(`${formatJson(result)}\n`);
  } else {
    stdout(`${formatText(result)}\n`);
  }

  // 5. Determine exit code
  const hasUnusedViolation = failOnUnused && (result.unusedDependencies.length > 0 || result.unusedDevDependencies.length > 0);
  const hasMissingViolation = failOnMissing && result.missingDependencies.length > 0;
  const hasMisplacedViolation = failOnMisplaced && result.misplacedDependencies.length > 0;

  if (hasUnusedViolation || hasMissingViolation || hasMisplacedViolation) {
    return 1;
  }

  return 0;
}
