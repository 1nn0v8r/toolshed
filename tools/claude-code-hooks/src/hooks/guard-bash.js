#!/usr/bin/env node
// @ts-check
import { allow, ask, deny, isMain, runHook } from "../lib/io.js";
import { stringList } from "../lib/config.js";
import { cmdName, parseCommand, unwrap } from "../lib/bash-parse.js";

/**
 * @typedef {{ level: "deny" | "ask", reason: string, raw: string }} Finding
 */

const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "iex", "invoke-expression"]);
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "iwr", "irm", "invoke-webrequest", "invoke-restmethod"]);
const DB_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "mongosh", "mycli", "pgcli", "sqlcmd", "usql"]);
const SYSTEM_DIRS =
  /^\/(?:bin|boot|dev|etc|lib|lib32|lib64|opt|proc|root|sbin|srv|sys|usr|var|home|users|system|library|applications|usr\/(?:bin|lib|local|share)|var\/(?:lib|log))$/i;

/**
 * Classify an rm style target.
 * @param {string} target
 * @returns {"deny" | "ask" | null}
 */
export function classifyRmTarget(target) {
  let t = target.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (t === "") return null;
  if (t === "/" || t === "/*" || t === "/.") return "deny";
  t = t.replace(/\/\*?$/, "") || "/";
  if (t === "/") return "deny";
  if (/^(?:~|\$home|\$\{home\}|%userprofile%|\$env:userprofile)$/i.test(t)) return "deny";
  if (/^(?:~|\$home|\$\{home\})\/(?:\*|\.\*)$/i.test(target.trim().replace(/\\/g, "/"))) return "deny";
  if (/^[A-Za-z]:$/.test(t)) return "deny";
  if (SYSTEM_DIRS.test(t)) return "deny";
  if (/^(?:\*|\.\*|\.|\.\.|\.\/\*|\.\.\/\*|\*\.\*)$/.test(t)) return "ask";
  return null;
}

/**
 * Split argv into flag letters, long flags and positional args.
 * @param {string[]} args
 */
function parseFlags(args) {
  /** @type {Set<string>} */
  const short = new Set();
  /** @type {Set<string>} */
  const long = new Set();
  /** @type {string[]} */
  const positional = [];
  let rest = false;
  for (const a of args) {
    if (rest) positional.push(a);
    else if (a === "--") rest = true;
    else if (a.startsWith("--")) long.add(a.slice(2).split("=")[0].toLowerCase());
    else if (a.length > 1 && a.startsWith("-")) for (const ch of a.slice(1)) short.add(ch);
    else positional.push(a);
  }
  return { short, long, positional };
}

/**
 * @param {string[]} words unwrapped words of one segment
 * @param {string} raw
 * @param {Finding[]} out
 */
