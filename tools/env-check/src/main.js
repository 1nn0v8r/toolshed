// @ts-check
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { compare, makeIgnore } from "./check.js";
import { loadConfig, UsageError } from "./config.js";
import { parseEnvKeys } from "./envfile.js";
import { listFiles, restrictToPaths } from "./files.js";
import { fixExampleFile } from "./fix.js";
import { formatJson, formatText } from "./report.js";
import { languageOf, scanContent } from "./scan.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const HELP = `env-check: compare the environment variables your code reads with .env.example

Usage: env-check [dir] [options]

Options:
  --example <file>   Example file to compare against (default: .env.example, relative to dir)
  --env <file>       Real env file to check example keys against (default: .env if it exists)
  --ignore <name>    Variable name or glob to ignore (repeatable, * and ? supported)
  --fix              Append missing keys to the example file with empty values
  --json             Print the report as JSON
  --strict           Treat unused example keys as errors too
  -h, --help         Show this help
  -v, --version      Show the version

Config: a .env-check.json in dir may set "example", "ignore" and "paths".
Exit codes: 0 clean, 1 problems found, 2 usage error.
Values from .env files are never read into the report or printed.
`;

/** @returns {string} */
function version() {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return String(pkg.version);
}

/** @param {string} p */
function exists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Run env-check.
 * @param {string[]} argv arguments after the program name
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
      stderr(`env-check: ${err.message}\nRun "env-check --help" for usage.\n`);
      return 2;
    }
    stderr(`env-check: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

/**
 * @param {string[]} argv
 * @param {string} cwd
 * @param {(s: string) => void} stdout
 * @returns {Promise<number>}
 */
async function runInner(argv, cwd, stdout) {
  /** @type {ReturnType<typeof parseArgs>} */
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        example: { type: "string" },
        env: { type: "string" },
        ignore: { type: "string", multiple: true },
        fix: { type: "boolean" },
        json: { type: "boolean" },
        strict: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : "invalid arguments");
  }
  const v = /** @type {Record<string, any>} */ (parsed.values);
  if (v.help) {
    stdout(HELP);
    return 0;
  }
  if (v.version) {
    stdout(version() + "\n");
    return 0;
  }
  if (parsed.positionals.length > 1) throw new UsageError("expected at most one directory argument");

  const dir = path.resolve(cwd, parsed.positionals[0] ?? ".");
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    // handled below
  }
  if (!isDir) throw new UsageError(`not a directory: ${parsed.positionals[0] ?? "."}`);

  const config = loadConfig(dir);
  const exampleRel = String(v.example ?? config.example ?? ".env.example");
  const examplePath = path.resolve(dir, exampleRel);
  const exampleFound = exists(examplePath);
  if (!exampleFound && v.example !== undefined && !v.fix) throw new UsageError(`example file not found: ${exampleRel}`);

  /** @type {string | null} */
  let envRel = null;
  if (v.env !== undefined) {
    envRel = String(v.env);
    if (!exists(path.resolve(dir, envRel))) throw new UsageError(`env file not found: ${envRel}`);
  } else if (exists(path.join(dir, ".env"))) {
    envRel = ".env";
  }

  const ignored = makeIgnore([...(config.ignore ?? []), ...(/** @type {string[]} */ (v.ignore) ?? [])]);

  // Scan source files.
  const listing = await listFiles(dir);
  let files = listing.files;
  if (config.paths && config.paths.length > 0) files = restrictToPaths(files, config.paths);
  files = files.filter((f) => languageOf(f) !== null);

  /** @type {Map<string, import("./check.js").Location[]>} */
  const used = new Map();
  /** @type {import("./check.js").Location[]} */
  const dynamic = [];
  let scanned = 0;
  let skippedLarge = 0;
  for (const rel of files) {
    const abs = path.join(dir, rel);
    let content;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) {
        skippedLarge++;
        continue;
      }
      content = fs.readFileSync(abs, "utf8");
    } catch {
      continue; // deleted but still tracked, or unreadable
    }
    scanned++;
    const res = scanContent(rel, content);
    for (const u of res.uses) {
      const list = used.get(u.name) ?? [];
      list.push({ file: rel, line: u.line });
      used.set(u.name, list);
    }
    for (const d of res.dynamic) dynamic.push({ file: rel, line: d.line });
  }

  const exampleKeys = new Set(exampleFound ? parseEnvKeys(fs.readFileSync(examplePath, "utf8")).map((k) => k.key) : []);
  const envKeys = envRel ? new Set(parseEnvKeys(fs.readFileSync(path.resolve(dir, envRel), "utf8")).map((k) => k.key)) : null;

  const cmp = compare(used, exampleKeys, envKeys, ignored);
  let missing = cmp.missing;
  /** @type {string[]} */
  let fixed = [];
  if (v.fix && missing.length > 0) {
    fixed = missing.map((m) => m.name);
    fixExampleFile(examplePath, fixed);
    missing = [];
  }

  const strict = Boolean(v.strict);
  const ok = missing.length === 0 && cmp.missingInEnv.length === 0 && !(strict && cmp.unused.length > 0);
  const result = {
    dir: ".",
    example: { file: exampleRel.replace(/\\/g, "/"), found: exampleFound || fixed.length > 0 },
    envFile: envRel ? { file: envRel.replace(/\\/g, "/"), found: true } : null,
    scannedFiles: scanned,
    skippedLargeFiles: skippedLarge,
    mode: listing.mode,
    strict,
    missing,
    unused: cmp.unused,
    missingInEnv: cmp.missingInEnv,
    dynamic,
    fixed,
    ok,
  };
  stdout(v.json ? formatJson(result) : formatText(result));
  return ok ? 0 : 1;
}
