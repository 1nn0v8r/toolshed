// @ts-check
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export class GitMissingError extends Error {}

/**
 * Run git with an args array.
 * @param {string[]} args
 * @param {string} cwd
 * @param {string} [input]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function git(args, cwd, input) {
  const r = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) {
    if (/** @type {NodeJS.ErrnoException} */ (r.error).code === "ENOENT") {
      throw new GitMissingError("git was not found on PATH");
    }
    throw r.error;
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * @param {string} cwd
 * @returns {string | null} repo top-level folder, or null when not in a work tree
 */
export function repoRoot(cwd) {
  const r = git(["rev-parse", "--show-toplevel"], cwd);
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  return out ? path.resolve(out) : null;
}

/** @param {string} root */
export function stagedDiff(root) {
  const r = git(
    [
      "-c", "core.quotepath=false",
      "diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--no-textconv",
      "--src-prefix=a/", "--dst-prefix=b/", "--diff-filter=ACMR",
    ],
    root,
  );
  if (r.status !== 0) throw new Error(`git diff failed: ${r.stderr.trim()}`);
  return r.stdout;
}

/**
 * @param {string} root
 * @returns {string[]}
 */
export function stagedFiles(root) {
  const r = git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR", "--no-ext-diff"], root);
  if (r.status !== 0) throw new Error(`git diff failed: ${r.stderr.trim()}`);
  return r.stdout.split("\0").filter(Boolean);
}

/**
 * @param {string} root
 * @returns {string[]}
 */
export function trackedFiles(root) {
  const r = git(["ls-files", "-z"], root);
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr.trim()}`);
  return r.stdout.split("\0").filter(Boolean);
}

/**
 * Sizes of staged blobs. Paths containing a newline are skipped.
 * @param {string} root
 * @param {string[]} files
 * @returns {Map<string, number>}
 */
export function stagedSizes(root, files) {
  const usable = files.filter((f) => !f.includes("\n"));
  /** @type {Map<string, number>} */
  const sizes = new Map();
  if (usable.length === 0) return sizes;
  const r = git(["cat-file", "--batch-check"], root, usable.map((f) => `:${f}`).join("\n") + "\n");
  const lines = r.stdout.split("\n");
  usable.forEach((f, i) => {
    const m = /^[0-9a-f]+ blob (\d+)$/.exec(lines[i] ?? "");
    if (m) sizes.set(f, Number(m[1]));
  });
  return sizes;
}

/**
 * Directory git runs hooks from, honouring core.hooksPath.
 * @param {string} root
 * @returns {string}
 */
export function hooksDir(root) {
  const cfg = git(["config", "--get", "core.hooksPath"], root);
  const configured = cfg.status === 0 ? cfg.stdout.trim() : "";
  if (configured) {
    if (configured === "~" || configured.startsWith("~/")) {
      return path.join(os.homedir(), configured.slice(1));
    }
    return path.resolve(root, configured);
  }
  const r = git(["rev-parse", "--git-path", "hooks"], root);
  if (r.status !== 0) throw new Error(`cannot locate hooks folder: ${r.stderr.trim()}`);
  return path.resolve(root, r.stdout.trim());
}
