// @ts-check
import fs from "node:fs";
import path from "node:path";
import { RULE_IDS } from "./rules.js";

export const CONFIG_FILENAME = ".prompt-shield.json";

/**
 * @typedef {{
 *   ignoreRules: Set<string>,
 *   ignoreFiles: string[],
 *   maxFileSizeKB: number,
 *   strict: boolean,
 *   strictUnicode: boolean,
 * }} ShieldConfig
 */

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

export const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "target",
  "vendor",
]);

/**
 * Simple glob matcher supporting *, **, and ?.
 * @param {string} pattern
 * @returns {(relPath: string) => boolean}
 */
export function makeGlobMatcher(pattern) {
  const norm = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let re = "^";
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === "*") {
      if (norm[i + 1] === "*") {
        if (norm[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if ("\\^$.|+()[]{}".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
    i += 1;
  }
  re += "$";
  const regex = new RegExp(re);
  return (relPath) => regex.test(relPath.replace(/\\/g, "/"));
}

/**
 * Load optional .prompt-shield.json config from `configPath` or `rootDir`.
 * @param {string} rootDir
 * @param {string | null} [explicitPath]
 * @returns {ShieldConfig}
 */
export function loadConfig(rootDir, explicitPath = null) {
  /** @type {ShieldConfig} */
  const cfg = {
    ignoreRules: new Set(),
    ignoreFiles: [],
    maxFileSizeKB: 1024,
    strict: false,
    strictUnicode: false,
  };

  const target = explicitPath ? path.resolve(rootDir, explicitPath) : path.join(rootDir, CONFIG_FILENAME);
  if (!fs.existsSync(target)) {
    if (explicitPath) {
      throw new ConfigError(`Config file not found: ${target}`);
    }
    return cfg;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${target}: ${/** @type {Error} */ (err).message}`);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`Config in ${target} must be a JSON object`);
  }

  if (raw.ignoreRules !== undefined) {
    if (!Array.isArray(raw.ignoreRules)) {
      throw new ConfigError(`"ignoreRules" in ${target} must be an array of rule IDs`);
    }
    for (const id of raw.ignoreRules) {
      if (typeof id !== "string" || !RULE_IDS.includes(id)) {
        throw new ConfigError(`Unknown rule ID in ignoreRules: "${String(id)}"`);
      }
      cfg.ignoreRules.add(id);
    }
  }

  if (raw.ignoreFiles !== undefined) {
    if (
      !Array.isArray(raw.ignoreFiles) ||
      !raw.ignoreFiles.every((/** @type {unknown} */ s) => typeof s === "string")
    ) {
      throw new ConfigError(`"ignoreFiles" in ${target} must be an array of glob strings`);
    }
    cfg.ignoreFiles = raw.ignoreFiles;
  }

  if (raw.maxFileSizeKB !== undefined) {
    if (typeof raw.maxFileSizeKB !== "number" || !Number.isFinite(raw.maxFileSizeKB) || raw.maxFileSizeKB <= 0) {
      throw new ConfigError(`"maxFileSizeKB" in ${target} must be a positive number`);
    }
    cfg.maxFileSizeKB = raw.maxFileSizeKB;
  }

  if (typeof raw.strict === "boolean") cfg.strict = raw.strict;
  if (typeof raw.strictUnicode === "boolean") cfg.strictUnicode = raw.strictUnicode;

  return cfg;
}
