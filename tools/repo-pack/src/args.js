// @ts-check

export class UsageError extends Error {}

/**
 * @typedef {object} Options
 * @property {string[]} paths
 * @property {string[]} include
 * @property {string[]} exclude
 * @property {number} maxFileSize bytes
 * @property {number | null} maxTokens
 * @property {"priority" | "path"} order
 * @property {"md" | "xml"} format
 * @property {string | null} out
 * @property {boolean} lineNumbers
 * @property {boolean} allowEnv
 * @property {boolean} defaultExcludes
 * @property {boolean} help
 * @property {boolean} version
 */

export const DEFAULT_MAX_FILE_SIZE = 256 * 1024;

const VALUE_OPTIONS = new Set([
  "include",
  "exclude",
  "max-file-size",
  "max-tokens",
  "order",
  "format",
  "out",
]);

/**
 * Parse a size such as 4096, 256k, 1.5m (powers of 1024).
 * @param {string} text
 * @returns {number}
 */
export function parseSize(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb)?$/i.exec(text.trim());
  if (!m) throw new UsageError(`invalid size "${text}" (examples: 4096, 256k, 1m)`);
  const unit = (m[2] || "b").toLowerCase();
  const mult = unit.startsWith("m") ? 1024 * 1024 : unit.startsWith("k") ? 1024 : 1;
  const n = Math.floor(Number(m[1]) * mult);
  if (!(n > 0)) throw new UsageError(`size must be greater than zero, got "${text}"`);
  return n;
}

/**
 * @param {string} name
 * @param {string} text
 * @returns {number}
 */
function parsePositiveInt(name, text) {
  if (!/^\d+$/.test(text.trim())) {
    throw new UsageError(`--${name} needs a positive whole number, got "${text}"`);
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new UsageError(`--${name} needs a positive whole number, got "${text}"`);
  }
  return n;
}

/**
 * @param {string[]} argv arguments after the script name
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const o = {
    paths: [],
    include: [],
    exclude: [],
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
    maxTokens: null,
    order: "priority",
    format: "md",
    out: null,
    lineNumbers: false,
    allowEnv: false,
    defaultExcludes: true,
    help: false,
    version: false,
  };
  let onlyPositional = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (onlyPositional || arg === "-" || !arg.startsWith("-")) {
      o.paths.push(arg);
      continue;
    }
    if (arg === "--") {
      onlyPositional = true;
      continue;
    }
    if (arg === "-h") {
      o.help = true;
      continue;
    }
    if (arg === "-v") {
      o.version = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new UsageError(`unknown option ${arg}`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    /** @type {string | undefined} */
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (VALUE_OPTIONS.has(name)) {
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new UsageError(`--${name} needs a value`);
        }
        value = next;
        i++;
      }
      if (value === "") throw new UsageError(`--${name} needs a non-empty value`);
      switch (name) {
        case "include":
          o.include.push(value);
          break;
        case "exclude":
          o.exclude.push(value);
          break;
        case "max-file-size":
          o.maxFileSize = parseSize(value);
          break;
        case "max-tokens":
          o.maxTokens = parsePositiveInt(name, value);
          break;
        case "order":
          if (value !== "priority" && value !== "path") {
            throw new UsageError(`--order must be "priority" or "path", got "${value}"`);
          }
          o.order = value;
          break;
        case "format":
          if (value !== "md" && value !== "xml") {
            throw new UsageError(`--format must be "md" or "xml", got "${value}"`);
          }
          o.format = value;
          break;
        case "out":
          o.out = value;
          break;
      }
      continue;
    }
    if (value !== undefined) throw new UsageError(`--${name} does not take a value`);
    switch (name) {
      case "help":
        o.help = true;
        break;
      case "version":
        o.version = true;
        break;
      case "line-numbers":
        o.lineNumbers = true;
        break;
      case "allow-env":
        o.allowEnv = true;
        break;
      case "no-default-excludes":
        o.defaultExcludes = false;
        break;
      default:
        throw new UsageError(`unknown option --${name}`);
    }
  }
  return o;
}
