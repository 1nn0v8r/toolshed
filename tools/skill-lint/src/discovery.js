// @ts-check
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * @typedef {{
 *   budget: number | null,
 *   maxBodyLines: number,
 *   maxBodyTokens: number,
 *   maxDescriptionChars: number,
 *   ignoreRules: string[],
 *   allowedFrontmatterKeys: string[],
 *   strict: boolean,
 * }} LintOptions
 */

/** @type {LintOptions} */
export const DEFAULT_OPTIONS = {
  budget: null,
  maxBodyLines: 500,
  maxBodyTokens: 4000,
  maxDescriptionChars: 300,
  ignoreRules: [],
  allowedFrontmatterKeys: [],
  strict: false,
};

export const STANDARD_SKILL_ROOTS = [
  ".agents/skills",
  ".claude/skills",
  ".cursor/skills",
  ".codex/skills",
  ".gemini/skills",
  ".github/skills",
  "skills",
];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
]);

export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Load `.skill-lint.json` or `"skill-lint"` from `package.json` in `dir`.
 * @param {string} dir
 * @returns {Partial<LintOptions>}
 */
export function loadSkillLintRc(dir) {
  const rcPath = path.join(dir, ".skill-lint.json");
  if (existsSync(rcPath)) {
    const raw = readJsonFile(rcPath, ".skill-lint.json");
    return validateRc(raw, ".skill-lint.json");
  }
  const pkgPath = path.join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg && typeof pkg === "object" && pkg["skill-lint"] && typeof pkg["skill-lint"] === "object") {
        return validateRc(pkg["skill-lint"], "package.json#skill-lint");
      }
    } catch {
      // Ignore unrelated malformed package.json
    }
  }
  return {};
}

/**
 * @param {string} filePath
 * @param {string} label
 * @returns {unknown}
 */
function readJsonFile(filePath, label) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new UsageError(`Could not read ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`Invalid JSON in ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * @param {unknown} raw
 * @param {string} source
 * @returns {Partial<LintOptions>}
 */
function validateRc(raw, source) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError(`Invalid config in ${source}: expected a JSON object`);
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);
  /** @type {Partial<LintOptions>} */
  const out = {};

  for (const key of /** @type {const} */ (["budget", "maxBodyLines", "maxBodyTokens", "maxDescriptionChars"])) {
    if (obj[key] !== undefined && obj[key] !== null) {
      if (typeof obj[key] !== "number" || !Number.isFinite(obj[key]) || obj[key] < 0) {
        throw new UsageError(`Invalid "${key}" in ${source}: expected a non-negative number`);
      }
      out[key] = obj[key];
    }
  }
  for (const key of /** @type {const} */ (["ignoreRules", "allowedFrontmatterKeys"])) {
    if (obj[key] !== undefined) {
      if (!Array.isArray(obj[key]) || obj[key].some((x) => typeof x !== "string")) {
        throw new UsageError(`Invalid "${key}" in ${source}: expected string[]`);
      }
      out[key] = obj[key];
    }
  }
  if (obj.strict !== undefined) {
    if (typeof obj.strict !== "boolean") {
      throw new UsageError(`Invalid "strict" in ${source}: expected boolean`);
    }
    out.strict = obj.strict;
  }
  return out;
}

/**
 * Discover SKILL.md files from explicit targets or standard skill directories under cwd.
 * @param {string[]} targets
 * @param {string} cwd
 * @returns {string[]}
 */
export function discoverSkillFiles(targets, cwd) {
  /** @type {string[]} */
  const found = [];
  /** @type {Set<string>} */
  const seen = new Set();

  /** @param {string} filePath */
  const addFile = (filePath) => {
    let key = path.resolve(filePath);
    try {
      key = realpathSync(key);
    } catch {
      // keep resolved path
    }
    if (!seen.has(key)) {
      seen.add(key);
      found.push(path.resolve(filePath));
    }
  };

  /** @param {string} dir @param {number} depth */
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === "SKILL.md") {
        addFile(full);
      } else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        walk(full, depth + 1);
      }
    }
  };

  if (targets.length === 0) {
    const rootSkill = path.join(cwd, "SKILL.md");
    if (existsSync(rootSkill)) {
      addFile(rootSkill);
    }
    for (const rel of STANDARD_SKILL_ROOTS) {
      const dir = path.join(cwd, rel);
      if (existsSync(dir) && statSync(dir).isDirectory()) {
        walk(dir, 0);
      }
    }
    return found;
  }

  for (const target of targets) {
    const resolved = path.resolve(cwd, target);
    if (!existsSync(resolved)) {
      throw new UsageError(`Path not found: ${target}`);
    }
    const st = statSync(resolved);
    if (st.isFile()) {
      addFile(resolved);
    } else if (st.isDirectory()) {
      walk(resolved, 0);
    }
  }
  return found;
}
