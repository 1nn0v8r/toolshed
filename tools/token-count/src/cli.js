#!/usr/bin/env node
// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HELP, UsageError, parseArgs } from "./args.js";
import { discover, isBinaryFile, toPosix } from "./discover.js";
import { ApiError, countExact, mapLimit } from "./exact.js";
import { countChars, estimateTokens } from "./estimate.js";
import { aggregateByDir, fmt, renderTable, sortRows } from "./report.js";

const CONCURRENCY = 4;
const DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * @typedef {Object} IO
 * @property {(s: string) => void} out
 * @property {(s: string) => void} err
 * @property {() => Promise<string>} readStdin
 * @property {Record<string, string | undefined>} env
 * @property {string} cwd
 */

/** @returns {string} */
export function readVersion() {
  const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return JSON.parse(fs.readFileSync(pkg, "utf8")).version;
}

/** @returns {Promise<string>} */
async function readProcessStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Run the CLI. Returns the exit code.
 * @param {string[]} argv
 * @param {Partial<IO>} [io]
 * @returns {Promise<number>}
 */
export async function run(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const readStdin = io.readStdin ?? readProcessStdin;

  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      out(HELP);
      return 0;
    }
    if (opts.version) {
      out(`${readVersion()}\n`);
      return 0;
    }

    const apiKey = env.ANTHROPIC_API_KEY;
    if (opts.exact && !apiKey) {
      err("token-count: --exact needs the ANTHROPIC_API_KEY environment variable to be set\n");
      return 1;
    }

    /** @type {{path: string, text: string}[]} */
    const inputs = [];
    let skippedBinary = 0;
    let unreadable = 0;
    let root = cwd;

    if (opts.paths.length > 0 || !opts.stdin) {
      const found = await discover(opts.paths, cwd);
      if (found.missing.length) {
        throw new UsageError(`path not found: ${found.missing.join(", ")}`);
      }
      root = found.root;
      for (const abs of found.files) {
        try {
          if (isBinaryFile(abs)) {
            skippedBinary++;
            continue;
          }
          inputs.push({ path: toPosix(path.relative(root, abs)), text: fs.readFileSync(abs, "utf8") });
        } catch {
          unreadable++;
        }
      }
    }
    if (opts.stdin) inputs.push({ path: "<stdin>", text: await readStdin() });

    /** @type {number[]} */
    let counts;
    if (opts.exact) {
      const baseDelay = Number(env.TOKEN_COUNT_RETRY_BASE_MS);
      const cfg = {
        apiKey: /** @type {string} */ (apiKey),
        model: opts.model,
        baseUrl: env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL,
        ...(Number.isFinite(baseDelay) && env.TOKEN_COUNT_RETRY_BASE_MS ? { baseDelayMs: baseDelay } : {}),
      };
      try {
        counts = await mapLimit(inputs, CONCURRENCY, (i) => countExact(i.text, cfg));
      } catch (e) {
        if (e instanceof ApiError) {
          err(`token-count: ${e.message}\n`);
          return 1;
        }
        throw e;
      }
    } else {
      counts = inputs.map((i) => estimateTokens(i.text));
    }

    const rows = sortRows(inputs.map((i, n) => ({ path: i.path, tokens: counts[n], chars: countChars(i.text) })));
    const total = rows.reduce((s, r) => s + r.tokens, 0);
    const over = opts.budget !== null && total > opts.budget ? total - opts.budget : 0;
    const mode = opts.exact ? "exact" : "estimate";

    const display = opts.byDir ? sortRows(aggregateByDir(rows)) : rows;
    const shown = opts.top !== null ? display.slice(0, opts.top) : display;

    if (opts.json) {
      /** @type {Record<string, unknown>} */
      const result = {
        mode,
        ...(opts.exact ? { model: opts.model } : {}),
        total,
        fileCount: rows.length,
        skippedBinary,
        unreadable,
        view: opts.byDir ? "dir" : "file",
        rows: shown.map((r) => ({ ...r, share: total === 0 ? 0 : r.tokens / total })),
        truncated: shown.length < display.length,
        budget: opts.budget === null ? null : { limit: opts.budget, over, ok: over === 0 },
      };
      out(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const label = opts.exact
        ? `Exact token counts (Anthropic API, model ${opts.model})`
        : "Estimated token counts (offline estimate: characters / 4, not exact)";
      const lines = [label, "", ...renderTable(shown, total)];
      if (shown.length < display.length) {
        lines.push(`... ${display.length - shown.length} more not shown (--top ${opts.top})`);
      }
      lines.push("");
      const noun = rows.length === 1 ? "file" : "files";
      lines.push(`Total: ${fmt(total)} tokens${opts.exact ? "" : " (estimate)"} across ${rows.length} ${noun}`);
      if (skippedBinary) lines.push(`Skipped ${skippedBinary} binary ${skippedBinary === 1 ? "file" : "files"}`);
      if (unreadable) lines.push(`Skipped ${unreadable} unreadable ${unreadable === 1 ? "file" : "files"}`);
      if (opts.budget !== null && over === 0) {
        lines.push(`Within budget of ${fmt(opts.budget)} tokens (${fmt(opts.budget - total)} to spare)`);
      }
      out(`${lines.join("\n")}\n`);
    }

    if (over > 0) {
      err(`token-count: over budget by ${fmt(over)} tokens (total ${fmt(total)}, budget ${fmt(/** @type {number} */ (opts.budget))})\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`token-count: ${e.message}\nRun token-count --help for usage.\n`);
      return 2;
    }
    err(`token-count: unexpected error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  process.exitCode = await run(process.argv.slice(2));
}
