// @ts-check
import { git, resolveRepo, safeRelPath, safeRev, ToolError } from "./git.js";
import {
  clipLines,
  clipText,
  parseBlamePorcelain,
  parseChurn,
  parseCommitHeader,
  parseContributors,
  parseFileHistory,
  parseLineLog,
  parseNumstatLines,
  redactEmails,
  splitLines,
} from "./parse.js";

const MAX_OUTPUT_CHARS = 24_000;
const MAX_BLAME_LINES = 400;
const FMT = "%x00%H%x01%ad%x01%an%x01%s";

const repoRootProp = {
  type: "string",
  description: "Optional absolute path of the repo to use instead of the server default.",
};

/** MCP tool definitions. */
export const TOOLS = [
  {
    name: "file_history",
    description:
      "Commits that touched a file: short sha, date, author, subject, +added/-deleted lines for that file. Follows renames by default.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the repo root." },
        limit: { type: "number", description: "Max commits (default 15, max 100)." },
        follow: { type: "boolean", description: "Follow renames (default true)." },
        repoRoot: repoRootProp,
      },
      required: ["path"],
    },
  },
  {
    name: "blame_range",
    description:
      "Blame a line range, grouped by commit: `L10-L24  sha  date  author  subject`. Max 400 lines. Code is omitted unless includeCode is true.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the repo root." },
        startLine: { type: "number", description: "First line (1-based)." },
        endLine: { type: "number", description: "Last line (1-based, inclusive)." },
        includeCode: { type: "boolean", description: "Also print the code lines (default false)." },
        repoRoot: repoRootProp,
      },
      required: ["path", "startLine", "endLine"],
    },
  },
  {
    name: "line_origin",
    description:
      "The commit that last changed a line, plus the earlier commit that touched the same line, each with its patch clipped to 40 lines.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the repo root." },
        line: { type: "number", description: "Line number (1-based)." },
        repoRoot: repoRootProp,
      },
      required: ["path", "line"],
    },
  },
  {
    name: "commit_details",
    description:
      "Full message, author, date, parents and changed files with +/- stats for one commit. Optional clipped patch.",
    inputSchema: {
      type: "object",
      properties: {
        sha: { type: "string", description: "Commit sha, branch, tag or revision such as HEAD~2." },
        includePatch: { type: "boolean", description: "Include the patch (default false)." },
        maxPatchLines: { type: "number", description: "Patch line cap (default 200, max 2000)." },
        repoRoot: repoRootProp,
      },
      required: ["sha"],
    },
  },
  {
    name: "search_commits",
    description:
      "Search commits by message (case-insensitive, literal) and/or author, date range and path. With pickaxe=true the query is matched against added/removed code (git -S) instead.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to find in subject/body (or in code with pickaxe)." },
        author: { type: "string", description: "Author name filter." },
        since: { type: "string", description: "Only commits after this date, e.g. 2026-01-01 or '2 weeks ago'." },
        until: { type: "string", description: "Only commits before this date." },
        path: { type: "string", description: "Limit to a path relative to the repo root." },
        pickaxe: { type: "boolean", description: "Use git -S on the query (default false)." },
        limit: { type: "number", description: "Max results (default 20, max 100)." },
        repoRoot: repoRootProp,
      },
    },
  },
  {
    name: "churn",
    description: "Files changed most often since a date, with commit counts and total lines changed. Finds hotspots.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "Default '90 days ago'." },
        limit: { type: "number", description: "Max files (default 15, max 100)." },
        path: { type: "string", description: "Limit to a directory or file relative to the repo root." },
        repoRoot: repoRootProp,
      },
    },
  },
  {
    name: "contributors",
    description: "Authors with commit counts (names only, merges excluded).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Limit to a path relative to the repo root." },
        since: { type: "string", description: "Only commits after this date." },
        limit: { type: "number", description: "Max authors (default 30, max 100)." },
        repoRoot: repoRootProp,
      },
    },
  },
];

