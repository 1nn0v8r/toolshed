// @ts-check
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
export const SKIP_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
  "Cargo.lock", "poetry.lock", "composer.lock", "Gemfile.lock",
]);

/** @param {string} p */
export function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** @param {string} name */
export function isSkippedFile(name) {
  return SKIP_FILES.has(name) || name.endsWith(".map");
}

/**
 * Run git, resolving to stdout or null when git is missing or fails.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string | null>}
 */
export function git(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/**
 * List files under dir using git (tracked plus untracked, honoring ignore rules).
 * Returns null when dir is not inside a git work tree or git is unavailable.
 * @param {string} dir absolute directory
 * @returns {Promise<string[] | null>} absolute file paths
 */
export async function listGitFiles(dir) {
  const inside = await git(["rev-parse", "--is-inside-work-tree"], dir);
  if (inside === null || inside.trim() !== "true") return null;
  const out = await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], dir);
  if (out === null) return null;
  /** @type {string[]} */
  const files = [];
  for (const rel of out.split("\0")) {
    if (!rel) continue;
    const abs = path.join(dir, rel);
    try {
      if (fs.statSync(abs).isFile()) files.push(abs);
    } catch {
      // deleted but still in the index, or a submodule: skip
    }
  }
  return files;
}

/**
 * Walk a directory applying the default excludes. Symlinks are not followed.
 * @param {string} dir absolute directory
 * @returns {string[]} absolute file paths
 */
export function walkFiles(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} d */
  const visit = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(abs);
      } else if (e.isFile() && !isSkippedFile(e.name)) {
        out.push(abs);
      }
    }
  };
  visit(dir);
  return out;
}

/**
 * True when the first 8 KB of the file contain a NUL byte.
 * @param {string} file
 * @returns {boolean}
 */
export function isBinaryFile(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Resolve the CLI path arguments to a root and a list of absolute files.
 * Root is the single directory argument when there is exactly one, otherwise cwd.
 * @param {string[]} paths
 * @param {string} cwd
 * @returns {Promise<{root: string, files: string[], missing: string[]}>}
 */
export async function discover(paths, cwd) {
  const args = paths.length ? paths : ["."];
  const abs = args.map((p) => path.resolve(cwd, p));
  /** @type {string[]} */
  const missing = [];
  /** @type {Set<string>} */
  const files = new Set();
  let singleDir = false;
  for (let i = 0; i < abs.length; i++) {
    let st;
    try {
      st = fs.statSync(abs[i]);
    } catch {
      missing.push(args[i]);
      continue;
    }
    if (st.isDirectory()) {
      singleDir = abs.length === 1;
      const listed = (await listGitFiles(abs[i])) ?? walkFiles(abs[i]);
      for (const f of listed) files.add(f);
    } else if (st.isFile()) {
      files.add(abs[i]);
    }
  }
  const root = singleDir ? abs[0] : path.resolve(cwd);
  return { root, files: [...files], missing };
}
