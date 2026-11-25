// @ts-check
import path from "node:path";
import { matchesAnyGlob, normalizePath } from "./config.js";

/**
 * @typedef {"lockfile"|"generated"|"test"|"docs"|"config"|"source"} FileCategory
 */

/**
 * @typedef {object} PackageJsonDelta
 * @property {string[]} addedDeps
 * @property {string[]} removedDeps
 * @property {string[]} updatedDeps
 * @property {string[]} changedScripts
 */

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "uv.lock",
  "pipfile.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
  "podfile.lock",
  "packages.lock.json"
]);

const GENERATED_PATTERNS = [
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.snap",
  "*.pb.go",
  "*.pb.ts",
  "*.generated.*",
  "dist/**",
  "build/**",
  "coverage/**",
  ".next/**",
  "out/**"
];

const TEST_PATTERNS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/spec/**"
];

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);

const CONFIG_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "cargo.toml",
  "go.mod",
  "dockerfile",
  "makefile",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
  ".nvmrc",
  ".editorconfig"
]);

const CONFIG_EXTENSIONS = new Set([
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".conf",
  ".env",
  ".rules"
]);

const SENSITIVE_PATTERNS = [
  ".github/workflows/**",
  ".gitlab-ci.yml",
  "**/dockerfile*",
  "**/docker-compose*",
  "**/.env*",
  "**/*.sql",
  "**/migrations/**",
  "**/firestore.rules",
  "**/storage.rules",
  "**/*auth*",
  "**/*security*",
  "**/*permission*",
  "**/*rbac*",
  "**/*acl*",
  "**/*crypto*",
  "**/*secret*"
];

/**
 * Categorize a file path into one of the review categories.
 *
 * @param {string} filePath
 * @param {string[]} [extraTestPatterns]
 * @returns {FileCategory}
 */
export function categorizeFile(filePath, extraTestPatterns = []) {
  const norm = normalizePath(filePath);
  const base = path.posix.basename(norm).toLowerCase();
  const ext = path.posix.extname(base);

  if (LOCKFILE_NAMES.has(base)) return "lockfile";
  if (matchesAnyGlob(norm, GENERATED_PATTERNS)) return "generated";
  if (
    matchesAnyGlob(norm, TEST_PATTERNS) ||
    (extraTestPatterns.length > 0 && matchesAnyGlob(norm, extraTestPatterns))
  ) {
    return "test";
  }
  if (DOC_EXTENSIONS.has(ext) || norm.toLowerCase().startsWith("docs/")) {
    return "docs";
  }
  if (
    CONFIG_NAMES.has(base) ||
    CONFIG_EXTENSIONS.has(ext) ||
    base.startsWith(".") ||
    norm.toLowerCase().startsWith(".github/")
  ) {
    return "config";
  }
  return "source";
}

/**
 * Check if a file touches a sensitive surface and return the reason if so.
 *
 * @param {string} filePath
 * @param {string[]} [extraSensitivePatterns]
 * @returns {string|null}
 */
export function detectSensitiveReason(filePath, extraSensitivePatterns = []) {
  const norm = normalizePath(filePath);
  const base = path.posix.basename(norm).toLowerCase();

  if (norm.toLowerCase().startsWith(".github/workflows/")) {
    return "CI workflow modified";
  }
  if (base.startsWith(".env")) {
    return "Environment file modified";
  }
  if (base.includes("dockerfile") || base.includes("docker-compose")) {
    return "Container config modified";
  }
  if (norm.toLowerCase().includes("migrations/") || base.endsWith(".sql")) {
    return "Database schema or migration modified";
  }
  if (base === "firestore.rules" || base === "storage.rules") {
    return "Security rules modified";
  }
  if (matchesAnyGlob(norm, SENSITIVE_PATTERNS)) {
    return "Security, auth, or permissions surface modified";
  }
  if (extraSensitivePatterns.length > 0 && matchesAnyGlob(norm, extraSensitivePatterns)) {
    return "Matches project sensitivePatterns rule";
  }
  return null;
}

/**
 * Extract dependency and script changes from a parsed package.json file diff.
 * Uses hunk context and added/removed JSON key lines as a lightweight heuristic.
 *
 * @param {import("./parser.js").ParsedFileDiff} fileDiff
 * @returns {PackageJsonDelta}
 */
export function extractPackageJsonDelta(fileDiff) {
  /** @type {Set<string>} */
  const addedKeys = new Set();
  /** @type {Set<string>} */
  const removedKeys = new Set();
  /** @type {Set<string>} */
  const changedScripts = new Set();

  const depLineRe = /^\s*"([^"]+)"\s*:\s*"([^"]*)"/;
  const sectionRe = /"(dependencies|devDependencies|peerDependencies|optionalDependencies|scripts)"\s*:/;

  for (const hunk of fileDiff.hunks) {
    let section = "";
    const ctxMatch = hunk.headerContext.match(sectionRe);
    if (ctxMatch) section = ctxMatch[1];

    for (const line of hunk.lines) {
      const secMatch = line.text.match(sectionRe);
      if (secMatch) {
        section = secMatch[1];
        continue;
      }
      if (line.text.trim() === "}" || line.text.trim() === "},") {
        section = "";
        continue;
      }
      if (line.type === "ctx") continue;

      const kv = line.text.match(depLineRe);
      if (!kv) continue;
      const key = kv[1];

      if (section === "scripts") {
        changedScripts.add(key);
      } else if (
        section === "dependencies" ||
        section === "devDependencies" ||
        section === "peerDependencies" ||
        section === "optionalDependencies"
      ) {
        if (line.type === "add") addedKeys.add(key);
        if (line.type === "del") removedKeys.add(key);
      }
    }
  }

  /** @type {string[]} */
  const updatedDeps = [];
  /** @type {string[]} */
  const addedDeps = [];
  /** @type {string[]} */
  const removedDeps = [];

  for (const pkg of addedKeys) {
    if (removedKeys.has(pkg)) {
      updatedDeps.push(pkg);
    } else {
      addedDeps.push(pkg);
    }
  }
  for (const pkg of removedKeys) {
    if (!addedKeys.has(pkg)) {
      removedDeps.push(pkg);
    }
  }

  return {
    addedDeps: addedDeps.sort(),
    removedDeps: removedDeps.sort(),
    updatedDeps: updatedDeps.sort(),
    changedScripts: Array.from(changedScripts).sort()
  };
}
