// @ts-check

/**
 * @typedef {{ file: string, line: number }} Location
 * @typedef {{ name: string, locations: Location[] }} UsedVar
 */

/** Well-known runtime variables that are not project settings. PORT is deliberately absent. */
export const BUILTIN_IGNORES = [
  "NODE_ENV",
  "PATH",
  "HOME",
  "CI",
  "PWD",
  "USER",
  "USERNAME",
  "SHELL",
  "TERM",
  "LANG",
  "TMPDIR",
  "TEMP",
  "TMP",
  "HOSTNAME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  // Windows system variables (Windows treats env names case-insensitively,
  // so built-ins are matched case-insensitively too).
  "PATHEXT",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PROGRAMDATA",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "COMPUTERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  // POSIX and terminal conventions.
  "LOGNAME",
  "EDITOR",
  "VISUAL",
  "TZ",
  "LC_ALL",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "GITHUB_ACTIONS",
];

const BUILTIN_UPPER = new Set(BUILTIN_IGNORES.map((n) => n.toUpperCase()));

/** @param {string} pattern */
function globToRegExp(pattern) {
  const source = pattern
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`);
}

/**
 * Build a predicate that says whether a variable name is ignored.
 * @param {string[]} patterns names or globs (`*` and `?`), case-sensitive
 * @returns {(name: string) => boolean}
 */
export function makeIgnore(patterns) {
  const exact = new Set(patterns.filter((p) => !/[*?]/.test(p)));
  const globs = patterns.filter((p) => /[*?]/.test(p)).map(globToRegExp);
  return (name) =>
    BUILTIN_UPPER.has(name.toUpperCase()) || exact.has(name) || globs.some((g) => g.test(name));
}

/**
 * @param {Map<string, Location[]>} used variable name to read locations
 * @param {Set<string>} exampleKeys
 * @param {Set<string> | null} envKeys null when there is no env file to compare
 * @param {(name: string) => boolean} ignored
 */
export function compare(used, exampleKeys, envKeys, ignored) {
  /** @type {UsedVar[]} */
  const missing = [];
  for (const [name, locations] of [...used].sort(([a], [b]) => a.localeCompare(b))) {
    if (ignored(name) || exampleKeys.has(name)) continue;
    missing.push({ name, locations });
  }
  const unused = [...exampleKeys].filter((k) => !ignored(k) && !used.has(k)).sort();
  const missingInEnv = envKeys ? [...exampleKeys].filter((k) => !ignored(k) && !envKeys.has(k)).sort() : [];
  return { missing, unused, missingInEnv };
}
