// @ts-check
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { scanTextForFlakes } from "./rules.js";

/**
 * @typedef {import("./rules.js").Finding} Finding
 * @typedef {import("./config.js").FlakeCheckConfig} FlakeCheckConfig
 */

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".turbo",
]);

const CODE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
  ".py",
  ".go",
  ".rb",
  ".rs",
]);

const TEST_DIR_NAMES = new Set(["test", "tests", "__tests__", "spec", "specs"]);

/**
 * Normalize path separators to forward slashes.
 * @param {string} p
 * @returns {string}
 */
export function toPosixPath(p) {
  return p.split(path.sep).join("/");
}

/**
 * Check whether a relative POSIX path looks like a test file.
 * @param {string} relPosix
 * @returns {boolean}
 */
export function isTestFile(relPosix) {
  const base = path.posix.basename(relPosix);
  const ext = path.posix.extname(base).toLowerCase();
  if (!CODE_EXTENSIONS.has(ext)) return false;

  if (
    /\.(?:test|spec)\.[^.]+$/i.test(base) ||
    /_test\.[^.]+$/i.test(base) ||
    /^test_.*\.py$/i.test(base)
  ) {
    return true;
  }

  const parts = relPosix.split("/");
  return parts.slice(0, -1).some((part) => TEST_DIR_NAMES.has(part.toLowerCase()));
}

/**
 * Convert a simple glob pattern to a RegExp.
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegex(glob) {
  const normalized = toPosixPath(glob).replace(/^\.\//, "");
  let out = "^";
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    if (c === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  out += "$";
  return new RegExp(out);
}

/**
 * Test if `relPosix` matches any glob in `patterns`.
 * @param {string} relPosix
 * @param {string[]} patterns
 * @returns {boolean}
 */
function isIgnoredByGlob(relPosix, patterns) {
  for (const pat of patterns) {
    if (globToRegex(pat).test(relPosix)) return true;
  }
  return false;
}

/**
 * Recursively collect candidate test files under `dir`.
 * @param {string} rootDir
 * @param {string} dir
 * @param {string[]} ignoreGlobs
 * @param {string[]} out
 */
function walkTestFiles(rootDir, dir, ignoreGlobs, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = toPosixPath(path.relative(rootDir, abs));
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (isIgnoredByGlob(rel, ignoreGlobs) || isIgnoredByGlob(rel + "/", ignoreGlobs)) continue;
      walkTestFiles(rootDir, abs, ignoreGlobs, out);
    } else if (entry.isFile()) {
      if (isIgnoredByGlob(rel, ignoreGlobs)) continue;
      if (isTestFile(rel)) out.push(rel);
    }
  }
}

/**
 * Collect staged or changed test files via git.
 * @param {string} cwd
 * @param {{ staged?: boolean, diffRef?: string }} opts
 * @returns {string[]}
 */
export function getGitChangedFiles(cwd, opts) {
  const args = opts.staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]
    : ["diff", "--name-only", "--diff-filter=ACMR", opts.diffRef || "HEAD"];

  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    const detail = (res.stderr || res.error?.message || "git command failed").trim();
    throw new Error(`Failed to list git files: ${detail}`);
  }

  const files = new Set(
    (res.stdout || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/\\/g, "/")),
  );

  if (!opts.staged) {
    const untracked = spawnSync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd, encoding: "utf8" },
    );
    if (untracked.status === 0) {
      for (const line of (untracked.stdout || "").split(/\r?\n/)) {
        const trimmed = line.trim().replace(/\\/g, "/");
        if (trimmed) files.add(trimmed);
      }
    }
  }

  return [...files].filter((f) => isTestFile(f)).sort();
}

/**
 * Scan repository or explicit targets for static flakiness patterns.
 * @param {{
 *   cwd: string,
 *   targets?: string[],
 *   staged?: boolean,
 *   changed?: boolean,
 *   diffRef?: string,
 *   config: FlakeCheckConfig,
 *   extraIgnoreRules?: string[],
 * }} options
 * @returns {{
 *   findings: Finding[],
 *   scannedFiles: number,
 *   skippedLarge: string[],
 *   files: string[],
 * }}
 */
export function scanRepository(options) {
  const { cwd, config } = options;
  const ignoreRules = new Set([...config.ignoreRules, ...(options.extraIgnoreRules ?? [])]);

  /** @type {string[]} */
  let files = [];

  if (options.staged || options.changed || options.diffRef) {
    files = getGitChangedFiles(cwd, {
      staged: options.staged,
      diffRef: options.diffRef,
    }).filter((rel) => !isIgnoredByGlob(rel, config.ignoreFiles));
  } else if (options.targets && options.targets.length > 0) {
    const seen = new Set();
    for (const target of options.targets) {
      const abs = path.resolve(cwd, target);
      if (!fs.existsSync(abs)) {
        throw new Error(`Target path not found: ${target}`);
      }
      const stat = fs.statSync(abs);
      if (stat.isFile()) {
        const rel = toPosixPath(path.relative(cwd, abs));
        if (!isIgnoredByGlob(rel, config.ignoreFiles) && !seen.has(rel)) {
          seen.add(rel);
          files.push(rel);
        }
      } else if (stat.isDirectory()) {
        /** @type {string[]} */
        const found = [];
        walkTestFiles(cwd, abs, config.ignoreFiles, found);
        for (const f of found) {
          if (!seen.has(f)) {
            seen.add(f);
            files.push(f);
          }
        }
      }
    }
  } else {
    walkTestFiles(cwd, cwd, config.ignoreFiles, files);
  }

  const maxBytes = config.maxFileSizeKB * 1024;
  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const skippedLarge = [];
  let scannedFiles = 0;

  for (const rel of files) {
    const abs = path.resolve(cwd, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > maxBytes) {
      skippedLarge.push(rel);
      continue;
    }

    const buf = fs.readFileSync(abs);
    // Skip binary files
    if (buf.includes(0)) continue;

    scannedFiles += 1;
    const text = buf.toString("utf8");
    const fileFindings = scanTextForFlakes(text, rel, { ignoreRules });
    findings.push(...fileFindings);
  }

  return {
    findings,
    scannedFiles,
    skippedLarge,
    files,
  };
}
