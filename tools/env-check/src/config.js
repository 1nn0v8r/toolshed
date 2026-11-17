// @ts-check
import fs from "node:fs";
import path from "node:path";

export const CONFIG_NAME = ".env-check.json";

/** Thrown for bad arguments or configuration. The CLI maps it to exit code 2. */
export class UsageError extends Error {}

/**
 * @typedef {{ example?: string, ignore?: string[], paths?: string[] }} Config
 */

/**
 * Load `.env-check.json` from `dir`. Returns an empty config when the file does not exist.
 * @param {string} dir
 * @returns {Config}
 */
export function loadConfig(dir) {
  const file = path.join(dir, CONFIG_NAME);
  /** @type {string} */
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return {};
    throw new UsageError(`cannot read ${CONFIG_NAME}`);
  }
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    throw new UsageError(`${CONFIG_NAME} is not valid JSON`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new UsageError(`${CONFIG_NAME} must contain a JSON object`);
  }
  const obj = /** @type {Record<string, unknown>} */ (data);
  /** @type {Config} */
  const config = {};
  if (obj.example !== undefined) {
    if (typeof obj.example !== "string" || !obj.example) {
      throw new UsageError(`${CONFIG_NAME}: "example" must be a non-empty string`);
    }
    config.example = obj.example;
  }
  for (const key of /** @type {const} */ (["ignore", "paths"])) {
    const v = obj[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      throw new UsageError(`${CONFIG_NAME}: "${key}" must be an array of strings`);
    }
    config[key] = /** @type {string[]} */ (v);
  }
  return config;
}
