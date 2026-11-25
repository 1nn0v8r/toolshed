// @ts-check
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {object} DiffBriefConfig
 * @property {string[]} ignore
 * @property {string[]} ignoreFlags
 * @property {string[]} sensitivePatterns
 * @property {string[]} testPatterns
 * @property {number} maxTokens
 * @property {boolean} requireTests
 * @property {number} unpairedSourceMinLines
 * @property {number} largeDeletionThreshold
 * @property {string|null} failOn
 * @property {string[]} failOnFlags
 */

/** @type {DiffBriefConfig} */
export const DEFAULT_CONFIG = {
  ignore: [],
  ignoreFlags: [],
  sensitivePatterns: [],
  testPatterns: [],
  maxTokens: 1800,
  requireTests: true,
  unpairedSourceMinLines: 15,
  largeDeletionThreshold: 80,
  failOn: null,
  failOnFlags: []
};

/**
 * Normalize a path to POSIX forward slashes for cross-platform glob matching.
 *
 * @param {string} p
 * @returns {string}
 */
export function normalizePath(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Convert a simple glob pattern (*, **, ?) into a RegExp.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
  const norm = normalizePath(pattern.trim());
  let regex = "^";
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === "*") {
      if (norm[i + 1] === "*") {
        if (norm[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        regex += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i += 1;
    } else if ("\\.^$+()[]{}|".includes(ch)) {
      regex += `\\${ch}`;
      i += 1;
    } else {
      regex += ch;
      i += 1;
    }
  }
  regex += "$";
  return new RegExp(regex, "i");
}

/**
 * Return true if filePath matches any glob pattern in patterns.
 *
 * @param {string} filePath
 * @param {string[]} patterns
 * @returns {boolean}
 */
export function matchesAnyGlob(filePath, patterns) {
  if (!patterns || patterns.length === 0) return false;
  const norm = normalizePath(filePath);
  for (const pat of patterns) {
    if (!pat) continue;
    if (globToRegExp(pat).test(norm)) return true;
  }
  return false;
}

/**
 * Safely coerce a value into a string array.
 *
 * @param {unknown} val
 * @param {string} field
 * @returns {string[]}
 */
function asStringArray(val, field) {
  if (val === undefined) return [];
  if (!Array.isArray(val) || val.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid config field "${field}": expected an array of strings.`);
  }
  return val;
}

/**
 * Load configuration from .diffbriefrc.json or package.json "diff-brief" key.
 *
 * @param {string} rootDir
 * @returns {DiffBriefConfig}
 */
export function loadConfig(rootDir) {
  /** @type {Record<string, unknown>} */
  let raw = {};

  const rcPath = path.join(rootDir, ".diffbriefrc.json");
  if (fs.existsSync(rcPath)) {
    const parsed = JSON.parse(fs.readFileSync(rcPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid config in ${rcPath}: expected a JSON object.`);
    }
    raw = parsed;
  } else {
    const pkgPath = path.join(rootDir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg && typeof pkg === "object" && pkg["diff-brief"] !== undefined) {
        const block = pkg["diff-brief"];
        if (!block || typeof block !== "object" || Array.isArray(block)) {
          throw new Error(`Invalid "diff-brief" config in ${pkgPath}: expected an object.`);
        }
        raw = block;
      }
    }
  }

  const maxTokens =
    raw.maxTokens !== undefined
      ? Number(raw.maxTokens)
      : DEFAULT_CONFIG.maxTokens;
  if (!Number.isFinite(maxTokens) || maxTokens < 0) {
    throw new Error(`Invalid config field "maxTokens": expected a non-negative number.`);
  }

  const unpairedSourceMinLines =
    raw.unpairedSourceMinLines !== undefined
      ? Number(raw.unpairedSourceMinLines)
      : DEFAULT_CONFIG.unpairedSourceMinLines;
  if (!Number.isFinite(unpairedSourceMinLines) || unpairedSourceMinLines < 1) {
    throw new Error(`Invalid config field "unpairedSourceMinLines": expected a positive number.`);
  }

  const largeDeletionThreshold =
    raw.largeDeletionThreshold !== undefined
      ? Number(raw.largeDeletionThreshold)
      : DEFAULT_CONFIG.largeDeletionThreshold;
  if (!Number.isFinite(largeDeletionThreshold) || largeDeletionThreshold < 1) {
    throw new Error(`Invalid config field "largeDeletionThreshold": expected a positive number.`);
  }

  let failOn = DEFAULT_CONFIG.failOn;
  if (raw.failOn !== undefined && raw.failOn !== null) {
    if (typeof raw.failOn !== "string" || !["low", "medium", "high"].includes(raw.failOn)) {
      throw new Error(`Invalid config field "failOn": expected "low", "medium", or "high".`);
    }
    failOn = raw.failOn;
  }

  return {
    ignore: asStringArray(raw.ignore, "ignore"),
    ignoreFlags: asStringArray(raw.ignoreFlags, "ignoreFlags"),
    sensitivePatterns: asStringArray(raw.sensitivePatterns, "sensitivePatterns"),
    testPatterns: asStringArray(raw.testPatterns, "testPatterns"),
    maxTokens,
    requireTests:
      raw.requireTests !== undefined ? Boolean(raw.requireTests) : DEFAULT_CONFIG.requireTests,
    unpairedSourceMinLines,
    largeDeletionThreshold,
    failOn,
    failOnFlags: asStringArray(raw.failOnFlags, "failOnFlags")
  };
}
