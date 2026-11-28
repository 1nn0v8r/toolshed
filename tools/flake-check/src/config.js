// @ts-check
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {{
 *   ignoreRules: string[],
 *   ignoreFiles: string[],
 *   maxFileSizeKB: number,
 *   strict: boolean,
 *   runs: number,
 *   jobs: number,
 *   timeoutMs: number,
 * }} FlakeCheckConfig
 */

/** @type {FlakeCheckConfig} */
export const DEFAULT_CONFIG = {
  ignoreRules: [],
  ignoreFiles: [],
  maxFileSizeKB: 1024,
  strict: false,
  runs: 5,
  jobs: 1,
  timeoutMs: 60000,
};

export const STARTER_CONFIG = JSON.stringify(
  {
    ignoreRules: [],
    ignoreFiles: ["test/fixtures/**"],
    maxFileSizeKB: 1024,
    strict: false,
    runs: 5,
    jobs: 1,
    timeoutMs: 60000,
  },
  null,
  2,
) + "\n";

/**
 * Load `.flake-check.json` from `cwd` or an explicit `configPath`.
 * @param {string} cwd
 * @param {string | undefined} configPath
 * @returns {{ config: FlakeCheckConfig, configFile: string | null }}
 */
export function loadConfig(cwd, configPath) {
  const resolved = configPath
    ? path.resolve(cwd, configPath)
    : path.join(cwd, ".flake-check.json");

  if (!fs.existsSync(resolved)) {
    if (configPath) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    return { config: { ...DEFAULT_CONFIG }, configFile: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config in ${resolved} must be a JSON object.`);
  }

  /** @type {FlakeCheckConfig} */
  const config = {
    ignoreRules: Array.isArray(parsed.ignoreRules)
      ? parsed.ignoreRules.filter((/** @type {unknown} */ x) => typeof x === "string")
      : [...DEFAULT_CONFIG.ignoreRules],
    ignoreFiles: Array.isArray(parsed.ignoreFiles)
      ? parsed.ignoreFiles.filter((/** @type {unknown} */ x) => typeof x === "string")
      : [...DEFAULT_CONFIG.ignoreFiles],
    maxFileSizeKB:
      typeof parsed.maxFileSizeKB === "number" && parsed.maxFileSizeKB > 0
        ? parsed.maxFileSizeKB
        : DEFAULT_CONFIG.maxFileSizeKB,
    strict: typeof parsed.strict === "boolean" ? parsed.strict : DEFAULT_CONFIG.strict,
    runs:
      typeof parsed.runs === "number" && Number.isInteger(parsed.runs) && parsed.runs >= 1
        ? parsed.runs
        : DEFAULT_CONFIG.runs,
    jobs:
      typeof parsed.jobs === "number" && Number.isInteger(parsed.jobs) && parsed.jobs >= 1
        ? parsed.jobs
        : DEFAULT_CONFIG.jobs,
    timeoutMs:
      typeof parsed.timeoutMs === "number" && parsed.timeoutMs >= 100
        ? parsed.timeoutMs
        : DEFAULT_CONFIG.timeoutMs,
  };

  return { config, configFile: resolved };
}