/**
 * @param {unknown} v
 * @param {number} def default when absent (NaN means required)
 * @param {number} min
 * @param {number} max
 * @param {string} name
 * @returns {number}
 */
function intArg(v, def, min, max, name) {
  if (v === undefined || v === null || v === "") {
    if (Number.isNaN(def)) throw new ToolError(`${name} is required.`);
    return def;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ToolError(`${name} must be an integer.`);
  return Math.min(max, Math.max(min, n));
}

/**
 * Required 1-based line number; rejects values below 1 instead of clamping.
 * @param {unknown} v
 * @param {string} name
 * @returns {number}
 */
function lineArg(v, name) {
  const n = intArg(v, NaN, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, name);
  if (n < 1) throw new ToolError(`${name} must be >= 1.`);
  return n;
}

/**
 * @param {unknown} v
 * @param {string} name
 * @returns {string | undefined}
 */
function optStr(v, name) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (s.includes("\0")) throw new ToolError(`Invalid ${name}.`);
  return s === "" ? undefined : s;
}

/**
 * True when git failed only because the repo has no commits.
 * @param {unknown} err
 * @returns {boolean}
 */
const isNoCommits = (err) =>
  err instanceof ToolError && /does not have any commits|unknown revision|bad default revision/i.test(err.message);

/**
 * Cap total output and remove anything resembling an email address.
 * @param {string} text
 * @returns {string}
 */
export function finalize(text) {
  let out = redactEmails(text);
  if (out.length > MAX_OUTPUT_CHARS) {
    out = out.slice(0, MAX_OUTPUT_CHARS) + `\n(output clipped at ${MAX_OUTPUT_CHARS} characters)`;
  }
  return out;
}

/** @param {{ sha: string, date: string, author: string, subject: string }} c */
const commitLine = (c) => `${c.sha}  ${c.date}  ${c.author}  ${clipText(c.subject, 100)}`;

/**
 * Run a log-style git command; an empty repo yields null.
 * @param {string} root
 * @param {string[]} args
 * @returns {Promise<string | null>}
 */
async function logOrEmpty(root, args) {
  try {
    return await git(root, args);
  } catch (e) {
    if (isNoCommits(e)) return null;
    throw e;
  }
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} a
 */
async function fileHistory(root, a) {
  const p = safeRelPath(root, a.path);
  const limit = intArg(a.limit, 15, 1, 100, "limit");
  const follow = a.follow === undefined ? true : Boolean(a.follow);
  const args = ["log", "--date=short", "--numstat", `--format=${FMT}`, `-n${limit + 1}`];
  if (follow) args.push("--follow");
  args.push("--", p);
  const out = await logOrEmpty(root, args);
  if (out === null) return "No commits yet.";
  const commits = parseFileHistory(out);
  if (!commits.length) return `No history found for ${p}.`;
  const lines = [`History of ${p}${follow ? " (following renames)" : ""}:`];
  for (const c of commits.slice(0, limit)) lines.push(`${commitLine(c)}  +${c.added}/-${c.deleted}`);
  if (commits.length > limit) lines.push(`(capped at ${limit} commits; raise limit for more)`);
  return lines.join("\n");
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} a
 */
async function blameRange(root, a) {
  const p = safeRelPath(root, a.path);
  const start = lineArg(a.startLine, "startLine");
  const endIn = lineArg(a.endLine, "endLine");
  if (endIn < start) throw new ToolError("endLine must be >= startLine.");
  const end = Math.min(endIn, start + MAX_BLAME_LINES - 1);
  const includeCode = Boolean(a.includeCode);
  const out = await git(root, ["blame", "--porcelain", "-L", `${start},${end}`, "--", p]);
  const groups = parseBlamePorcelain(out);
  if (!groups.length) return `No blame data for ${p} L${start}-L${end}.`;
  const lines = [];
  for (const g of groups) {
    const range = g.start === g.end ? `L${g.start}` : `L${g.start}-L${g.end}`;
    if (g.info.uncommitted) {
      lines.push(`${range}  uncommitted  (working tree changes)`);
    } else {
      lines.push(`${range}  ${g.info.sha}  ${g.info.date}  ${g.info.author}  ${clipText(g.info.subject, 100)}`);
    }
    if (includeCode) for (const c of g.code) lines.push(`    ${clipText(c, 200)}`);
  }
  if (endIn > end) lines.push(`(range capped at ${MAX_BLAME_LINES} lines: showed L${start}-L${end})`);
  return lines.join("\n");
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} a
 */
