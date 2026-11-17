// @ts-check
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_EXCLUDES = ["node_modules", ".git", "dist", "build", "coverage", "vendor", ".venv"];

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ ok: boolean, stdout: string }>}
 */
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer: 512 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
      resolve(err ? { ok: false, stdout: "" } : { ok: true, stdout });
    });
  });
}

/**
 * Files visible to git (tracked plus untracked-but-not-ignored), relative to `dir`, with `/` separators.
 * @param {string} dir
 * @returns {Promise<string[] | null>} null when `dir` is not in a git repo or git is not installed
 */
async function gitFiles(dir) {
  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") return null;
  const res = await git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (!res.ok) return null;
  return res.stdout.split("\0").filter(Boolean);
}

/**
 * Walk a directory tree, skipping excluded folder names and symlinks.
 * @param {string} dir
 * @param {string[]} excludes
 * @returns {string[]}
 */
function walk(dir, excludes) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  const visit = (rel) => {
    /** @type {fs.Dirent[]} */
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!excludes.includes(e.name)) visit(childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  };
  visit("");
  return out;
}

/**
 * List candidate files under `dir`.
 * @param {string} dir absolute directory
 * @returns {Promise<{ files: string[], mode: "git" | "walk" }>}
 */
export async function listFiles(dir) {
  const viaGit = await gitFiles(dir);
  if (viaGit) return { files: viaGit.sort(), mode: "git" };
  return { files: walk(dir, DEFAULT_EXCLUDES).sort(), mode: "walk" };
}

/**
 * Keep only files inside one of the given paths (files or folders, relative to the scan root).
 * @param {string[]} files
 * @param {string[]} paths
 */
export function restrictToPaths(files, paths) {
  const prefixes = paths
    .map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter((p) => p && p !== ".");
  if (prefixes.length === 0) return files;
  return files.filter((f) => prefixes.some((p) => f === p || f.startsWith(`${p}/`)));
}
