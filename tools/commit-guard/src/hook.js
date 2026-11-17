// @ts-check
import fs from "node:fs";
import path from "node:path";
import { hooksDir } from "./git.js";

export const MARKER = "# commit-guard-hook: managed by commit-guard install";

/** @param {string} p */
function shQuote(p) {
  return '"' + p.replace(/\\/g, "/").replace(/(["$`\\])/g, "\\$1") + '"';
}

/**
 * POSIX sh script that runs the staged check.
 * @param {string} cliPath absolute path to src/cli.js
 */
export function hookScript(cliPath) {
  return ["#!/bin/sh", MARKER, `exec node ${shQuote(cliPath)} check --staged`, ""].join("\n");
}

/**
 * @typedef {{ code: number, message: string }} HookResult
 */

/**
 * @param {string} root repo root
 * @param {{ force: boolean, cliPath: string }} opts
 * @returns {HookResult}
 */
export function installHook(root, opts) {
  const dir = hooksDir(root);
  const file = path.join(dir, "pre-commit");
  let backupNote = "";
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8");
    if (!existing.includes(MARKER)) {
      if (!opts.force) {
        return {
          code: 1,
          message: `A pre-commit hook already exists at ${file} and was not installed by commit-guard. Re-run with --force to replace it (the old hook is backed up).`,
        };
      }
      let backup = file + ".commit-guard-backup";
      for (let i = 1; fs.existsSync(backup); i++) backup = `${file}.commit-guard-backup.${i}`;
      fs.copyFileSync(file, backup);
      backupNote = ` Previous hook saved to ${backup}.`;
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, hookScript(opts.cliPath), { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return { code: 0, message: `Installed pre-commit hook at ${file}.${backupNote}` };
}

/**
 * @param {string} root repo root
 * @returns {HookResult}
 */
export function uninstallHook(root) {
  const file = path.join(hooksDir(root), "pre-commit");
  if (!fs.existsSync(file)) return { code: 0, message: "No pre-commit hook is installed." };
  if (!fs.readFileSync(file, "utf8").includes(MARKER)) {
    return { code: 1, message: `The pre-commit hook at ${file} was not installed by commit-guard, so it was left alone.` };
  }
  fs.rmSync(file);
  return { code: 0, message: `Removed pre-commit hook at ${file}.` };
}
