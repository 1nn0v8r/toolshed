// @ts-check
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./args.js";
import { listFiles, isEnvFile, isDefaultExcludedFile } from "./discover.js";
import { createMatcher, isGlob } from "./glob.js";
import { sortByPath, sortByPriority } from "./priority.js";
import { addLineNumbers, readForPack } from "./read.js";
import { renderMarkdown, renderXml } from "./render.js";
import { estimateTokens } from "./tokens.js";

/**
 * @typedef {import("./args.js").Options} Options
 * @typedef {{path: string, reason: string, code: string}} Skipped
 * @typedef {object} PackResult
 * @property {"ok" | "no-match" | "no-packable" | "budget-too-small"} status
 * @property {string} output rendered document (empty unless status is "ok")
 * @property {{path: string, tokens: number}[]} files
 * @property {Skipped[]} skipped
 * @property {{path: string, tokens: number}[]} omitted
 * @property {string[]} envSkipped
 * @property {number} totalTokens
 * @property {"git" | "walk"} mode
 * @property {string} root absolute root folder
 */

/**
 * @typedef {{kind: "dir" | "file", rel: string} | {kind: "glob", match: (p: string) => boolean}} Scope
 */

/**
 * Decide the root folder and the scope filters from positional arguments.
 * A single folder argument becomes the root. Otherwise the root is cwd and
 * every argument must be a path inside it or a glob.
 * @param {string[]} positionals
 * @param {string} cwd
 * @returns {{root: string, scopes: Scope[]}}
 */
export function resolveScope(positionals, cwd) {
  const root = path.resolve(cwd);
  if (positionals.length === 0) return { root, scopes: [] };

  /** @param {string} p */
  const statOf = (p) => {
    try {
      return fs.statSync(path.resolve(root, p));
    } catch {
      return null;
    }
  };

  if (positionals.length === 1) {
    const st = statOf(positionals[0]);
    if (st && st.isDirectory()) {
      return { root: path.resolve(root, positionals[0]), scopes: [] };
    }
  }

  /** @type {Scope[]} */
  const scopes = [];
  for (const p of positionals) {
    const abs = path.resolve(root, p);
    const st = statOf(p);
    if (st) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) {
        throw new UsageError(`"${p}" is outside the current folder`);
      }
      scopes.push({ kind: st.isDirectory() ? "dir" : "file", rel });
    } else if (isGlob(p)) {
      scopes.push({ kind: "glob", match: createMatcher([p]) });
    } else {
      throw new UsageError(`path not found: ${p}`);
    }
  }
  return { root, scopes };
}

/**
 * @param {Scope[]} scopes
 * @param {string} rel
 * @returns {boolean}
 */
function inScope(scopes, rel) {
  if (scopes.length === 0) return true;
  return scopes.some((s) => {
    if (s.kind === "glob") return s.match(rel);
    if (s.rel === "") return true;
    if (s.kind === "file") return rel === s.rel;
    return rel.startsWith(`${s.rel}/`);
  });
}

/**
 * Pick files in the given order until the budget is reached. A file that does
 * not fit is left out and later, smaller files may still fit.
 * @template {{path: string, tokens: number}} T
 * @param {T[]} ordered
 * @param {number | null} maxTokens
 * @returns {{included: T[], omitted: T[]}}
 */
export function applyBudget(ordered, maxTokens) {
  if (maxTokens === null) return { included: ordered, omitted: [] };
  const included = [];
  const omitted = [];
  let used = 0;
  for (const f of ordered) {
    if (used + f.tokens <= maxTokens) {
      included.push(f);
      used += f.tokens;
    } else {
      omitted.push(f);
    }
  }
  return { included, omitted };
}

/**
 * @param {Options} opts
 * @param {string} cwd
 * @returns {Promise<PackResult>}
 */
export async function pack(opts, cwd) {
  const { root, scopes } = resolveScope(opts.paths, cwd);
  const { mode, files: discovered } = await listFiles(root, {
    defaultExcludes: opts.defaultExcludes,
  });

  const matchInclude = createMatcher(opts.include);
  const matchExclude = createMatcher(opts.exclude);

  /** @type {string | null} */
  let outRel = null;
  if (opts.out) {
    const rel = path.relative(root, path.resolve(cwd, opts.out)).split(path.sep).join("/");
    if (rel !== "" && !rel.startsWith("../") && rel !== ".." && !path.isAbsolute(rel)) outRel = rel;
  }

  /** @type {string[]} */
  const candidates = [];
  /** @type {string[]} */
  const envSkipped = [];
  for (const rel of [...new Set(discovered)].sort()) {
    if (!inScope(scopes, rel)) continue;
    if (opts.include.length > 0 && !matchInclude(rel)) continue;
    if (opts.exclude.length > 0 && matchExclude(rel)) continue;
    if (outRel !== null && rel === outRel) continue;
    if (isEnvFile(rel) && !opts.allowEnv) {
      envSkipped.push(rel);
      continue;
    }
    if (opts.defaultExcludes && isDefaultExcludedFile(rel)) continue;
    candidates.push(rel);
  }

  /** @type {PackResult} */
  const result = {
    status: "ok",
    output: "",
    files: [],
    skipped: [],
    omitted: [],
    envSkipped,
    totalTokens: 0,
    mode,
    root,
  };
  if (candidates.length === 0) {
    result.status = "no-match";
    return result;
  }

  /** @type {{path: string, text: string, tokens: number}[]} */
  const loaded = [];
  for (const rel of candidates) {
    const r = await readForPack(path.join(root, ...rel.split("/")), opts.maxFileSize);
    if (r.kind === "ignore") continue;
    if (r.kind === "skip") {
      result.skipped.push({ path: rel, reason: r.reason, code: r.code });
      continue;
    }
    const text = opts.lineNumbers ? addLineNumbers(r.content) : r.content;
    loaded.push({ path: rel, text, tokens: estimateTokens(text) });
  }
  if (loaded.length === 0) {
    result.status = "no-packable";
    return result;
  }

  const ordered = opts.order === "path" ? sortByPath(loaded) : sortByPriority(loaded);
  const { included, omitted } = applyBudget(ordered, opts.maxTokens);
  result.omitted = omitted.map((o) => ({ path: o.path, tokens: o.tokens }));
  if (included.length === 0) {
    result.status = "budget-too-small";
    return result;
  }

  result.files = included.map((f) => ({ path: f.path, tokens: f.tokens }));
  result.totalTokens = included.reduce((n, f) => n + f.tokens, 0);
  const input = {
    rootName: path.basename(root) || "root",
    files: included,
    omitted: result.omitted,
    totalTokens: result.totalTokens,
    maxTokens: opts.maxTokens,
  };
  result.output = opts.format === "xml" ? renderXml(input) : renderMarkdown(input);
  return result;
}