function checkSegment(words, raw, out) {
  if (words.length === 0) return;
  const name = cmdName(words[0]);
  const args = words.slice(1);
  /** @param {"deny" | "ask"} level @param {string} reason */
  const add = (level, reason) => out.push({ level, reason, raw });

  if (name === "rm") {
    const f = parseFlags(args);
    const recursive = f.short.has("r") || f.short.has("R") || f.long.has("recursive");
    if (recursive || f.long.has("no-preserve-root")) {
      for (const t of f.positional) {
        const c = classifyRmTarget(t);
        if (c === "deny") add("deny", `rm on "${t}" would delete a root, home or system directory`);
        else if (c === "ask" && recursive) add("ask", `recursive rm on "${t}" wipes the current directory`);
      }
    }
    return;
  }
  if (["rmdir", "rd", "del", "erase", "remove-item", "ri"].includes(name)) {
    const recursive = args.some((a) => /^(?:\/s|-recurse|-r)$/i.test(a));
    if (recursive) {
      for (const t of args) {
        if (/^\/[A-Za-z]$/.test(t) || t.startsWith("-")) continue;
        if (classifyRmTarget(t) === "deny") add("deny", `${name} on "${t}" would delete a root, home or system directory`);
      }
    }
    return;
  }
  if (/^mkfs(?:\.|$)/.test(name)) {
    add("deny", "mkfs would format a filesystem");
    return;
  }
  if (name === "dd") {
    if (args.some((a) => /^of=(?:\/dev\/|\\\\\.\\)/i.test(a))) add("deny", "dd writing to a device would destroy data");
    return;
  }
  if (name === "chmod" || name === "chown") {
    const f = parseFlags(args);
    if (f.short.has("R") || f.long.has("recursive")) {
      const rootish = f.positional.some((t) => classifyRmTarget(t) === "deny");
      const open = args.some((a) => /^(?:0?777|a\+rwx|ugo\+rwx)$/.test(a));
      if (rootish && (name === "chown" || open)) add("deny", `${name} -R on a root, home or system directory`);
      else if (name === "chmod" && open) add("ask", "recursive chmod 777 makes files world-writable");
    }
    return;
  }
  if (name === "git") {
    checkGit(args, add);
    return;
  }
  const sub = firstNonFlag(args);
  if (["npm", "pnpm", "yarn", "bun"].includes(name) && sub === "publish") {
    if (!args.includes("--dry-run")) add("ask", `${name} publish releases a package publicly`);
    return;
  }
  if (name === "yarn" && sub === "npm" && args.includes("publish")) {
    add("ask", "yarn npm publish releases a package publicly");
    return;
  }
  if (["docker", "podman"].includes(name)) {
    const idx = args.findIndex((a) => !a.startsWith("-"));
    if (idx !== -1 && (args[idx] === "push" || (args[idx] === "image" && args[idx + 1] === "push"))) {
      add("ask", `${name} push uploads an image to a registry`);
    }
    return;
  }
  if (name === "twine" && sub === "upload") add("ask", "twine upload publishes a package");
  if (name === "cargo" && sub === "publish" && !args.includes("--dry-run")) add("ask", "cargo publish releases a crate");
}

const VALUE_FLAGS = new Set(["--registry", "--otp", "--tag", "--access", "--prefix", "--workspace", "-w", "--cwd", "-C"]);

/**
 * First positional argument, skipping flags and the values of known value flags.
 * @param {string[]} args
 */
function firstNonFlag(args) {
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) i++;
    else if (!args[i].startsWith("-")) return args[i];
  }
  return undefined;
}

/**
 * @param {string[]} args arguments after "git"
 * @param {(level: "deny" | "ask", reason: string) => void} add
 */
function checkGit(args, add) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(args[i]) ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === "push") return checkGitPush(rest, add);
  if (sub === "reset" && rest.includes("--hard")) {
    add("ask", "git reset --hard discards uncommitted work");
    return;
  }
  if (sub === "clean") {
    const f = parseFlags(rest);
    const force = f.short.has("f") || f.long.has("force");
    const dry = f.short.has("n") || f.long.has("dry-run");
    if (force && !dry) add("ask", "git clean -f permanently deletes untracked files");
  }
}

/**
 * @param {string[]} rest arguments after "git push"
 * @param {(level: "deny" | "ask", reason: string) => void} add
 */
function checkGitPush(rest, add) {
  const f = parseFlags(rest);
  const plainForce = f.short.has("f") || f.long.has("force");
  const lease = f.long.has("force-with-lease") || f.long.has("force-if-includes");
  const refspecs = f.positional.slice(1);
  const plusSpec = refspecs.some((r) => r.startsWith("+"));
  const force = plainForce || plusSpec;
  const deleting = f.short.has("d") || f.long.has("delete");
  const protectedRef = /^(?:refs\/heads\/)?(?:main|master)$/;
  const targets = refspecs.map((r) => {
    const s = r.replace(/^\+/, "");
    const colon = s.indexOf(":");
    return colon === -1 ? s : s.slice(colon + 1);
  });
  const hitsProtected = targets.some((t) => protectedRef.test(t));
  const deletesProtected = refspecs.some((r) => /^:/.test(r) && protectedRef.test(r.slice(1))) || (deleting && refspecs.some((r) => protectedRef.test(r)));
  if (deletesProtected) {
    add("deny", "pushing a deletion of main or master");
    return;
  }
  if (force && (f.long.has("all") || f.long.has("mirror"))) {
    add("deny", "force push of all refs would overwrite main or master");
    return;
  }
  if (force && hitsProtected) {
    add("deny", "force push to main or master rewrites shared history");
    return;
  }
  if (lease || force) {
    if (lease && hitsProtected) add("ask", "force-with-lease push to main or master");
    else if (!hitsProtected && refspecs.length === 0) add("ask", "force push without an explicit branch (it may be main or master)");
    else add("ask", lease ? "force-with-lease push rewrites remote history" : "force push rewrites remote history");
  }
}

