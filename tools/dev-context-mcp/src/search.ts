// Scale layer: ripgrep-backed search + a short-lived file-list cache.
//
// • ripgrep does the file walking and matching in native code, so we never read
//   every file in JS. When `rg` isn't on PATH, callers fall back to the JS
//   scanner (searchFiles in server.ts) — rg is an optimization, never required.
// • The glob cache memoizes fast-glob results per (root, patterns) for a few
//   seconds, invalidated on any write, so repeated tree/find calls don't re-walk.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { EXCLUDES } from "./util.js";

// ─── ripgrep binary resolution ─────────────────────────────────────────────

// Resolve an executable to an absolute path by scanning PATH (+ PATHEXT on
// Windows). Lets us spawn with shell:false — no shell escaping of patterns.
function resolveBinary(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())]
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

let rgResolved = false;
let rgPath: string | null = null;

export function ripgrepPath(): string | null {
  if (!rgResolved) {
    // Explicit override wins (e.g. a vendored rg, or a non-PATH install);
    // otherwise scan PATH. Null → callers use the JS fallback.
    const override = process.env.MCP_RIPGREP_PATH?.trim();
    rgPath = override && existsSync(override) ? override : resolveBinary("rg");
    rgResolved = true;
  }
  return rgPath;
}

export function hasRipgrep(): boolean {
  return ripgrepPath() !== null;
}

// Run rg from `root`, resolving stdout. Returns null on spawn error or rg's
// "error" exit (2); empty string when there were simply no matches (exit 1).
function runRg(root: string, args: string[]): Promise<string | null> {
  const bin = ripgrepPath();
  if (!bin) return Promise.resolve(null);

  return new Promise((resolve) => {
    let out = "";
    let killed = false;
    const child = spawn(bin, args, { cwd: root });
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.length > 8_000_000) {
        killed = true;
        child.kill();
      }
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (killed) return resolve(out);
      // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
      if (code === 0 || code === 1) resolve(out);
      else resolve(null);
    });
  });
}

// Build the --glob arguments: positive include globs first, then the shared
// EXCLUDES (already `!`-prefixed — rg uses the same negation syntax).
function globArgs(includeGlobs: string[]): string[] {
  const args: string[] = [];
  for (const g of includeGlobs) args.push("--glob", g);
  for (const g of EXCLUDES) args.push("--glob", g);
  return args;
}

export interface RgQuery {
  pattern: string;
  /** true → fixed-string (substring) match; false → regex. */
  fixed: boolean;
  ignoreCase: boolean;
  includeGlobs: string[];
}

// Absolute paths of files containing at least one match, or null if rg is
// unavailable / errored (caller should fall back to globbing).
export async function rgFilesWithMatches(root: string, q: RgQuery): Promise<string[] | null> {
  const args = ["--files-with-matches", "--no-ignore", "--no-messages"];
  if (q.fixed) args.push("--fixed-strings");
  if (q.ignoreCase) args.push("--ignore-case");
  args.push(...globArgs(q.includeGlobs));
  args.push("--regexp", q.pattern, ".");

  const out = await runRg(root, args);
  if (out === null) return null;
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((rel) => path.resolve(root, rel));
}

export interface RgMatch {
  rel: string;
  line: number;
  text: string;
}

// `file:line:text` matches for the regex grep tool, capped at maxResults.
export async function rgGrep(
  root: string,
  q: { pattern: string; ignoreCase: boolean; includeGlobs: string[]; maxResults: number }
): Promise<RgMatch[] | null> {
  const args = ["--line-number", "--no-heading", "--no-ignore", "--no-messages", "--color", "never"];
  if (q.ignoreCase) args.push("--ignore-case");
  args.push(...globArgs(q.includeGlobs));
  args.push("--regexp", q.pattern, ".");

  const out = await runRg(root, args);
  if (out === null) return null;

  const results: RgMatch[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    // relative paths under cwd have no drive-letter colon, so the first two
    // colons delimit path:line:text reliably.
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (m) results.push({ rel: m[1]!.replace(/^\.[\\/]/, ""), line: Number(m[2]), text: m[3]! });
    if (results.length >= q.maxResults) break;
  }
  return results;
}

// ─── glob cache ──────────────────────────────────────────────────────────────

interface CacheEntry {
  files: string[];
  expires: number;
}

const TTL_MS = 5_000;
const cache = new Map<string, CacheEntry>();

// Bumped on any write so cached file lists can't go stale across a mutation.
export function invalidateGlobCache(): void {
  cache.clear();
}

export async function cachedGlob(
  root: string,
  patterns: string[],
  options: { absolute?: boolean; onlyFiles?: boolean; dot?: boolean }
): Promise<string[]> {
  const key = `${root}\u0000${patterns.join("\u0001")}\u0000${JSON.stringify(options)}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.files;

  const files = await fg(patterns, { cwd: root, suppressErrors: true, ...options });
  cache.set(key, { files, expires: now + TTL_MS });
  return files;
}
