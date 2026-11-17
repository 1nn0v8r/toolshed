// @ts-check
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{ name: string, event: "PreToolUse" | "PostToolUse", matcher: string, file: string, description: string }} HookDef
 */

/** @type {HookDef[]} */
export const HOOKS = [
  {
    name: "protect-files",
    event: "PreToolUse",
    matcher: "Read|Edit|Write|MultiEdit|Bash",
    file: "protect-files.js",
    description: "Deny access to .env files, keys, credentials and .ssh/",
  },
  {
    name: "block-secrets",
    event: "PreToolUse",
    matcher: "Edit|Write|MultiEdit",
    file: "block-secrets.js",
    description: "Deny edits that add secrets to files",
  },
  {
    name: "guard-bash",
    event: "PreToolUse",
    matcher: "Bash",
    file: "guard-bash.js",
    description: "Deny destructive and ask on risky shell commands",
  },
  {
    name: "auto-format",
    event: "PostToolUse",
    matcher: "Edit|Write|MultiEdit",
    file: "auto-format.js",
    description: "Format edited files with the project formatter",
  },
];

export const HOOK_NAMES = HOOKS.map((h) => h.name);

/** Directory holding the hook scripts, with forward slashes. */
export function hooksDir() {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks");
  return dir.replace(/\\/g, "/");
}

/**
 * Absolute path of a hook script, with forward slashes.
 * @param {HookDef} hook
 */
export function hookScriptPath(hook) {
  return `${hooksDir()}/${hook.file}`;
}

/**
 * The command string written into settings.json.
 * @param {HookDef} hook
 */
export function commandFor(hook) {
  return `node "${hookScriptPath(hook)}"`;
}
