// @ts-check

/**
 * @typedef {{
 *   command: string,
 *   flags: { staged: boolean, all: boolean, json: boolean, force: boolean, fix: boolean },
 *   files: string[],
 * }} Parsed
 */

const COMMANDS = ["check", "install", "uninstall", "rules", "help"];

/** Flags allowed per command. */
/** @type {Record<string, string[]>} */
const ALLOWED = {
  check: ["staged", "all", "json", "fix"],
  install: ["force"],
  uninstall: [],
  rules: ["json"],
  help: [],
};

/**
 * @param {string[]} argv arguments after the script name
 * @returns {{ parsed: Parsed } | { help: true } | { version: true } | { error: string }}
 */
export function parseArgs(argv) {
  /** @type {Parsed} */
  const parsed = {
    command: "",
    flags: { staged: false, all: false, json: false, force: false, fix: false },
    files: [],
  };
  let rest = false;
  for (const a of argv) {
    if (rest) {
      positional(parsed, a);
      continue;
    }
    if (a === "--") {
      rest = true;
    } else if (a === "--help" || a === "-h") {
      return { help: true };
    } else if (a === "--version" || a === "-v") {
      return { version: true };
    } else if (a.startsWith("--")) {
      const name = a.slice(2);
      if (!(name in parsed.flags)) return { error: `unknown option ${a}` };
      parsed.flags[/** @type {keyof Parsed['flags']} */ (name)] = true;
    } else if (a.startsWith("-") && a.length > 1) {
      return { error: `unknown option ${a}` };
    } else {
      positional(parsed, a);
    }
  }
  if (!parsed.command) return { error: "missing command" };
  if (!COMMANDS.includes(parsed.command)) return { error: `unknown command "${parsed.command}"` };
  if (parsed.command === "help") return { help: true };
  const allowed = ALLOWED[parsed.command];
  for (const [name, on] of Object.entries(parsed.flags)) {
    if (on && !allowed.includes(name)) {
      return { error: `option --${name} is not valid for "${parsed.command}"` };
    }
  }
  if (parsed.command !== "check" && parsed.files.length > 0) {
    return { error: `"${parsed.command}" does not take file arguments` };
  }
  if (parsed.flags.staged && parsed.flags.all) return { error: "use either --staged or --all, not both" };
  if (parsed.files.length > 0 && (parsed.flags.staged || parsed.flags.all)) {
    return { error: "file arguments cannot be combined with --staged or --all" };
  }
  return { parsed };
}

/**
 * @param {Parsed} parsed
 * @param {string} a
 */
function positional(parsed, a) {
  if (!parsed.command) parsed.command = a;
  else parsed.files.push(a);
}
