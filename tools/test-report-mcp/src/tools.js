// @ts-check
import fs from "node:fs";
import path from "node:path";
import { detectRunners } from "./detect.js";
import { formatReport } from "./format.js";
import { detectFormat, FORMATS, parseByFormat } from "./parsers.js";
import { DEFAULT_TIMEOUT, MAX_TIMEOUT, RUNNERS, roots, runTests } from "./runner.js";
import { clean, clipEnd, resolveDir, resolveFileInRoot } from "./util.js";

const MAX_REPORT_BYTES = 50 * 1024 * 1024;

/** @typedef {{root: string, last: {text: string, at: string, runner: string} | null}} Session */
/** @typedef {{content: {type: "text", text: string}[], isError?: boolean}} ToolResult */

const cwdProp = {
  type: "string",
  description: "Optional directory relative to the repo root (must stay inside it).",
};

export const TOOL_DEFINITIONS = [
  {
    name: "detect_test_runner",
    description: "Detect which test runner(s) the project uses (vitest, jest, node:test, mocha, pytest, go test) and the command that would run.",
    inputSchema: { type: "object", properties: { cwd: cwdProp }, additionalProperties: false },
  },
  {
    name: "run_tests",
    description: "Run the project's tests and return only a compact summary plus each failure (name, file:line, message, trimmed stack). Output is capped.",
    inputSchema: {
      type: "object",
      properties: {
        runner: { type: "string", enum: RUNNERS, description: "Runner to use. Defaults to the first detected." },
        filter: { type: "string", description: "Test name pattern." },
        files: { type: "array", items: { type: "string" }, description: "Test files to run (relative to cwd)." },
        timeoutMs: { type: "number", description: `Timeout in ms (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT}).` },
        cwd: cwdProp,
      },
      additionalProperties: false,
    },
  },
  {
    name: "parse_report",
    description: "Parse an existing test report file (junit, jest-json, tap, go-json, mocha-json) inside the repo into the same compact format.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Report file path, relative to cwd, inside the repo root." },
        format: { type: "string", enum: FORMATS, description: "Report format. Auto-detected when omitted." },
        cwd: cwdProp,
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_failures_from_last_run",
    description: "Return the cached result of the last run_tests call in this session without re-running.",
    inputSchema: { type: "object", properties: { cwd: cwdProp }, additionalProperties: false },
  },
];

/**
 * @param {string} text
 * @param {boolean} [isError]
 * @returns {ToolResult}
 */
const result = (text, isError = false) => ({ content: [{ type: "text", text: clean(text) }], ...(isError ? { isError: true } : {}) });

/**
 * @param {Session} session
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {Promise<ToolResult>}
 */
export async function handleTool(session, name, args) {
  try {
    const dir = resolveDir(session.root, args.cwd);
    switch (name) {
      case "detect_test_runner": return detect(session, dir);
      case "run_tests": return await run(session, dir, args);
      case "parse_report": return parse(session, dir, args);
      case "list_failures_from_last_run": return last(session);
      default: return result(`Unknown tool: ${name}`, true);
    }
  } catch (e) {
    return result(/** @type {Error} */ (e).message, true);
  }
}

/** @param {Session} session @param {string} dir */
function detect(session, dir) {
  const found = detectRunners(dir, session.root);
  const rel = path.relative(session.root, dir) || ".";
  if (!found.length) {
    return result(`No test runner detected in ${rel}. Looked for vitest, jest, mocha and node --test in package.json, pytest config or conftest.py, and go.mod.`);
  }
  const lines = [`Detected in ${rel}:`];
  found.forEach((f, i) => lines.push(`${i + 1}. ${f.runner} (${f.confidence}, ${f.source})${i === 0 ? " [default]" : ""}\n   command: ${f.command}`));
  return result(lines.join("\n"));
}

/** @param {Session} session @param {string} dir @param {Record<string, unknown>} args */
async function run(session, dir, args) {
  let runner = typeof args.runner === "string" ? args.runner : "";
  if (runner && !RUNNERS.includes(runner)) return result(`Unknown runner: ${runner}. Use one of ${RUNNERS.join(", ")}.`, true);
  if (!runner) {
    const found = detectRunners(dir, session.root);
    if (!found.length) return result("No test runner detected. Pass `runner` explicitly or check the cwd.", true);
    runner = found[0].runner;
  }
  const filter = typeof args.filter === "string" && args.filter ? args.filter : undefined;
  if (filter && filter.startsWith("-")) return result("filter must not start with '-'.", true);
  if (args.files !== undefined && !Array.isArray(args.files)) return result("files must be an array of strings.", true);
  /** @type {string[]} */
  const files = [];
  for (const f of /** @type {unknown[]} */ (args.files ?? [])) {
    if (typeof f !== "string" || !f) return result("files must be an array of non-empty strings.", true);
    files.push(resolveFileInRoot(session.root, dir, f));
  }
  let timeoutMs = DEFAULT_TIMEOUT;
  if (args.timeoutMs !== undefined) {
    const t = Number(args.timeoutMs);
    if (!Number.isFinite(t) || t <= 0) return result("timeoutMs must be a positive number.", true);
    timeoutMs = Math.min(Math.floor(t), MAX_TIMEOUT);
  }

  const out = await runTests({ root: session.root, dir, runner, filter, files, timeoutMs });
  /** @type {string} */
  let text;
  if (out.report) {
    text = formatReport(out.report, { runner: out.runner, command: out.command, notes: out.notes });
    if (out.crashTail) text += `\n\nLast output:\n${out.crashTail}`;
  } else {
    text = [`Runner: ${out.runner}`, `Command: ${out.command}`, ...out.notes.map((n) => `Note: ${n}`), "", out.crashTail ?? ""].join("\n").trimEnd();
  }
  text = clean(text);
  session.last = { text, at: new Date().toISOString(), runner: out.runner };
  return result(text);
}

/** @param {Session} session @param {string} dir @param {Record<string, unknown>} args */
function parse(session, dir, args) {
  if (typeof args.path !== "string" || !args.path) return result("path is required.", true);
  const file = resolveFileInRoot(session.root, dir, args.path);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return result(`Report not found: ${args.path}`, true);
  }
  if (!st.isFile()) return result(`Not a file: ${args.path}`, true);
  if (st.size > MAX_REPORT_BYTES) return result(`Report too large (${st.size} bytes, max ${MAX_REPORT_BYTES}).`, true);
  const text = fs.readFileSync(file, "utf8");
  const format = typeof args.format === "string" && args.format ? args.format : detectFormat(text);
  if (!format) return result("Could not detect the report format. Pass `format` (junit, jest-json, tap, go-json, mocha-json).", true);
  if (!FORMATS.includes(format)) return result(`Unknown format: ${format}. Use one of ${FORMATS.join(", ")}.`, true);
  try {
    const report = parseByFormat(format, text, { roots: roots(session.root) });
    return result(formatReport(report, { runner: format }));
  } catch (e) {
    return result(`Could not parse ${args.path} as ${format}: ${clipEnd(/** @type {Error} */ (e).message, 300)}`, true);
  }
}

/** @param {Session} session */
function last(session) {
  if (!session.last) return result("No run_tests has been executed in this session yet.");
  return result(`Cached result of the last run (${session.last.runner}, ${session.last.at}):\n\n${session.last.text}`);
}