/**
 * Whole-command checks that do not depend on one segment.
 * @param {string} command
 * @param {import("../lib/bash-parse.js").Segment[][]} levels
 * @param {Finding[]} out
 */
function checkWhole(command, levels, out) {
  const squashed = command.replace(/\s+/g, "");
  if (/:\(\)\{:\|:&\};:/.test(squashed) || /(\w+)\(\)\{\1\|\1&\};\1/.test(squashed)) {
    out.push({ level: "deny", reason: "fork bomb", raw: command });
  }
  if (/\b(?:sh|bash|zsh)\s+<\(\s*(?:curl|wget)\b/.test(command) || /\b(?:sh|bash|zsh)\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/.test(command)) {
    out.push({ level: "ask", reason: "runs a downloaded script without review", raw: command });
  }
  let usesDb = false;
  for (const level of levels) {
    for (let i = 0; i < level.length; i++) {
      const seg = level[i];
      const words = unwrap(seg.words);
      const name = words.length ? cmdName(words[0]) : "";
      if (DB_CLIENTS.has(name) || words.some((w) => DB_CLIENTS.has(cmdName(w)))) usesDb = true;
      if (DOWNLOADERS.has(name) && (seg.op === "|" || seg.op === "|&") && level[i + 1]) {
        const next = unwrap(level[i + 1].words);
        if (next.length && SHELL_NAMES.has(cmdName(next[0]))) {
          out.push({ level: "ask", reason: "pipes a download into a shell", raw: seg.raw + " | " + level[i + 1].raw });
        }
      }
      for (const r of seg.redirects) {
        if (r.op.startsWith(">") && /^\/dev\/(?:sd|hd|vd|xvd|nvme|disk|mmcblk)/.test(r.target)) {
          out.push({ level: "deny", reason: "redirect to a block device would destroy data", raw: seg.raw });
        }
      }
    }
  }
  if (usesDb && /\bdrop\s+(?:database|table|schema)\b/i.test(command)) {
    out.push({ level: "ask", reason: "SQL DROP in a database client", raw: command });
  }
}

/**
 * @param {string} pattern
 * @returns {RegExp | null}
 */
function toRegex(pattern) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    process.stderr.write(`claude-code-hooks guard-bash: ignoring invalid regex in config: ${pattern}\n`);
    return null;
  }
}

/**
 * Analyze a command. Exposed for tests.
 * @param {string} command
 * @param {Record<string, any>} [config]
 * @returns {Finding[]}
 */
export function analyze(command, config = {}) {
  /** @type {Finding[]} */
  const found = [];
  const levels = parseCommand(command);
  for (const level of levels) {
    for (const seg of level) checkSegment(unwrap(seg.words), seg.raw, found);
  }
  checkWhole(command, levels, found);
  for (const p of stringList(config, "extraDeny")) {
    const re = toRegex(p);
    if (re && re.test(command)) found.push({ level: "deny", reason: `matches extraDeny rule ${p}`, raw: command });
  }
  for (const p of stringList(config, "extraAsk")) {
    const re = toRegex(p);
    if (re && re.test(command)) found.push({ level: "ask", reason: `matches extraAsk rule ${p}`, raw: command });
  }
  const allowRes = stringList(config, "allow")
    .map(toRegex)
    .filter(/** @returns {r is RegExp} */ (r) => r !== null);
  return found.filter((f) => f.level === "deny" || !allowRes.some((re) => re.test(f.raw) || re.test(command)));
}

/**
 * @param {any} input hook payload
 * @param {Record<string, any>} [config]
 */
export function evaluate(input, config = {}) {
  const ti = input.tool_input;
  if (!ti || typeof ti.command !== "string" || ti.command.trim() === "") return allow();
  const found = analyze(ti.command, config);
  if (found.length === 0) return allow();
  const denies = found.filter((f) => f.level === "deny");
  const list = denies.length > 0 ? denies : found;
  const reasons = [...new Set(list.map((f) => f.reason))].join("; ");
  return denies.length > 0
    ? deny(`Blocked destructive command: ${reasons}.`)
    : ask(`This command is risky: ${reasons}. Confirm to run it.`);
}

if (isMain(import.meta.url)) await runHook("guard-bash", evaluate);
