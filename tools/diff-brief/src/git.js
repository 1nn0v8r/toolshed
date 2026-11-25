// @ts-check
import { execFileSync } from "node:child_process";

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Run a git command safely without invoking a shell.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
export function runGit(cwd, args) {
  try {
    const stdout = execFileSync(
      "git",
      ["-c", "core.quotepath=false", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = /** @type {{ stdout?: string, stderr?: string, message?: string }} */ (err);
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: (e.stderr ?? e.message ?? "").trim()
    };
  }
}

/**
 * Resolve the repository root directory from cwd, or null if not in a git repo.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
export function getRepoRoot(cwd) {
  const res = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!res.ok) return null;
  const root = res.stdout.trim();
  return root || null;
}

/**
 * Return the current branch name, or "HEAD" if detached.
 *
 * @param {string} root
 * @returns {string}
 */
export function getCurrentBranch(root) {
  const res = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return res.ok ? res.stdout.trim() : "HEAD";
}

/**
 * Check if a git ref exists.
 *
 * @param {string} root
 * @param {string} ref
 * @returns {boolean}
 */
export function refExists(root, ref) {
  return runGit(root, ["rev-parse", "--verify", "--quiet", ref]).ok;
}

/**
 * Find a sensible default base branch (main, master, origin/main, origin/master).
 *
 * @param {string} root
 * @returns {string|null}
 */
export function detectDefaultBase(root) {
  for (const candidate of ["main", "master", "origin/main", "origin/master"]) {
    if (refExists(root, candidate)) return candidate;
  }
  return null;
}

/**
 * Check whether the working tree has staged or unstaged changes relative to HEAD.
 *
 * @param {string} root
 * @returns {boolean}
 */
export function hasWorkingChanges(root) {
  if (!refExists(root, "HEAD")) {
    const status = runGit(root, ["status", "--porcelain"]);
    return status.ok && status.stdout.trim().length > 0;
  }
  const res = runGit(root, ["status", "--porcelain"]);
  return res.ok && res.stdout.trim().length > 0;
}

/**
 * Fetch a unified diff for the requested mode or range.
 *
 * @param {string} root
 * @param {{
 *   mode: "auto"|"staged"|"unstaged"|"all"|"range"|"base"|"commit",
 *   target?: string
 * }} opts
 * @returns {{ scope: string, diffText: string, commits: string[] }}
 */
export function fetchGitDiff(root, opts) {
  const commonDiffArgs = ["--no-color", "--no-ext-diff", "--unified=3"];
  let args;
  let scope;
  /** @type {string[]} */
  let commits = [];

  if (opts.mode === "staged") {
    args = ["diff", "--cached", ...commonDiffArgs];
    scope = "staged changes (--cached)";
  } else if (opts.mode === "unstaged") {
    args = ["diff", ...commonDiffArgs];
    scope = "unstaged working tree";
  } else if (opts.mode === "all") {
    if (refExists(root, "HEAD")) {
      args = ["diff", "HEAD", ...commonDiffArgs];
      scope = "working tree vs HEAD";
    } else {
      args = ["diff", "--cached", ...commonDiffArgs];
      scope = "staged changes (initial commit)";
    }
  } else if (opts.mode === "commit") {
    const sha = opts.target ?? "HEAD";
    args = ["diff-tree", "--no-commit-id", "-p", "-r", "--root", ...commonDiffArgs, sha];
    scope = `commit ${sha}`;
    const logRes = runGit(root, ["log", "-1", "--oneline", sha]);
    if (logRes.ok && logRes.stdout.trim()) commits = [logRes.stdout.trim()];
  } else if (opts.mode === "base") {
    const base = opts.target ?? detectDefaultBase(root);
    if (!base) {
      throw new Error("Could not detect a base branch (main/master). Pass --base <ref>.");
    }
    const range = `${base}...HEAD`;
    args = ["diff", ...commonDiffArgs, range];
    scope = `${range} (merge-base)`;
    const logRes = runGit(root, ["log", "--oneline", `${base}..HEAD`]);
    if (logRes.ok && logRes.stdout.trim()) {
      commits = logRes.stdout.trim().split(/\r?\n/).slice(0, 30);
    }
  } else if (opts.mode === "range") {
    const target = opts.target ?? "";
    args = ["diff", ...commonDiffArgs, target];
    scope = target;
    if (target.includes("..")) {
      const logRes = runGit(root, ["log", "--oneline", target]);
      if (logRes.ok && logRes.stdout.trim()) {
        commits = logRes.stdout.trim().split(/\r?\n/).slice(0, 30);
      }
    }
  } else {
    // auto mode: prefer local changes if present; otherwise compare current branch against base or HEAD~1
    const branch = getCurrentBranch(root);
    const hasHead = refExists(root, "HEAD");
    if (hasWorkingChanges(root)) {
      if (hasHead) {
        const diffHead = runGit(root, ["diff", "HEAD", ...commonDiffArgs]);
        if (diffHead.ok && diffHead.stdout.trim().length > 0) {
          return { scope: "working tree vs HEAD", diffText: diffHead.stdout, commits: [] };
        }
      }
      const diffCached = runGit(root, ["diff", "--cached", ...commonDiffArgs]);
      if (diffCached.ok && diffCached.stdout.trim().length > 0) {
        return { scope: "staged changes (--cached)", diffText: diffCached.stdout, commits: [] };
      }
    }
    const base = detectDefaultBase(root);
    if (base && branch !== base && branch !== "HEAD") {
      const range = `${base}...HEAD`;
      args = ["diff", ...commonDiffArgs, range];
      scope = `${range} (merge-base)`;
      const logRes = runGit(root, ["log", "--oneline", `${base}..HEAD`]);
      if (logRes.ok && logRes.stdout.trim()) {
        commits = logRes.stdout.trim().split(/\r?\n/).slice(0, 30);
      }
    } else if (hasHead && refExists(root, "HEAD~1")) {
      args = ["diff", ...commonDiffArgs, "HEAD~1..HEAD"];
      scope = "HEAD~1..HEAD";
      const logRes = runGit(root, ["log", "-1", "--oneline", "HEAD"]);
      if (logRes.ok && logRes.stdout.trim()) commits = [logRes.stdout.trim()];
    } else if (hasHead) {
      args = ["diff-tree", "--no-commit-id", "-p", "-r", "--root", ...commonDiffArgs, "HEAD"];
      scope = "commit HEAD";
    } else {
      return { scope: "empty repository", diffText: "", commits: [] };
    }
  }

  const res = runGit(root, args);
  if (!res.ok) {
    throw new Error(res.stderr || `git ${args[0]} failed for ${scope}`);
  }
  return { scope, diffText: res.stdout, commits };
}
