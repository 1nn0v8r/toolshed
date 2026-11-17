// @ts-check
import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const MAX_BUFFER = 64 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

/** Error whose message is safe to show to the assistant. */
export class ToolError extends Error {}

/**
 * Nearest directory at or above `start` that contains `.git`; falls back to `start`.
 * @param {string} start
 * @returns {string}
 */
export function detectRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

/**
 * Default root: REPO_ROOT env, else nearest git root above cwd.
 * @returns {string}
 */
export function defaultRoot() {
  return process.env.REPO_ROOT ? path.resolve(process.env.REPO_ROOT) : detectRepoRoot(process.cwd());
}

/**
 * Run git in `cwd` and resolve with stdout. Rejects with ToolError.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
export function git(cwd, args) {
  const full = [
    "--no-pager",
    "--literal-pathspecs",
    "-c", "core.quotepath=false",
    "-c", "i18n.logOutputEncoding=UTF-8",
    "-c", "log.showSignature=false",
    "-c", "color.ui=never",
    ...args,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      full,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        timeout: TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const e = /** @type {NodeJS.ErrnoException & { killed?: boolean }} */ (err);
        if (e.code === "ENOENT") return reject(new ToolError("git was not found on PATH."));
        if (e.killed) return reject(new ToolError("git timed out after 30 seconds."));
        const msg = String(stderr || e.message).trim().split(/\r?\n/).slice(0, 5).join(" ");
        reject(new ToolError(msg || "git failed."));
      }
    );
  });
}

/**
 * Resolve and validate the repo root for a call.
 * @param {string} fallback
 * @param {unknown} override optional absolute path
 * @returns {Promise<string>}
 */
export async function resolveRepo(fallback, override) {
  let root = fallback;
  if (override !== undefined && override !== null && String(override).trim() !== "") {
    const o = String(override).trim();
    if (!path.isAbsolute(o)) throw new ToolError("repoRoot must be an absolute path.");
    root = path.resolve(o);
  }
  let ok = false;
  try {
    ok = statSync(root).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) throw new ToolError(`Not a directory: ${root}`);
  try {
    const out = await git(root, ["rev-parse", "--is-inside-work-tree"]);
    if (out.trim() !== "true") throw new ToolError("");
  } catch {
    throw new ToolError(`Not a git repository: ${root}`);
  }
  return root;
}

/**
 * Validate a repo-relative file path and return it with forward slashes.
 * Rejects empty paths and anything that resolves outside the root.
 * @param {string} root
 * @param {unknown} input
 * @returns {string}
 */
export function safeRelPath(root, input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new ToolError("path is required.");
  if (raw.includes("\0")) throw new ToolError("Invalid path.");
  const abs = path.resolve(root, raw);
  const rel = path.relative(root, abs);
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || rel.startsWith("../") || path.isAbsolute(rel)) {
    throw new ToolError(`Path escapes the repo root: ${raw}`);
  }
  if (existsSync(abs)) {
    try {
      const realRel = path.relative(realpathSync(root), realpathSync(abs));
      if (realRel === ".." || realRel.startsWith(".." + path.sep) || path.isAbsolute(realRel)) {
        throw new ToolError(`Path escapes the repo root: ${raw}`);
      }
    } catch (e) {
      if (e instanceof ToolError) throw e;
    }
  }
  return rel.split(path.sep).join("/");
}

/**
 * Validate a revision or sha argument.
 * @param {unknown} input
 * @returns {string}
 */
export function safeRev(input) {
  const s = String(input ?? "").trim();
  if (!s) throw new ToolError("sha is required.");
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./^~@{}-]{0,199}$/.test(s)) throw new ToolError(`Invalid revision: ${s}`);
  return s;
}
