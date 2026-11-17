// @ts-check

export class UsageError extends Error {}

/**
 * @typedef {Object} Options
 * @property {string[]} paths
 * @property {boolean} stdin
 * @property {boolean} exact
 * @property {string} model
 * @property {number | null} top
 * @property {boolean} byDir
 * @property {boolean} json
 * @property {number | null} budget
 * @property {boolean} help
 * @property {boolean} version
 */

export const DEFAULT_MODEL = "claude-haiku-5-5";

/**
 * @param {string} name
 * @param {string | undefined} value
 * @returns {number}
 */
function parseCount(name, value) {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new UsageError(`${name} needs a non-negative whole number, got ${value === undefined ? "nothing" : JSON.stringify(value)}`);
  }
  return Number(value);
}

/**
 * @param {string} name
 * @param {string | undefined} value
 * @returns {string}
 */
function needValue(name, value) {
  if (value === undefined || value === "") throw new UsageError(`${name} needs a value`);
  return value;
}

/**
 * Parse argv (without node and script) into options.
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const o = {
    paths: [], stdin: false, exact: false, model: DEFAULT_MODEL, top: null,
    byDir: false, json: false, budget: null, help: false, version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let flag = arg;
    /** @type {string | undefined} */
    let inline;
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      flag = arg.slice(0, eq);
      inline = arg.slice(eq + 1);
    }
    /** @returns {string | undefined} */
    const next = () => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case "-h": case "--help": o.help = true; break;
      case "-v": case "--version": o.version = true; break;
      case "--exact": o.exact = true; break;
      case "--by-dir": o.byDir = true; break;
      case "--json": o.json = true; break;
      case "--model": o.model = needValue("--model", next()); break;
      case "--top": o.top = parseCount("--top", next()); break;
      case "--budget": o.budget = parseCount("--budget", next()); break;
      case "-": o.stdin = true; break;
      case "--": o.paths.push(...argv.slice(i + 1)); i = argv.length; break;
      default:
        if (arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
        o.paths.push(arg);
    }
  }
  if (o.top === 0) throw new UsageError("--top must be at least 1");
  return o;
}

export const HELP = `token-count: estimate the token cost of files or folders

Usage:
  token-count [paths...] [options]
  cat file.txt | token-count -

Options:
  --exact          Count with the Anthropic token counting API (needs ANTHROPIC_API_KEY)
  --model <id>     Model used by --exact (default ${DEFAULT_MODEL})
  --top <n>        Show only the n largest rows
  --by-dir         Aggregate by top-level directory
  --json           Print machine-readable JSON
  --budget <n>     Exit 1 when the total is over n tokens
  -                Read text from stdin
  -h, --help       Show this help
  -v, --version    Show the version

Without --exact the result is an estimate: ceil(characters / 4).

Environment:
  ANTHROPIC_API_KEY    API key for --exact
  ANTHROPIC_BASE_URL   API base URL (default https://api.anthropic.com)

Exit codes: 0 ok, 1 over budget or API error, 2 usage error
`;
