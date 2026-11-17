#!/usr/bin/env node
// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, UsageError } from "./args.js";
import { pack } from "./pack.js";

export const HELP = `repo-pack: bundle chosen files of a project into one prompt-ready file.

Usage:
  repo-pack [paths or globs...] [options]

With no arguments the current directory is packed. A single folder argument
becomes the root. Token counts are estimates (ceil(characters / 4)).

Options:
  --include <glob>        Keep only matching files (repeatable)
  --exclude <glob>        Drop matching files (repeatable)
  --max-tokens <n>        Stop adding files once the estimated budget is used
  --order <priority|path> priority (default): docs, config, source, tests.
                          path: plain path order
  --format <md|xml>       Output format (default: md)
  --out <file>            Write to a file instead of stdout
  --line-numbers          Prefix each line with its number
  --max-file-size <size>  Skip larger files (default 256k; accepts 4096, 64k, 1m)
  --allow-env             Also pack .env* files (skipped by default)
  --no-default-excludes   Do not skip lockfiles, *.map, *.log and, outside
                          git, node_modules, dist, build, coverage
  -h, --help              Show this help
  -v, --version           Show the version

Exit codes: 0 ok, 1 nothing matched or budget too small, 2 usage error.
`;

/** @returns {string} */
function readVersion() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return JSON.parse(fs.readFileSync(file, "utf8")).version;
}

/**
 * @param {string[]} paths
 * @returns {string}
 */
function listShort(paths) {
  const MAX = 50;
  const shown = paths.slice(0, MAX).map((p) => `  ${p}`);
  if (paths.length > MAX) shown.push(`  ... and ${paths.length - MAX} more`);
  return shown.join("\n");
}

/**
 * Run the CLI. Returns the exit code; never calls process.exit.
 * @param {string[]} argv arguments after the script name
 * @param {{cwd: string, stdout: (s: string) => void, stderr: (s: string) => void}} io
 * @returns {Promise<number>}
 */
export async function run(argv, io) {
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      io.stdout(HELP);
      return 0;
    }
    if (opts.version) {
      io.stdout(`${readVersion()}\n`);
      return 0;
    }

    const res = await pack(opts, io.cwd);

    if (res.envSkipped.length > 0) {
      io.stderr(
        `repo-pack: warning: skipped ${res.envSkipped.length} .env file(s) so secrets are not packed (use --allow-env to include them):\n${listShort(res.envSkipped)}\n`,
      );
    }
    if (res.skipped.length > 0) {
      const lines = res.skipped.map((s) => `${s.path} (${s.reason})`);
      io.stderr(`repo-pack: skipped ${res.skipped.length} file(s):\n${listShort(lines)}\n`);
    }
    if (res.omitted.length > 0) {
      const lines = res.omitted.map((o) => `${o.path} (about ${o.tokens} tokens)`);
      io.stderr(
        `repo-pack: left out ${res.omitted.length} file(s) over the --max-tokens budget of ${opts.maxTokens}:\n${listShort(lines)}\n`,
      );
    }

    if (res.status === "no-match") {
      io.stderr("repo-pack: no files matched\n");
      return 1;
    }
    if (res.status === "no-packable") {
      io.stderr("repo-pack: every matching file was skipped, nothing to pack\n");
      return 1;
    }
    if (res.status === "budget-too-small") {
      io.stderr(
        `repo-pack: the --max-tokens budget of ${opts.maxTokens} is too small for any file\n`,
      );
      return 1;
    }

    if (opts.out) {
      const target = path.resolve(io.cwd, opts.out);
      try {
        fs.writeFileSync(target, res.output, "utf8");
      } catch (e) {
        io.stderr(`repo-pack: cannot write ${opts.out}: ${/** @type {Error} */ (e).message}\n`);
        return 1;
      }
    } else {
      io.stdout(res.output);
    }
    io.stderr(
      `repo-pack: packed ${res.files.length} file(s), about ${res.totalTokens} estimated tokens (characters / 4, an estimate)${opts.out ? `, wrote ${opts.out}` : ""}\n`,
    );
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`repo-pack: ${e.message}\nRun repo-pack --help for usage.\n`);
      return 2;
    }
    io.stderr(`repo-pack: unexpected error: ${/** @type {Error} */ (e).message}\n`);
    return 1;
  }
}

/** True when this file is the process entry point (also through an npm bin symlink). */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  run(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
  }).then((code) => {
    process.exitCode = code;
  });
}
