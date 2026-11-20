// @ts-check
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SUPPORTED_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".vue",
  ".svelte",
  ".astro"
]);

export const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "vendor",
  ".venv",
  ".next",
  ".nuxt",
  ".output",
  "out"
];

/**
 * Executes a git command.
 *
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
 * Returns candidate files visible to git relative to `dir` with `/` separators.
 *
 * @param {string} dir
 * @returns {Promise<string[] | null>}
 */
async function gitFiles(dir) {
  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") return null;
  const res = await git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (!res.ok) return null;
  return res.stdout.split("\0").filter(Boolean);
}

/**
 * Walks directory tree skipping excluded folder names and symlinks.
 *
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
 * Checks if a relative file path has a supported source code extension.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isSupportedSourceFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * Classifies whether a file is a development file (tests, mocks, scripts, configs)
 * or production source code.
 *
 * @param {string} relPath relative file path using `/` or `\`
 * @returns {"dev" | "prod"}
 */
export function categorizeFile(relPath) {
  const normalized = relPath.replace(/\\/g, "/");
  const base = path.basename(normalized).toLowerCase();

  // Test directories or paths
  if (
    /(?:^|\/)(?:tests?|__tests__|__mocks__|spec|specs|fixtures?)(?:\/|$)/i.test(normalized)
  ) {
    return "dev";
  }

  // Test or spec file names
  if (/\.(?:test|spec|bench)\.[a-z0-9]+$/i.test(base)) {
    return "dev";
  }

  // Scripts or tooling directories
  if (/(?:^|\/)(?:scripts|tools)(?:\/|$)/i.test(normalized)) {
    return "dev";
  }

  // Config files
  if (
    /\.config\.[a-z0-9]+$/i.test(base) ||
    /^(?:jest|vitest|playwright|cypress|webpack|rollup|vite|esbuild)\.config\./i.test(base)
  ) {
    return "dev";
  }

  return "prod";
}

/**
 * Lists all candidate source files under `dir`.
 *
 * @param {string} dir absolute directory
 * @returns {Promise<{ files: string[], mode: "git" | "walk" }>}
 */
export async function listFiles(dir) {
  const viaGit = await gitFiles(dir);
  const rawFiles = viaGit ? viaGit : walk(dir, DEFAULT_EXCLUDES);
  const mode = viaGit ? "git" : "walk";
  const supported = rawFiles
    .map((f) => f.replace(/\\/g, "/"))
    .filter(isSupportedSourceFile)
    .sort();

  return { files: supported, mode };
}

/**
 * Restricts candidate files to chosen paths or prefixes.
 *
 * @param {string[]} files
 * @param {string[]} paths
 * @returns {string[]}
 */
export function restrictToPaths(files, paths) {
  const prefixes = paths
    .map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter((p) => p && p !== ".");
  if (prefixes.length === 0) return files;
  return files.filter((f) => prefixes.some((p) => f === p || f.startsWith(`${p}/`)));
}
