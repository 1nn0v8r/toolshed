// @ts-check
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

/**
 * @param {string} cwd
 * @param {string[]} args
 */
export function git(cwd, args) {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

/** Create an empty temp git repo. */
export function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-gen-"));
  git(dir, ["init", "-q"]);
  return dir;
}

/** Make a temp dir that is not a git repo. */
export function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "changelog-gen-"));
}

/** @param {string} dir */
export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

let counter = 0;

/**
 * Commit a change (touching `file`, default a fresh file) with a message.
 * @param {string} dir
 * @param {string} message full message (subject and body)
 * @param {string} [file] relative path to write
 */
export function commit(dir, message, file) {
  const rel = file || `f${counter++}.txt`;
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.appendFileSync(full, `${counter++}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/**
 * Run the real CLI.
 * @param {string} cwd
 * @param {string[]} args
 */
export function cli(cwd, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
