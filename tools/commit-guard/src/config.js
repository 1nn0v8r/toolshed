// @ts-check
import fs from "node:fs";
import path from "node:path";
import { RULES, RULE_IDS } from "./rules.js";

export const CONFIG_NAME = ".commit-guard.json";
export const DEFAULT_MAX_KB = 1024;

export class ConfigError extends Error {}

/**
 * @typedef {{
 *   rules: Record<string, 'off' | 'warn' | 'error'>,
 *   allow: string[],
 *   ignoreFiles: string[],
 *   maxFileSizeKB: number,
 * }} Config
 */

/** @returns {Config} */
export function defaultConfig() {
  return { rules: {}, allow: [], ignoreFiles: [], maxFileSizeKB: DEFAULT_MAX_KB };
}

/**
 * Validate parsed JSON. Throws ConfigError with a readable message.
 * @param {unknown} raw
 * @returns {Config}
 */
export function validateConfig(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("config must be a JSON object");
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const known = new Set(["rules", "allow", "ignoreFiles", "maxFileSizeKB"]);
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) throw new ConfigError(`unknown config key "${k}"`);
  }
  const cfg = defaultConfig();
  if (obj.rules !== undefined) {
    const r = obj.rules;
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      throw new ConfigError('"rules" must be an object');
    }
    for (const [id, level] of Object.entries(r)) {
      if (!RULE_IDS.includes(id)) throw new ConfigError(`unknown rule id "${id}"`);
      if (level !== "off" && level !== "warn" && level !== "error") {
        throw new ConfigError(`rule "${id}" must be "off", "warn" or "error"`);
      }
      cfg.rules[id] = level;
    }
  }
  for (const key of /** @type {const} */ (["allow", "ignoreFiles"])) {
    const v = obj[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      throw new ConfigError(`"${key}" must be an array of strings`);
    }
    cfg[key] = /** @type {string[]} */ (v);
  }
  for (const p of cfg.allow) {
    try {
      new RegExp(p);
    } catch {
      throw new ConfigError(`invalid regex in "allow": ${p}`);
    }
  }
  if (obj.maxFileSizeKB !== undefined) {
    const n = obj.maxFileSizeKB;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
      throw new ConfigError('"maxFileSizeKB" must be a positive number');
    }
    cfg.maxFileSizeKB = n;
  }
  return cfg;
}

/**
 * Load .commit-guard.json from root. Missing file gives defaults.
 * @param {string} root
 * @returns {Config}
 */
export function loadConfig(root) {
  const file = path.join(root, CONFIG_NAME);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return defaultConfig();
    throw new ConfigError(`cannot read ${CONFIG_NAME}: ${/** @type {Error} */ (e).message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    throw new ConfigError(`${CONFIG_NAME} is not valid JSON: ${/** @type {Error} */ (e).message}`);
  }
  try {
    return validateConfig(raw);
  } catch (e) {
    throw new ConfigError(`${CONFIG_NAME}: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * Apply config to the rule table.
 * @param {Config} cfg
 * @returns {import('./rules.js').Rule[]}
 */
export function resolveRules(cfg) {
  return RULES.map((r) => {
    const level = cfg.rules[r.id];
    if (level === undefined) return { ...r };
    if (level === "off") return { ...r, enabled: false };
    return { ...r, enabled: true, severity: level };
  });
}
