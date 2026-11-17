// @ts-check

export const CLI_VERSION = "0.1.0";

/**
 * @typedef {{
 *   tagPrefix: string, from: string | null, to: string | null, path: string | null,
 *   scope: string | null, includeMerges: boolean, all: boolean, versionLabel: string,
 *   date: string | null, hash: boolean, write: string | null, json: boolean,
 *   help: boolean, cliVersion: boolean
 * }} Options
 */

/** Options that take a value. */
const VALUE_FLAGS = {
  "--tag-prefix": "tagPrefix",
  "--from": "from",
  "--to": "to",
  "--path": "path",
  "--scope": "scope",
  "--version-label": "versionLabel",
  "--date": "date",
  "--write": "write",
};

/** Boolean flags. */
/** @type {Record<string, [string, boolean]>} */
const BOOL_FLAGS = {
  "--include-merges": ["includeMerges", true],
  "--all": ["all", true],
  "--no-hash": ["hash", false],
  "--json": ["json", true],
  "--help": ["help", true],
  "-h": ["help", true],
  "--cli-version": ["cliVersion", true],
  "-V": ["cliVersion", true],
};

/**
 * Error for bad command line usage (exit code 2).
 */
export class UsageError extends Error {}

/**
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const o = {
    tagPrefix: "v",
    from: null,
    to: null,
    path: null,
    scope: null,
    includeMerges: false,
    all: false,
    versionLabel: "Unreleased",
    date: null,
    hash: true,
    write: null,
    json: false,
    help: false,
    cliVersion: false,
  };
  /** @type {Record<string, any>} */
  const bag = o;

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline = null;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (eq !== -1) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (Object.hasOwn(VALUE_FLAGS, arg)) {
      const key = VALUE_FLAGS[/** @type {keyof typeof VALUE_FLAGS} */ (arg)];
      let value = inline;
      if (value === null) {
        value = argv[++i];
        if (value === undefined) throw new UsageError(`option ${arg} needs a value`);
      }
      if (value === "" && key !== "tagPrefix") throw new UsageError(`option ${arg} needs a non-empty value`);
      bag[key] = value;
    } else if (Object.hasOwn(BOOL_FLAGS, arg)) {
      if (inline !== null) throw new UsageError(`option ${arg} does not take a value`);
      const [key, val] = BOOL_FLAGS[arg];
      bag[key] = val;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown option: ${argv[i]}`);
    } else {
      throw new UsageError(`unexpected argument: ${argv[i]}`);
    }
  }

  if (o.date !== null) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(o.date);
    const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
    if (!m || !d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
      throw new UsageError(`invalid --date "${o.date}", expected YYYY-MM-DD`);
    }
  }
  return o;
}

export const HELP = `changelog-gen ${CLI_VERSION}

Turn git commit messages into Keep a Changelog entries.

Usage: changelog-gen [options]

Range:
  --tag-prefix <p>      Start from the latest tag starting with <p> (default: v)
  --from <ref>          Start after this ref (overrides the tag lookup)
  --to <ref>            End at this ref (default: HEAD)
  --path <dir>          Only commits touching <dir> (monorepo)
  --scope <name>        Also strip a "<name>:" subject prefix or "(<name>)" scope
  --include-merges      Keep merge commits (skipped by default)
  --all                 Also list chore, test, ci, build and style commits

Output:
  --version-label <v>   Heading label (default: Unreleased)
  --date <YYYY-MM-DD>   Heading date (default: today, UTC)
  --no-hash             Omit short commit hashes
  --write <file>        Insert the section into a changelog file
  --json                Machine readable output

Other:
  -h, --help            Show this help
  -V, --cli-version     Print the version of changelog-gen itself

Exit codes: 0 ok, 1 no commits in range, 2 usage error or not a git repo.
`;
