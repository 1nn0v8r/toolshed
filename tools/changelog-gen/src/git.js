// @ts-check
import { execFile } from "node:child_process";

/**
 * @typedef {{ hash: string, short: string, parents: string[], subject: string, body: string }} RawCommit
 */

const FIELD_SEP = "\x1f";
const MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Error raised when git cannot be run or a git command fails.
 */
export class GitError extends Error {
  /**
   * @param {string} message
   * @param {{ missing?: boolean }} [flags]
   */
  constructor(message, flags = {}) {
    super(message);
    this.name = "GitError";
    this.missing = Boolean(flags.missing);
  }
}

/**
 * Run git with an args array (no shell).
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, GIT_PAGER: "cat" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = /** @type {NodeJS.ErrnoException} */ (err);
          if (e.code === "ENOENT") {
            reject(new GitError("git was not found on PATH", { missing: true }));
            return;
          }
          const code = /** @type {unknown} */ (e.code);
          if (typeof code === "number") {
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
            return;
          }
          reject(new GitError(`could not run git: ${e.message}`));
          return;
        }
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/**
 * @param {string} cwd
 * @returns {Promise<boolean>}
 */
export async function isGitRepo(cwd) {
  const r = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  return r.code === 0 && r.stdout.trim() === "true";
}

/**
 * Resolve a ref to a commit hash, or null when it does not exist.
 * @param {string} ref
 * @param {string} cwd
 * @returns {Promise<string | null>}
 */
export async function resolveRef(ref, cwd) {
  const r = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Escape glob metacharacters for `git describe --match`.
 * @param {string} s
 */
function escapeGlob(s) {
  return s.replace(/[\\*?[\]]/g, (c) => `\\${c}`);
}

/**
 * Find the latest tag reachable from `to` whose name starts with `prefix`.
 * @param {string} prefix
 * @param {string} to
 * @param {string} cwd
 * @returns {Promise<string | null>}
 */
export async function latestTag(prefix, to, cwd) {
  const r = await git(["describe", "--tags", "--abbrev=0", "--match", `${escapeGlob(prefix)}*`, to], cwd);
  if (r.code !== 0) return null;
  const tag = r.stdout.trim();
  return tag || null;
}

/**
 * Parse NUL-separated `git log` output produced by readCommits.
 * Fields are separated by the ASCII unit separator (0x1f).
 * @param {string} out
 * @returns {RawCommit[]}
 */
export function parseLog(out) {
  /** @type {RawCommit[]} */
  const commits = [];
  for (const rec of out.split("\0")) {
    const r = rec.replace(/^\n+/, "");
    if (!r) continue;
    const parts = r.split(FIELD_SEP);
    if (parts.length < 3) continue;
    const [hash, parents, subject, ...rest] = parts;
    commits.push({
      hash,
      short: hash.slice(0, 7),
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      subject,
      body: rest.join(FIELD_SEP),
    });
  }
  return commits;
}

/**
 * Read commits in a range.
 * @param {{ cwd: string, from?: string | null, to: string, path?: string | null, includeMerges: boolean }} opts
 * @returns {Promise<RawCommit[]>}
 */
export async function readCommits(opts) {
  const args = ["log", "-z", "--no-color", "--encoding=UTF-8", "--format=%H%x1f%P%x1f%s%x1f%b"];
  if (!opts.includeMerges) args.push("--no-merges");
  args.push(opts.from ? `${opts.from}..${opts.to}` : opts.to);
  if (opts.path) args.push("--", opts.path);
  const r = await git(args, opts.cwd);
  if (r.code !== 0) throw new GitError(`git log failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return parseLog(r.stdout);
}
