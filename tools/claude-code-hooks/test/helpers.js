// @ts-check
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "src", "cli.js");

/** @param {string} name */
export function hookFile(name) {
  return path.join(ROOT, "src", "hooks", name + ".js");
}

/** Create a temp dir; the caller removes it with rmTmp. */
export function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-hooks-"));
}

/** @param {string} dir */
export function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Environment that never points at the real home.
 * @param {string} home
 * @param {Record<string, string>} [extra]
 */
export function testEnv(home, extra = {}) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  delete env.CLAUDE_PROJECT_DIR;
  env.CLAUDE_CODE_HOOKS_HOME = home;
  return Object.assign(env, extra);
}

/**
 * Spawn a hook script exactly as Claude Code does: JSON on stdin.
 * @param {string} name
 * @param {unknown} payload object (stringified) or raw string
 * @param {{ env?: Record<string, string>, home?: string }} [opts]
 */
export function runHookProcess(name, payload, opts = {}) {
  const home = opts.home || os.tmpdir();
  const r = spawnSync(process.execPath, [hookFile(name)], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: opts.env || testEnv(home),
    timeout: 30000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Parse the decision from hook stdout.
 * @param {string} stdout
 */
export function decisionOf(stdout) {
  if (!stdout.trim()) return { decision: "allow", reason: "" };
  const o = JSON.parse(stdout).hookSpecificOutput;
  return { decision: o.permissionDecision, reason: o.permissionDecisionReason, event: o.hookEventName };
}

/**
 * Secret-looking strings, assembled at runtime so no source file contains one.
 */
export const fx = {
  aws: () => "AK" + "IA" + "Q7".repeat(8),
  github: () => "gh" + "p_" + "a1B2".repeat(9),
  githubPat: () => "github" + "_pat_" + "a1B2c3".repeat(10),
  privateKeyHeader: () => "-----" + "BEGIN " + "RSA PRIV" + "ATE KEY" + "-----",
  slack: () => "xo" + "xb-" + "1234567890" + "-abcdefghij",
  stripe: () => "sk" + "_li" + "ve_" + "A1b2C3d4".repeat(3),
  anthropic: () => "sk" + "-ant-" + "api03-" + "Ab1".repeat(10),
  openai: () => "sk" + "-proj-" + "Ab1".repeat(10),
  google: () => ("AI" + "za" + "Sy" + "A1b2C3d4E5".repeat(4)).slice(0, 39),
  jwt: () => ["ey" + "JhbGciOiJIUzI1NiJ9", "ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0", "abc123DEF456ghi789"].join("."),
  /** value used on the right-hand side of assignments */
  realValue: () => ["Zx9", "Qw7Lm2", "Kp4Rt8"].join(""),
};

/**
 * Build a Claude Code PreToolUse payload.
 * @param {string} tool
 * @param {Record<string, unknown>} toolInput
 * @param {Record<string, unknown>} [extra]
 */
export function payload(tool, toolInput, extra = {}) {
  return Object.assign(
    {
      session_id: "s1",
      transcript_path: "/abs/path/to/transcript.jsonl",
      cwd: os.tmpdir(),
      hook_event_name: "PreToolUse",
      tool_name: tool,
      tool_input: toolInput,
    },
    extra,
  );
}
