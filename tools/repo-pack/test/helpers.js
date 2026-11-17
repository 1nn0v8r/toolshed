// @ts-check
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

/** @returns {string} a fresh temp folder (caller removes it) */
export function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repo-pack-")));
}

/** @param {string} dir */
export function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Write a file (creating folders). Content may be a string or a Buffer.
 * @param {string} root
 * @param {string} rel forward-slash relative path
 * @param {string | Buffer} content
 */
export function put(root, rel, content) {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
export function git(cwd, args) {
  const r = spawnSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * Init a repo and commit everything currently in the folder.
 * @param {string} cwd
 */
export function initRepo(cwd) {
  git(cwd, ["init", "-q"]);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", "init"]);
}

/**
 * Run the real CLI.
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {{code: number | null, stdout: string, stderr: string}}
 */
export function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
