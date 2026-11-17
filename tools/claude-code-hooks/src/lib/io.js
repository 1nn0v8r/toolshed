// @ts-check
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

/**
 * @typedef {{ decision: "allow" | "deny" | "ask", reason: string }} Decision
 */

/** @returns {Decision} */
export function allow() {
  return { decision: "allow", reason: "" };
}

/**
 * @param {string} reason
 * @returns {Decision}
 */
export function deny(reason) {
  return { decision: "deny", reason };
}

/**
 * @param {string} reason
 * @returns {Decision}
 */
export function ask(reason) {
  return { decision: "ask", reason };
}

/**
 * Read a whole stream as UTF-8 text.
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<string>}
 */
export function readStream(stream) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    stream.on("data", (c) => chunks.push(Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

/**
 * Parse hook stdin. Returns null when the text is not a JSON object.
 * @param {string} text
 * @returns {any}
 */
export function parseInput(text) {
  try {
    const v = JSON.parse(text.replace(/^﻿/, ""));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * True when the module at `metaUrl` is the process entry script.
 * @param {string} metaUrl
 * @returns {boolean}
 */
export function isMain(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(entry);
  } catch {
    return false;
  }
}

/**
 * Build the PreToolUse stdout payload for a non-allow decision.
 * @param {string} hookName
 * @param {Decision} result
 */
export function toOutput(hookName, result) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: result.decision,
      permissionDecisionReason: `[claude-code-hooks:${hookName}] ${result.reason}`,
    },
  };
}

/**
 * Shared entry point for every hook script. Never throws; on any internal
 * problem the call is allowed and a note goes to stderr.
 * @param {string} name
 * @param {(input: any, config: any) => Decision | Promise<Decision>} evaluate
 * @param {{ preTool?: boolean }} [opts]
 */
export async function runHook(name, evaluate, opts = {}) {
  const preTool = opts.preTool !== false;
  process.exitCode = 0;
  let text = "";
  try {
    text = await readStream(process.stdin);
  } catch (e) {
    process.stderr.write(`claude-code-hooks ${name}: could not read stdin, allowing: ${msg(e)}\n`);
    return;
  }
  const input = parseInput(text);
  if (!input) {
    process.stderr.write(`claude-code-hooks ${name}: input is not a JSON object, allowing\n`);
    return;
  }
  try {
    const config = loadConfig(name, typeof input.cwd === "string" ? input.cwd : undefined);
    const result = await evaluate(input, config);
    if (preTool && result && result.decision !== "allow") {
      process.stdout.write(JSON.stringify(toOutput(name, result)) + "\n");
    }
  } catch (e) {
    process.stderr.write(`claude-code-hooks ${name}: internal error, allowing: ${msg(e)}\n`);
  }
}

/** @param {unknown} e */
function msg(e) {
  return e instanceof Error ? e.message : String(e);
}
