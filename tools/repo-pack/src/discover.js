// @ts-check
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_EXCLUDED_DIRS = ["node_modules", ".git", "dist", "build", "coverage"];

const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock",
  "bun.lockb", "cargo.lock", "gemfile.lock", "poetry.lock", "composer.lock", "pipfile.lock",
  "go.sum", "uv.lock", "pubspec.lock", "podfile.lock",
]);

/**
 * @param {string} relPath
 * @returns {string}
 */
function baseName(relPath) {
  return relPath.slice(relPath.lastIndexOf("/") + 1);
}

/**
 * True for any file whose name starts with ".env" (.env, .env.local, .envrc).
 * @param {string} relPath
 * @returns {boolean}
 */
export function isEnvFile(relPath) {
  return baseName(relPath).toLowerCase().startsWith(".env");
}

/**
 * Lockfiles, source maps and logs.
 * @param {string} relPath
 * @returns {boolean}
 */
export function isDefaultExcludedFile(relPath) {
  const b = baseName(relPath).toLowerCase();
  return LOCKFILES.has(b) || b.endsWith(".map") || b.endsWith(".log");
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ok: boolean, stdout: string}>}
 */
function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 512 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, stdout) => resolve({ ok: !err, stdout: String(stdout || "") }),
    );
  });
}

/**
 * Files git knows about (tracked plus untracked-but-not-ignored), relative to
 * root with forward slashes. Returns null when root is not in a git work tree
 * or git is not installed.
 * @param {string} root
 * @returns {Promise<string[] | null>}
 */
export async function listGitFiles(root) {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], root);
  if (!inside.ok || inside.stdout.trim() !== "true") return null;
  const res = await runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root);
  if (!res.ok) return null;
  return res.stdout.split("\0").filter((s) => s.length > 0);
}

/**
 * Walk a folder without git. Skips default-excluded folders (when asked) and
 * symlinks. Returns forward-slash relative paths.
 * @param {string} root
 * @param {boolean} skipDefaultDirs
 * @returns {Promise<string[]>}
 */
export async function walkFiles(root, skipDefaultDirs) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  async function visit(rel) {
    let entries;
    try {
      entries = await fs.promises.readdir(path.join(root, ...(rel ? rel.split("/") : [])), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (skipDefaultDirs && DEFAULT_EXCLUDED_DIRS.includes(e.name)) continue;
        await visit(childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  }
  await visit("");
  return out;
}

/**
 * @param {string} root
 * @param {{defaultExcludes: boolean}} opts
 * @returns {Promise<{mode: "git" | "walk", files: string[]}>}
 */
export async function listFiles(root, opts) {
  const git = await listGitFiles(root);
  if (git) return { mode: "git", files: [...new Set(git)] };
  return { mode: "walk", files: await walkFiles(root, opts.defaultExcludes) };
}