async function lineOrigin(root, a) {
  const p = safeRelPath(root, a.path);
  const line = lineArg(a.line, "line");
  const out = await git(root, ["log", "--date=short", `--format=${FMT}`, "-n", "2", "-L", `${line},${line}:${p}`]);
  const entries = parseLineLog(out);
  if (!entries.length) return `No history found for ${p} line ${line}.`;
  const labels = ["Last changed by", "Previously changed by"];
  const lines = [];
  entries.slice(0, 2).forEach((e, i) => {
    const [sha = "", date = "", author = "", ...subj] = e.header.split("\x01");
    lines.push(`${labels[i]}: ${commitLine({ sha: sha.slice(0, 7), date, author, subject: subj.join("\x01") })}`);
    const { lines: kept, dropped } = clipLines(e.patch, 40);
    for (const l of kept) lines.push(`  ${l}`);
    if (dropped) lines.push(`  (patch clipped: ${dropped} more lines)`);
  });
  if (entries.length < 2) lines.push("(no earlier commit touched this line)");
  return lines.join("\n");
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} a
 */
async function commitDetails(root, a) {
  const rev = safeRev(a.sha);
  const includePatch = Boolean(a.includePatch);
  const maxPatch = intArg(a.maxPatchLines, 200, 1, 2000, "maxPatchLines");
  let full = "";
  try {
    full = (await git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])).trim();
  } catch {
    full = "";
  }
  if (!full) throw new ToolError(`Unknown commit: ${rev}`);
  const head = parseCommitHeader(
    await git(root, ["log", "-1", "--date=format:%Y-%m-%d %H:%M:%S %z", "--format=%H%x00%an%x00%ad%x00%P%x00%B", full, "--"])
  );
  const merge = head.parents.length > 1;
  const stats = parseNumstatLines(
    splitLines(
      await git(
        root,
        merge
          ? ["diff", "--numstat", "-M", head.parents[0], full]
          : ["diff-tree", "--numstat", "--root", "--no-commit-id", "-r", "-M", full]
      )
    )
  );
  const lines = [
    `commit ${head.sha}`,
    `author  ${head.author}`,
    `date    ${head.date}`,
    `parents ${head.parents.map((s) => s.slice(0, 7)).join(" ") || "(root commit)"}${merge ? "  (merge; stats vs first parent)" : ""}`,
    "",
    ...head.message.split("\n").map((l) => `    ${l}`),
    "",
  ];
  const totalA = stats.reduce((n, s) => n + s.added, 0);
  const totalD = stats.reduce((n, s) => n + s.deleted, 0);
  lines.push(`${stats.length} file(s) changed, +${totalA}/-${totalD}`);
  const maxFiles = 100;
  for (const s of stats.slice(0, maxFiles)) {
    lines.push(`  ${s.binary ? "binary" : `+${s.added}/-${s.deleted}`}  ${s.path}`);
  }
  if (stats.length > maxFiles) lines.push(`  (file list capped at ${maxFiles}; ${stats.length - maxFiles} more)`);
  if (includePatch) {
    const raw = await git(
      root,
      merge ? ["diff", "-M", head.parents[0], full] : ["diff-tree", "-p", "--root", "--no-commit-id", "-M", full]
    );
    const patch = splitLines(raw).filter((l) => !/^(index [0-9a-f]|similarity index)/.test(l));
    while (patch.length && patch[patch.length - 1] === "") patch.pop();
    const { lines: kept, dropped } = clipLines(patch, maxPatch);
    lines.push("", "patch:", ...kept);
    if (dropped) lines.push(`(patch clipped at ${maxPatch} lines; ${dropped} more)`);
  }
  return lines.join("\n");
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} a
 */
