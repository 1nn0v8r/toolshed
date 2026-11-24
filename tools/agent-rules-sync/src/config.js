// @ts-check
import fs from "node:fs";
import path from "node:path";
import { resolveTargetPath, toPosix } from "./registry.js";

export const CONFIG_FILENAME = ".agent-rules.json";
export const DEFAULT_SOURCE = "AGENTS.md";

/**
 * @typedef {"copy" | "pointer"} SyncMode
 */

/**
 * @typedef {object} TargetConfig
 * @property {string} path
 * @property {SyncMode} [mode]
 * @property {string} [description]
 * @property {string} [globs]
 * @property {boolean} [alwaysApply]
 */

/**
 * @typedef {object} AgentRulesConfig
 * @property {string} source
 * @property {SyncMode} mode
 * @property {TargetConfig[]} targets
 * @property {number | null} maxTokens
 * @property {boolean} checkLinks
 * @property {boolean} checkContradictions
 * @property {boolean} strict
 * @property {string | null} configFile
 */

/**
 * Ensure a relative path resolves strictly inside rootDir (no traversal).
 * @param {string} rootDir
 * @param {string} relPath
 * @returns {string}
 */
export function safeResolveInside(rootDir, relPath) {
  if (!relPath || path.isAbsolute(relPath)) {
    throw new Error(`Path must be relative to the project root: "${relPath}"`);
  }
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, relPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes project root: "${relPath}"`);
  }
  return resolvedTarget;
}

/**
 * Validate sync mode string.
 * @param {unknown} value
 * @returns {SyncMode}
 */
function parseMode(value) {
  if (value === "copy" || value === "pointer") {
    return value;
  }
  throw new Error(`Invalid sync mode "${String(value)}". Expected "copy" or "pointer".`);
}

/**
 * Normalize a raw target entry from config or CLI.
 * @param {unknown} entry
 * @param {string} rootDir
 * @returns {TargetConfig}
 */
function normalizeTarget(entry, rootDir) {
  if (typeof entry === "string") {
    const targetPath = resolveTargetPath(entry);
    safeResolveInside(rootDir, targetPath);
    return { path: targetPath };
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const obj = /** @type {Record<string, unknown>} */ (entry);
    if (typeof obj.path !== "string" || !obj.path.trim()) {
      throw new Error("Each target object in .agent-rules.json must have a non-empty \"path\".");
    }
    const targetPath = resolveTargetPath(obj.path);
    safeResolveInside(rootDir, targetPath);
    /** @type {TargetConfig} */
    const out = { path: targetPath };
    if (obj.mode !== undefined) {
      out.mode = parseMode(obj.mode);
    }
    if (typeof obj.description === "string") {
      out.description = obj.description;
    }
    if (typeof obj.globs === "string") {
      out.globs = obj.globs;
    }
    if (typeof obj.alwaysApply === "boolean") {
      out.alwaysApply = obj.alwaysApply;
    }
    return out;
  }
  throw new Error("Invalid target entry in .agent-rules.json; expected a string or object.");
}

/**
 * Load and validate `.agent-rules.json` if present, returning normalized config.
 * @param {string} rootDir
 * @returns {AgentRulesConfig}
 */
export function loadConfig(rootDir) {
  const configPath = path.join(rootDir, CONFIG_FILENAME);
  /** @type {AgentRulesConfig} */
  const defaults = {
    source: DEFAULT_SOURCE,
    mode: "copy",
    targets: [],
    maxTokens: null,
    checkLinks: true,
    checkContradictions: true,
    strict: false,
    configFile: null,
  };

  if (!fs.existsSync(configPath)) {
    return defaults;
  }

  let rawText;
  try {
    rawText = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(`Failed to read ${CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`);
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Invalid JSON in ${CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILENAME} must contain a JSON object.`);
  }

  const obj = /** @type {Record<string, unknown>} */ (parsed);

  const source = obj.source !== undefined
    ? (() => {
        if (typeof obj.source !== "string" || !obj.source.trim()) {
          throw new Error(`${CONFIG_FILENAME}: "source" must be a non-empty string.`);
        }
        const norm = toPosix(obj.source.trim());
        safeResolveInside(rootDir, norm);
        return norm;
      })()
    : DEFAULT_SOURCE;

  const mode = obj.mode !== undefined ? parseMode(obj.mode) : "copy";

  /** @type {TargetConfig[]} */
  const targets = [];
  if (obj.targets !== undefined) {
    if (!Array.isArray(obj.targets)) {
      throw new Error(`${CONFIG_FILENAME}: "targets" must be an array.`);
    }
    const seen = new Set();
    for (const item of obj.targets) {
      const normalized = normalizeTarget(item, rootDir);
      if (normalized.path === source) {
        throw new Error(`${CONFIG_FILENAME}: target "${normalized.path}" cannot be the same as source "${source}".`);
      }
      if (!seen.has(normalized.path)) {
        seen.add(normalized.path);
        targets.push(normalized);
      }
    }
  }

  let maxTokens = null;
  if (obj.maxTokens !== undefined && obj.maxTokens !== null) {
    if (typeof obj.maxTokens !== "number" || !Number.isFinite(obj.maxTokens) || obj.maxTokens <= 0) {
      throw new Error(`${CONFIG_FILENAME}: "maxTokens" must be a positive number.`);
    }
    maxTokens = Math.floor(obj.maxTokens);
  }

  const checkLinks = obj.checkLinks !== undefined
    ? Boolean(obj.checkLinks)
    : true;
  const checkContradictions = obj.checkContradictions !== undefined
    ? Boolean(obj.checkContradictions)
    : true;
  const strict = obj.strict !== undefined
    ? Boolean(obj.strict)
    : false;

  return {
    source,
    mode,
    targets,
    maxTokens,
    checkLinks,
    checkContradictions,
    strict,
    configFile: CONFIG_FILENAME,
  };
}
