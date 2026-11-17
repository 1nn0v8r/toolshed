#!/usr/bin/env node
// @ts-check
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { HOOKS, HOOK_NAMES, hookScriptPath } from "./lib/registry.js";
import { SCOPES, installInto, installedHooks, readSettings, settingsPath, uninstallFrom, writeSettings } from "./lib/settings.js";
import { isMain } from "./lib/io.js";

const VERSION = "0.1.0";

const USAGE = `claude-code-hooks ${VERSION}

Usage:
  claude-code-hooks install   [--scope user|project|local] [--hooks a,b,c] [--project-dir <dir>]
  claude-code-hooks uninstall [--scope user|project|local] [--hooks a,b,c] [--project-dir <dir>]
  claude-code-hooks status    [--scope user|project|local] [--project-dir <dir>] [--json]
  claude-code-hooks test <hook> --input <json-file>

Hooks: ${HOOK_NAMES.join(", ")}
Default scope: project. Exit codes: 0 ok, 1 failure or blocked, 2 usage error.
`;

class UsageError extends Error {}

/**
 * @typedef {{ stdout: { write: (s: string) => unknown }, stderr: { write: (s: string) => unknown }, cwd: string }} CliIo
 */

/**
 * @param {string | undefined} list
 * @returns {string[]}
 */
function parseHooks(list) {
  if (list === undefined) return HOOK_NAMES.slice();
  const names = list.split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) throw new UsageError("--hooks needs at least one hook name");
  for (const n of names) {
    if (!HOOK_NAMES.includes(n)) throw new UsageError(`Unknown hook "${n}". Known hooks: ${HOOK_NAMES.join(", ")}`);
  }
  return [...new Set(names)];
}

/** @param {string | undefined} scope */
function parseScope(scope) {
  const s = scope === undefined ? "project" : scope;
  if (!SCOPES.includes(s)) throw new UsageError(`Unknown scope "${s}". Use user, project or local`);
  return s;
}

/**
 * Run the CLI. Returns the exit code.
 * @param {string[]} argv arguments after the program name
 * @param {CliIo} [io]
 * @returns {number}
 */
export function main(argv, io) {
  const out = io || { stdout: process.stdout, stderr: process.stderr, cwd: process.cwd() };
  try {
    return run(argv, out);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (e instanceof UsageError) {
      out.stderr.write(`Error: ${m}\n\n${USAGE}`);
      return 2;
    }
    out.stderr.write(`Error: ${m}\n`);
    return 1;
  }
}

/**
 * @param {string[]} argv
 * @param {CliIo} io
 */
function run(argv, io) {
  /** @type {ReturnType<typeof parseArgs>} */
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        scope: { type: "string" },
        hooks: { type: "string" },
        "project-dir": { type: "string" },
        input: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const v = /** @type {Record<string, any>} */ (parsed.values);
  const [command, ...rest] = parsed.positionals;
  if (v.version) {
    io.stdout.write(VERSION + "\n");
    return 0;
  }
  if (v.help || command === "help") {
    io.stdout.write(USAGE);
    return 0;
  }
  if (!command) throw new UsageError("Missing command");
  const projectDir = path.resolve(io.cwd, v["project-dir"] || ".");

  switch (command) {
    case "install":
    case "uninstall": {
      if (rest.length > 0) throw new UsageError(`Unexpected argument "${rest[0]}"`);
      const scope = parseScope(v.scope);
      const names = parseHooks(v.hooks);
      const file = settingsPath(scope, projectDir);
      return command === "install" ? doInstall(file, scope, names, io) : doUninstall(file, scope, names, io);
    }
    case "status": {
      if (rest.length > 0) throw new UsageError(`Unexpected argument "${rest[0]}"`);
      const scopes = v.scope === undefined ? SCOPES : [parseScope(v.scope)];
      return doStatus(scopes, projectDir, Boolean(v.json), io);
    }
    case "test": {
      if (rest.length !== 1) throw new UsageError("test needs exactly one hook name");
      if (!v.input) throw new UsageError("test needs --input <json-file>");
      return doTest(rest[0], path.resolve(io.cwd, v.input), io);
    }
    default:
      throw new UsageError(`Unknown command "${command}"`);
  }
}

/**
 * @param {string} file
 * @param {string} scope
 * @param {string[]} names
 * @param {CliIo} io
 */
