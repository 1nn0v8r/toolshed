// @ts-check
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {Object} PackageJsonData
 * @property {string} [name]
 * @property {Record<string, string>} [dependencies]
 * @property {Record<string, string>} [devDependencies]
 * @property {Record<string, string>} [peerDependencies]
 * @property {Record<string, string>} [optionalDependencies]
 * @property {Object} [dep-check]
 */

/**
 * @typedef {Object} DepCheckConfig
 * @property {string[]} [ignore]
 * @property {boolean} [ignoreDev]
 * @property {boolean} [failOnUnused]
 * @property {boolean} [failOnMissing]
 * @property {boolean} [failOnMisplaced]
 * @property {string[]} [paths]
 */

/**
 * Loads and parses package.json from the specified path.
 *
 * @param {string} pkgPath
 * @returns {PackageJsonData}
 */
export function loadPackageJson(pkgPath) {
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`package.json not found at: ${pkgPath}`);
  }

  let raw;
  try {
    raw = fs.readFileSync(pkgPath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read package.json at ${pkgPath}: ${msg}`);
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in package.json at ${pkgPath}: ${msg}`);
  }
}

/**
 * Loads optional configuration from `.depcheckrc.json` or `package.json`.
 *
 * @param {string} projectDir
 * @param {PackageJsonData} pkgData
 * @returns {DepCheckConfig}
 */
export function loadConfig(projectDir, pkgData) {
  const rcPath = path.join(projectDir, ".depcheckrc.json");
  /** @type {Record<string, any>} */
  let fileConfig = {};

  if (fs.existsSync(rcPath)) {
    try {
      const raw = fs.readFileSync(rcPath, "utf8");
      fileConfig = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid JSON in .depcheckrc.json: ${msg}`);
    }
  } else if (pkgData["dep-check"] && typeof pkgData["dep-check"] === "object") {
    fileConfig = pkgData["dep-check"];
  }

  return {
    ignore: Array.isArray(fileConfig.ignore) ? fileConfig.ignore : [],
    ignoreDev: Boolean(fileConfig.ignoreDev),
    failOnUnused: Boolean(fileConfig.failOnUnused),
    failOnMissing: fileConfig.failOnMissing !== undefined ? Boolean(fileConfig.failOnMissing) : true,
    failOnMisplaced: Boolean(fileConfig.failOnMisplaced),
    paths: Array.isArray(fileConfig.paths) ? fileConfig.paths : []
  };
}
