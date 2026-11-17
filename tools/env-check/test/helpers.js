// @ts-check
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

/** Create a temp dir. Call the returned cleanup when done. */
export function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-check-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Write files (relative path to content) under dir.
 * @param {string} dir
 * @param {Record<string, string>} files
 */
export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/** @param {string} dir */
export function gitInit(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
}

/** @param {string} dir */
export function gitCommitAll(dir) {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], { cwd: dir });
}

/**
 * Spawn the real CLI.
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 */
export function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** An environment where `git` cannot be found. */
export function envWithoutGit() {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toLowerCase() !== "path") env[k] = v;
  }
  env.PATH = os.tmpdir();
  return env;
}