function doInstall(file, scope, names, io) {
  const { data } = readSettings(file);
  const settings = data || {};
  const res = installInto(settings, names);
  if (res.added.length === 0 && res.updated.length === 0) {
    io.stdout.write(`Already installed in ${file}: ${res.unchanged.join(", ")}\n`);
    return 0;
  }
  const backup = writeSettings(file, settings);
  if (backup) io.stdout.write(`Backed up existing settings to ${backup}\n`);
  if (res.added.length) io.stdout.write(`Installed (${scope}): ${res.added.join(", ")}\n`);
  if (res.updated.length) io.stdout.write(`Updated script path (${scope}): ${res.updated.join(", ")}\n`);
  if (res.unchanged.length) io.stdout.write(`Already present: ${res.unchanged.join(", ")}\n`);
  io.stdout.write(`Settings file: ${file}\n`);
  return 0;
}

/**
 * @param {string} file
 * @param {string} scope
 * @param {string[]} names
 * @param {CliIo} io
 */
function doUninstall(file, scope, names, io) {
  const { data, exists } = readSettings(file);
  if (!exists) {
    io.stdout.write(`No settings file at ${file}; nothing to remove\n`);
    return 0;
  }
  const removed = uninstallFrom(data, names);
  if (removed.length === 0) {
    io.stdout.write(`No claude-code-hooks entries found in ${file}\n`);
    return 0;
  }
  const backup = writeSettings(file, data);
  if (backup) io.stdout.write(`Backed up existing settings to ${backup}\n`);
  io.stdout.write(`Removed (${scope}): ${removed.join(", ")}\n`);
  return 0;
}

/**
 * @param {string[]} scopes
 * @param {string} projectDir
 * @param {boolean} asJson
 * @param {CliIo} io
 */
function doStatus(scopes, projectDir, asJson, io) {
  /** @type {any[]} */
  const report = [];
  for (const scope of scopes) {
    const file = settingsPath(scope, projectDir);
    const { data, exists } = readSettings(file);
    const on = installedHooks(data);
    report.push({ scope, file, exists, hooks: Object.fromEntries(HOOK_NAMES.map((n) => [n, on.includes(n)])) });
  }
  if (asJson) {
    io.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }
  for (const r of report) {
    io.stdout.write(`${r.scope}: ${r.file}${r.exists ? "" : " (no file)"}\n`);
    for (const n of HOOK_NAMES) io.stdout.write(`  ${n.padEnd(14)} ${r.hooks[n] ? "installed" : "not installed"}\n`);
  }
  return 0;
}

/**
 * @param {string} name
 * @param {string} inputFile
 * @param {CliIo} io
 */
function doTest(name, inputFile, io) {
  const hook = HOOKS.find((h) => h.name === name);
  if (!hook) throw new UsageError(`Unknown hook "${name}". Known hooks: ${HOOK_NAMES.join(", ")}`);
  let payload;
  try {
    payload = fs.readFileSync(inputFile, "utf8");
  } catch {
    throw new Error(`Cannot read input file ${inputFile}`);
  }
  const r = spawnSync(process.execPath, [hookScriptPath(hook)], { input: payload, encoding: "utf8", timeout: 30000, windowsHide: true });
  if (r.error) throw new Error(`Could not run the hook: ${r.error.message}`);
  const stderr = (r.stderr || "").trim();
  let decision = "allow";
  let reason = "";
  if (r.status === 2) {
    decision = "deny";
    reason = stderr;
  } else if (r.status !== 0) {
    io.stdout.write(`result: error (non-blocking, exit ${r.status})\n`);
    if (stderr) io.stdout.write(`stderr: ${stderr}\n`);
    return 1;
  } else if ((r.stdout || "").trim()) {
    try {
      const o = JSON.parse(r.stdout).hookSpecificOutput || {};
      decision = o.permissionDecision || "allow";
      reason = o.permissionDecisionReason || "";
    } catch {
      io.stdout.write(`result: error (hook printed invalid JSON)\n`);
      return 1;
    }
  }
  io.stdout.write(`hook: ${name}\ndecision: ${decision}\n`);
  if (reason) io.stdout.write(`reason: ${reason}\n`);
  if (stderr && decision !== "deny") io.stdout.write(`stderr: ${stderr}\n`);
  return decision === "allow" ? 0 : 1;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
