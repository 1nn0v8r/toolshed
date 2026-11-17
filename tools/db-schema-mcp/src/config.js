// @ts-check
// Environment parsing. Error messages never include the connection URL.

export const DEFAULT_MAX_ROWS = 50;
export const HARD_MAX_ROWS = 500;
export const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 600000;

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * @typedef {{ kind: "postgres" | "mysql", url: string, schema: string, maxRows: number, timeoutMs: number }} Config
 */

/**
 * @param {string | undefined} raw
 * @param {string} name
 * @param {number} def
 * @param {number} min
 * @param {number} max
 */
function intVar(raw, name, def, min, max) {
  if (raw === undefined || raw.trim() === "") return def;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min) throw new ConfigError(`${name} must be an integer >= ${min}`);
  return Math.min(v, max);
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Config}
 */
export function parseConfig(env) {
  const url = (env.DATABASE_URL ?? "").trim();
  if (!url) throw new ConfigError("DATABASE_URL is not set (use a postgres://, postgresql:// or mysql:// URL)");
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (!scheme) throw new ConfigError("DATABASE_URL is not a valid URL (expected postgres://, postgresql:// or mysql://)");
  const proto = scheme[1].toLowerCase();
  /** @type {"postgres" | "mysql"} */
  let kind;
  if (proto === "postgres" || proto === "postgresql") kind = "postgres";
  else if (proto === "mysql") kind = "mysql";
  else throw new ConfigError(`unsupported DATABASE_URL scheme "${proto}" (use postgres://, postgresql:// or mysql://)`);
  return {
    kind,
    url,
    schema: (env.DB_SCHEMA ?? "").trim() || "public",
    maxRows: intVar(env.DB_MAX_ROWS, "DB_MAX_ROWS", DEFAULT_MAX_ROWS, 1, HARD_MAX_ROWS),
    timeoutMs: intVar(env.DB_STATEMENT_TIMEOUT_MS, "DB_STATEMENT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS),
  };
}