async function searchCommits(root, a) {
  const limit = intArg(a.limit, 20, 1, 100, "limit");
  const query = optStr(a.query, "query");
  const author = optStr(a.author, "author");
  const since = optStr(a.since, "since");
  const until = optStr(a.until, "until");
  const rawPath = optStr(a.path, "path");
  const pickaxe = Boolean(a.pickaxe);
  if (pickaxe && !query) throw new ToolError("pickaxe requires a query.");
  const args = ["log", "--date=short", `--format=${FMT}`, `-n${limit + 1}`];
  if (query && pickaxe) args.push(`-S${query}`);
  else if (query) args.push(`--grep=${query}`, "-i", "--fixed-strings");
  if (author) args.push(`--author=${author}`, "-i");
  if (since) args.push(`--since=${since}`);
  if (until) args.push(`--until=${until}`);
  args.push("--");
  if (rawPath) args.push(safeRelPath(root, rawPath));
  const out = await logOrEmpty(root, args);
  if (out === null) return "No commits yet.";
  const commits = parseFileHistory(out);
  if (!commits.length) return "No matching commits.";
  const lines = commits.slice(0, limit).map(commitLine);
  if (commits.length > limit) lines.push(`(capped at ${limit} results; narrow the search or raise limit)`);
  return lines.join("\n");
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} a
 */
async function churn(root, a) {
  const since = optStr(a.since, "since") ?? "90 days ago";
  const limit = intArg(a.limit, 15, 1, 100, "limit");
  const rawPath = optStr(a.path, "path");
  const args = ["log", `--since=${since}`, "--numstat", "--no-renames", "--format=%x00", "--"];
  if (rawPath) args.push(safeRelPath(root, rawPath));
  const out = await logOrEmpty(root, args);
  if (out === null) return "No commits yet.";
  const rows = parseChurn(out);
  if (!rows.length) return `No file changes since ${since}.`;
  const lines = [`Most changed files since ${since}:`, "commits  lines  path"];
  for (const r of rows.slice(0, limit)) {
    lines.push(`${String(r.commits).padStart(7)}  ${String(r.lines).padStart(5)}  ${r.path}`);
  }
  if (rows.length > limit) lines.push(`(showing ${limit} of ${rows.length} files; raise limit for more)`);
  return lines.join("\n");
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} a
 */
async function contributors(root, a) {
  const limit = intArg(a.limit, 30, 1, 100, "limit");
  const since = optStr(a.since, "since");
  const rawPath = optStr(a.path, "path");
  const args = ["log", "--no-merges", "--format=%an%x00"];
  if (since) args.push(`--since=${since}`);
  args.push("--");
  if (rawPath) args.push(safeRelPath(root, rawPath));
  const out = await logOrEmpty(root, args);
  if (out === null) return "No commits yet.";
  const rows = parseContributors(out);
  if (!rows.length) return "No commits found.";
  const lines = rows.slice(0, limit).map((r) => `${String(r.commits).padStart(6)}  ${r.name}`);
  if (rows.length > limit) lines.push(`(showing ${limit} of ${rows.length} authors; raise limit for more)`);
  return lines.join("\n");
}

const HANDLERS = {
  file_history: fileHistory,
  blame_range: blameRange,
  line_origin: lineOrigin,
  commit_details: commitDetails,
  search_commits: searchCommits,
  churn,
  contributors,
};

/**
 * Run one tool and return plain text. Throws ToolError for user-facing failures.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string} defaultRoot
 * @returns {Promise<string>}
 */
export async function callTool(name, args, defaultRoot) {
  if (!Object.prototype.hasOwnProperty.call(HANDLERS, name)) throw new ToolError(`Unknown tool: ${name}`);
  const root = await resolveRepo(defaultRoot, args.repoRoot);
  const handler = HANDLERS[/** @type {keyof typeof HANDLERS} */ (name)];
  return finalize(await handler(root, args));
}
