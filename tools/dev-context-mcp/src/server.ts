#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fg from "fast-glob";
import { readFile, writeFile, mkdir, unlink, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

import { EXCLUDES, untrusted, fileExists, safePathIn, clamp } from "./util.js";
import {
  TOOL_CAPS,
  capabilityError,
  confineRoot,
  resolveCapabilities,
  type Session,
  type Transport,
} from "./security.js";
import { getToolDefinitions } from "./tools.js";
import { rgFilesWithMatches, rgGrep, cachedGlob, invalidateGlobCache } from "./search.js";
import { isWebTool, handleWebTool } from "./web.js";

const exec = promisify(execCb);

// Shell used by the run_command tool. Defaults to bash (git-bash on Windows) so
// commands behave like the user's interactive shell; override with MCP_SHELL.
const RUN_SHELL = process.env.MCP_SHELL || (process.platform === "win32" ? "bash" : "/bin/sh");

function detectRepoRoot(start: string): string {
  // Walk up from the launch directory to the nearest enclosing git repo, so the
  // server roots at the project top even when spawned from a subdirectory (e.g. dist/).
  let dir = path.resolve(start);
  while (true) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

// Initial active root. Resolution order:
//   1. REPO_ROOT env  (explicit pin)
//   2. nearest git root above the launch cwd  (auto-detect — "works for any repo")
//   3. the launch cwd itself  (fallback for non-git dirs)
export function resolveInitialRoot(): string {
  return process.env.REPO_ROOT
    ? path.resolve(process.env.REPO_ROOT)
    : detectRepoRoot(process.cwd());
}

// Build a fresh, independent session for a transport. Each HTTP connection gets
// its own — so one client's set_repo_root can never affect another's.
export function makeSession(transport: Transport): Session {
  const { caps, fullPower } = resolveCapabilities(transport);
  const root = resolveInitialRoot();
  const base = process.env.MCP_ROOT_BASE
    ? path.resolve(process.env.MCP_ROOT_BASE)
    : root;
  return { root, caps, fullPower, rootBase: fullPower ? null : base };
}

function getArgs(request: { params: { arguments?: unknown } }): Record<string, unknown> {
  return (request.params.arguments as Record<string, unknown>) ?? {};
}

// ─── Server factory (one per session) ─────────────────────────────────────────

export function createServer(session: Session): Server {
  const server = new Server(
    { name: "dev-context-mcp", version: "3.0.0" },
    { capabilities: { tools: {} } }
  );

  // ── Per-session helpers (close over session.root) ──────────────────────────

  const safePath = (inputPath: string) => safePathIn(session.root, inputPath);

  const resolveModuleDir = (input?: unknown): { dir: string; label: string } => {
    const raw = String(input ?? "").trim();
    if (!raw || raw === ".") return { dir: session.root, label: "." };
    return { dir: safePath(raw), label: raw };
  };

  const readPackageJson = async (dir: string) => {
    const packagePath = path.join(dir, "package.json");
    const relative = path.relative(session.root, packagePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Invalid path: outside repo root.");
    }
    const raw = await readFile(packagePath, "utf8");
    return JSON.parse(raw);
  };

  // Fixed-command runner for git/quality tools (not the arbitrary-shell tool).
  const runCommand = async (command: string, cwd = session.root) => {
    try {
      const { stdout, stderr } = await exec(command, {
        cwd,
        timeout: 60_000,
        maxBuffer: 1024 * 500,
      });
      return (stdout || stderr || "Command completed with no output.").slice(0, 20_000);
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      return `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`.slice(0, 20_000);
    }
  };

  const searchFiles = async (options: {
    query: string;
    patterns: string[];
    maxResults: number;
    contextLines: number;
    emptyMessage: string;
    matchAll?: boolean;
    regex?: boolean;
  }): Promise<string> => {
    const rawQuery = options.query.trim();
    if (!rawQuery) return "Please provide a search query.";

    // Build a matcher (for extracting context lines) and an rg pattern spec that
    // agree on semantics, so ripgrep's candidate files and the JS line-matcher
    // never disagree.
    let matcher: (line: string) => boolean;
    let fixed: boolean;
    if (options.regex) {
      let re: RegExp;
      try {
        re = new RegExp(rawQuery, "i");
      } catch {
        return options.emptyMessage; // invalid regex → treat as no matches
      }
      matcher = (line) => re.test(line);
      fixed = false;
    } else {
      const q = rawQuery.toLowerCase();
      matcher = (line) => line.toLowerCase().includes(q);
      fixed = true;
    }

    // ripgrep narrows to files that actually contain a match (native, fast);
    // fall back to globbing every candidate file when rg isn't available.
    let files = await rgFilesWithMatches(session.root, {
      pattern: rawQuery,
      fixed,
      ignoreCase: true,
      includeGlobs: options.patterns,
    });
    if (files === null) {
      files = await cachedGlob(session.root, [...options.patterns, ...EXCLUDES], {
        absolute: true,
        onlyFiles: true,
      });
    }
    files.sort();

    const results: string[] = [];

    for (const file of files) {
      const relativePath = path.relative(session.root, file);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) continue;

      const raw = await readFile(file, "utf8");
      if (raw.length > 250_000) continue;

      const lines = raw.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (matcher(line)) {
          const start = Math.max(0, i - options.contextLines);
          const end = Math.min(lines.length, i + options.contextLines + 1);
          const snippet = lines.slice(start, end).join("\n");
          results.push(`File: ${relativePath}\nLines: ${start + 1}-${end}\n\n${snippet}`);
          if (!options.matchAll) break;
        }
      }

      if (results.length >= options.maxResults) break;
    }

    return results.length > 0
      ? untrusted(results.join("\n\n---\n\n"))
      : options.emptyMessage;
  };

  // ── tools/list (filtered to the session's enabled capabilities) ────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = getToolDefinitions().filter((t) => {
      const need = TOOL_CAPS[t.name];
      return !need || session.caps.has(need);
    });
    return { tools };
  });

  // ── tools/call ─────────────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = getArgs(request);

    // Capability guard — block disabled tiers before doing any work.
    const denied = capabilityError(session, toolName);
    if (denied) {
      return { content: [{ type: "text", text: denied }], isError: true };
    }

    // ── web / browse tools (fetch_url, web_search, browse_page, screenshot) ────
    if (isWebTool(toolName)) {
      return handleWebTool(toolName, args, session);
    }

    // ── set_repo_root ─────────────────────────────────────────────────────────
    if (toolName === "set_repo_root") {
      const inputPath = String(args.path ?? "").trim();
      if (!inputPath) throw new Error("path is required (absolute path to a repo root).");

      const resolved = confineRoot(session, path.resolve(inputPath));
      let info;
      try {
        info = await stat(resolved);
      } catch {
        throw new Error(`Path does not exist: ${resolved}`);
      }
      if (!info.isDirectory()) throw new Error(`Not a directory: ${resolved}`);

      session.root = resolved;
      return { content: [{ type: "text", text: `Active repo root set to: ${session.root}` }] };
    }

    // ── get_project_tree ──────────────────────────────────────────────────────
    if (toolName === "get_project_tree") {
      const depth = clamp(args.depth, 3, 5, 1);

      const files = await cachedGlob(session.root, ["**/*", ...EXCLUDES, "!**/.claude/audits/**"], {
        onlyFiles: true,
        dot: false,
      });

      const trimmed = files
        .filter((f) => f.split(/[\\/]/).length <= depth)
        .slice(0, 300)
        .sort()
        .join("\n");

      return { content: [{ type: "text", text: `Repo root: ${session.root}\n\n${trimmed}` }] };
    }

    // ── run_command ───────────────────────────────────────────────────────────
    if (toolName === "run_command") {
      const command = String(args.command ?? "").trim();
      if (!command) throw new Error("command is required.");

      const cwdArg = String(args.cwd ?? "").trim();
      const cwd = cwdArg && cwdArg !== "." ? safePath(cwdArg) : session.root;
      const timeout = clamp(args.timeoutMs, 60_000, 120_000, 1);

      try {
        const { stdout, stderr } = await exec(command, {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024,
          shell: RUN_SHELL,
        });
        const body = `${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim() || "(no output)";
        return { content: [{ type: "text", text: untrusted(`$ ${command}\n\n${body}`.slice(0, 30_000)) }] };
      } catch (error: unknown) {
        const err = error as { stdout?: string; stderr?: string; message?: string; code?: number };
        const body = `[exit ${err.code ?? "?"}]\n${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`.trim();
        return { content: [{ type: "text", text: untrusted(`$ ${command}\n\n${body}`.slice(0, 30_000)) }] };
      }
    }

    // ── list_directory ────────────────────────────────────────────────────────
    if (toolName === "list_directory") {
      const inputPath = String(args.path ?? ".").trim() || ".";
      const dir = inputPath === "." ? session.root : safePath(inputPath);

      const entries = await readdir(dir, { withFileTypes: true });
      const lines = entries
        .filter((e) => e.name !== "node_modules" && e.name !== ".git")
        .sort((a, b) => {
          const ad = a.isDirectory() ? 0 : 1;
          const bd = b.isDirectory() ? 0 : 1;
          return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
        })
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));

      return { content: [{ type: "text", text: `${inputPath}\n\n${lines.join("\n") || "(empty)"}` }] };
    }

    // ── find_files ────────────────────────────────────────────────────────────
    if (toolName === "find_files") {
      const pattern = String(args.pattern ?? "").trim();
      if (!pattern) throw new Error("pattern is required.");
      const limit = clamp(args.limit, 200, 1000, 1);

      const files = await cachedGlob(session.root, [pattern, ...EXCLUDES], {
        onlyFiles: true,
        dot: false,
      });

      const shown = files.slice(0, limit).sort();
      const header =
        files.length > limit
          ? `${files.length} file(s) matching "${pattern}" (showing ${limit}):`
          : `${shown.length} file(s) matching "${pattern}":`;

      return { content: [{ type: "text", text: `${header}\n\n${shown.join("\n") || "(none)"}` }] };
    }

    // ── grep ──────────────────────────────────────────────────────────────────
    if (toolName === "grep") {
      const pattern = String(args.pattern ?? "");
      if (!pattern) throw new Error("pattern is required.");
      const ignoreCase = args.ignoreCase !== false;
      const maxResults = clamp(args.maxResults, 30, 100, 1);
      const globArg = String(args.glob ?? "").trim();
      const patterns = globArg
        ? [globArg]
        : ["**/*.{ts,tsx,js,jsx,mjs,cjs,json,yml,yaml,sql,prisma,css,scss,html,md,mdx}"];

      let re: RegExp;
      try {
        re = new RegExp(pattern, ignoreCase ? "i" : "");
      } catch (e) {
        throw new Error(`Invalid regex: ${(e as Error).message}`);
      }

      // ripgrep fast path — native scan, no per-file JS read.
      const rg = await rgGrep(session.root, { pattern, ignoreCase, includeGlobs: patterns, maxResults });
      if (rg !== null) {
        const text = rg.length
          ? untrusted(rg.map((m) => `${m.rel}:${m.line}: ${m.text.trim().slice(0, 200)}`).join("\n"))
          : `No matches for /${pattern}/${ignoreCase ? "i" : ""}.`;
        return { content: [{ type: "text", text }] };
      }

      // JS fallback when rg is unavailable (or rejected the pattern).
      const files = await cachedGlob(session.root, [...patterns, ...EXCLUDES], {
        absolute: true,
        onlyFiles: true,
      });

      const results: string[] = [];
      for (const file of files) {
        const rel = path.relative(session.root, file);
        if (rel.startsWith("..") || path.isAbsolute(rel)) continue;

        const raw = await readFile(file, "utf8");
        if (raw.length > 250_000) continue;

        const lines = raw.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          if (re.test(line)) {
            results.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
            if (results.length >= maxResults) break;
          }
        }
        if (results.length >= maxResults) break;
      }

      return {
        content: [
          {
            type: "text",
            text: results.length
              ? untrusted(results.join("\n"))
              : `No matches for /${pattern}/${ignoreCase ? "i" : ""}.`,
          },
        ],
      };
    }

    // ── get_package_summary ───────────────────────────────────────────────────
    if (toolName === "get_package_summary") {
      const { dir, label } = resolveModuleDir(args.module);
      const pkg = await readPackageJson(dir);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                module: label,
                name: pkg.name,
                version: pkg.version,
                scripts: pkg.scripts ?? {},
                dependencies: Object.keys(pkg.dependencies ?? {}),
                devDependencies: Object.keys(pkg.devDependencies ?? {}),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // ── read_file_range ───────────────────────────────────────────────────────
    if (toolName === "read_file_range") {
      const inputPath = String(args.path ?? "");
      const startLine = Math.max(1, Number(args.startLine ?? 1));
      const endLine = Math.min(Number(args.endLine ?? 150), startLine + 300);

      const filePath = safePath(inputPath);
      const raw = await readFile(filePath, "utf8");
      if (raw.length > 500_000) throw new Error("File too large.");

      const lines = raw.split(/\r?\n/);
      const selected = lines.slice(startLine - 1, endLine).join("\n");

      return {
        content: [
          {
            type: "text",
            text: untrusted(`File: ${inputPath}\nLines: ${startLine}-${Math.min(endLine, lines.length)}\n\n${selected}`),
          },
        ],
      };
    }

    // ── read_multiple_files ───────────────────────────────────────────────────
    if (toolName === "read_multiple_files") {
      const paths = (args.paths as string[]) ?? [];
      const maxLinesEach = clamp(args.maxLinesEach, 150, 300, 1);

      if (paths.length === 0) return { content: [{ type: "text", text: "No paths provided." }] };
      if (paths.length > 5) throw new Error("Maximum 5 files per call.");

      const parts: string[] = [];

      for (const inputPath of paths) {
        const filePath = safePath(inputPath);
        const exists = await fileExists(filePath);

        if (!exists) {
          parts.push(`File: ${inputPath}\n[NOT FOUND]`);
          continue;
        }

        const raw = await readFile(filePath, "utf8");
        if (raw.length > 500_000) {
          parts.push(`File: ${inputPath}\n[TOO LARGE TO READ]`);
          continue;
        }

        const lines = raw.split(/\r?\n/);
        const limited = lines.slice(0, maxLinesEach).join("\n");
        const truncated = lines.length > maxLinesEach ? `\n... (${lines.length - maxLinesEach} more lines)` : "";

        parts.push(`File: ${inputPath}\nLines: 1-${Math.min(maxLinesEach, lines.length)}\n\n${limited}${truncated}`);
      }

      return {
        content: [{ type: "text", text: untrusted(parts.join("\n\n═══════════════════════\n\n")) }],
      };
    }

    // ── search_code ───────────────────────────────────────────────────────────
    if (toolName === "search_code") {
      const text = await searchFiles({
        query: String(args.query ?? ""),
        patterns: [
          "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx",
          "**/*.mjs", "**/*.cjs", "**/*.json", "**/*.yml",
          "**/*.yaml", "**/*.prisma", "**/*.sql",
        ],
        maxResults: 10,
        contextLines: 4,
        emptyMessage: `No code matches found for "${String(args.query ?? "")}".`,
      });
      return { content: [{ type: "text", text }] };
    }

    // ── search_docs ───────────────────────────────────────────────────────────
    if (toolName === "search_docs") {
      const text = await searchFiles({
        query: String(args.query ?? ""),
        patterns: ["docs/**/*.md", "**/*.md", "**/*.mdx", "README*"],
        maxResults: 8,
        contextLines: 4,
        emptyMessage: `No documentation matches found for "${String(args.query ?? "")}".`,
      });
      return { content: [{ type: "text", text }] };
    }

    // ── read_doc ──────────────────────────────────────────────────────────────
    if (toolName === "read_doc") {
      const inputPath = String(args.path ?? "");
      const maxLines = clamp(args.maxLines, 120, 300, 1);

      if (!inputPath.match(/\.(md|mdx|txt)$/i)) {
        throw new Error("read_doc supports .md, .mdx, and .txt files only.");
      }

      const filePath = safePath(inputPath);
      const raw = await readFile(filePath, "utf8");
      if (raw.length > 500_000) throw new Error("File too large.");

      const lines = raw.split(/\r?\n/);
      const limited = lines.slice(0, maxLines).join("\n");

      return {
        content: [
          {
            type: "text",
            text: untrusted(`File: ${inputPath}\nLines: 1-${Math.min(maxLines, lines.length)}\n\n${limited}`),
          },
        ],
      };
    }

    // ── find_api_endpoint ─────────────────────────────────────────────────────
    if (toolName === "find_api_endpoint") {
      const text = await searchFiles({
        query: String(args.query ?? ""),
        patterns: [
          "**/routes/**/*.ts", "**/routes/**/*.tsx",
          "**/controllers/**/*.ts", "**/api/**/*.ts",
          "**/app/**/*.ts", "**/pages/api/**/*.ts", "**/*.ts",
        ],
        maxResults: 10,
        contextLines: 5,
        emptyMessage: `No API endpoint matches found for "${String(args.query ?? "")}".`,
      });
      return { content: [{ type: "text", text }] };
    }

    // ── find_schema ───────────────────────────────────────────────────────────
    if (toolName === "find_schema") {
      const text = await searchFiles({
        query: String(args.query ?? ""),
        patterns: [
          "**/schema.ts", "**/schemas.ts", "**/types/**/*.ts",
          "**/db/**/*.ts", "**/*.prisma", "**/*.sql", "**/*.zod.ts",
        ],
        maxResults: 10,
        contextLines: 5,
        emptyMessage: `No schema matches found for "${String(args.query ?? "")}".`,
      });
      return { content: [{ type: "text", text }] };
    }

    // ── find_references ───────────────────────────────────────────────────────
    if (toolName === "find_references") {
      const symbol = String(args.symbol ?? "");
      const text = await searchFiles({
        query: symbol,
        patterns: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
        maxResults: 15,
        contextLines: 3,
        matchAll: true,
        emptyMessage: `No references found for "${symbol}".`,
      });
      return { content: [{ type: "text", text }] };
    }

    // ── find_exports ──────────────────────────────────────────────────────────
    if (toolName === "find_exports") {
      const name = String(args.name ?? "");
      const text = await searchFiles({
        query: `export.*${name}`,
        regex: true,
        patterns: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
        maxResults: 10,
        contextLines: 2,
        emptyMessage: `No exports found for "${name}".`,
      });
      return { content: [{ type: "text", text }] };
    }

    // ── get_audit_summaries ───────────────────────────────────────────────────
    if (toolName === "get_audit_summaries") {
      const moduleFilter = String(args.module ?? "").toLowerCase();
      const maxLinesEach = clamp(args.maxLinesEach, 120, 300, 1);

      const auditDir = path.join(session.root, ".claude", "audits");
      if (!(await fileExists(auditDir))) {
        return { content: [{ type: "text", text: "No .claude/audits/ directory found in this repo." }] };
      }

      const files = await fg([".claude/audits/**/*.md"], {
        cwd: session.root,
        absolute: true,
        onlyFiles: true,
      });

      const filtered = moduleFilter
        ? files.filter((f) => path.basename(f).toLowerCase().includes(moduleFilter))
        : files;

      if (filtered.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: moduleFilter ? `No audit files found matching "${moduleFilter}".` : "No audit files found.",
            },
          ],
        };
      }

      const parts: string[] = [];
      for (const file of filtered.sort()) {
        const relativePath = path.relative(session.root, file);
        const raw = await readFile(file, "utf8");
        const lines = raw.split(/\r?\n/);
        const limited = lines.slice(0, maxLinesEach).join("\n");
        const truncated = lines.length > maxLinesEach
          ? `\n... (${lines.length - maxLinesEach} more lines — use read_file_range to read further)`
          : "";
        parts.push(`Audit: ${relativePath}\n\n${limited}${truncated}`);
      }

      return {
        content: [{ type: "text", text: untrusted(parts.join("\n\n═══════════════════════\n\n")) }],
      };
    }

    // ── search_audits ─────────────────────────────────────────────────────────
    if (toolName === "search_audits") {
      const text = await searchFiles({
        query: String(args.query ?? ""),
        patterns: [".claude/audits/**/*.md"],
        maxResults: 10,
        contextLines: 4,
        matchAll: true,
        emptyMessage: `No audit findings matched "${String(args.query ?? "")}".`,
      });
      return { content: [{ type: "text", text }] };
    }

    // ── get_project_context ───────────────────────────────────────────────────
    if (toolName === "get_project_context") {
      const maxLinesEach = clamp(args.maxLinesEach, 60, 200, 1);

      const candidates = [
        "log.txt",
        "my thoughts.txt",
        "notes.txt",
        "NOTES.md",
        "TODO.md",
        ".claude/notes.md",
        ".claude/context.md",
      ];

      const parts: string[] = [];

      for (const candidate of candidates) {
        const filePath = path.join(session.root, candidate);
        if (await fileExists(filePath)) {
          const raw = await readFile(filePath, "utf8");
          const lines = raw.split(/\r?\n/);
          const limited = lines.slice(0, maxLinesEach).join("\n");
          const truncated = lines.length > maxLinesEach ? `\n... (${lines.length - maxLinesEach} more lines)` : "";
          parts.push(`File: ${candidate}\n\n${limited}${truncated}`);
        }
      }

      const notesDir = path.join(session.root, ".claude", "notes");
      if (await fileExists(notesDir)) {
        const noteFiles = await fg([".claude/notes/**/*.md", ".claude/notes/**/*.txt"], {
          cwd: session.root,
          absolute: true,
          onlyFiles: true,
        });
        for (const file of noteFiles.slice(0, 5)) {
          const relativePath = path.relative(session.root, file);
          const raw = await readFile(file, "utf8");
          const lines = raw.split(/\r?\n/);
          const limited = lines.slice(0, maxLinesEach).join("\n");
          parts.push(`File: ${relativePath}\n\n${limited}`);
        }
      }

      if (parts.length === 0) {
        return {
          content: [{ type: "text", text: "No project context files found (log.txt, notes, .claude/notes/)." }],
        };
      }

      return {
        content: [{ type: "text", text: untrusted(parts.join("\n\n═══════════════════════\n\n")) }],
      };
    }

    // ── get_git_status ────────────────────────────────────────────────────────
    if (toolName === "get_git_status") {
      const commits = clamp(args.commits, 10, 30, 1);
      const includeDiff = Boolean(args.includeDiff ?? false);

      const statusOut = await runCommand("git status --short");
      const logOut = await runCommand(`git log --oneline --decorate -n ${commits}`);
      const branchOut = await runCommand("git branch --show-current");

      const parts = [
        `Branch: ${branchOut.trim()}`,
        `\nStatus:\n${statusOut || "(clean)"}`,
        `\nRecent commits:\n${logOut}`,
      ];

      if (includeDiff) {
        const diffOut = await runCommand("git diff --staged");
        if (diffOut) parts.push(`\nStaged diff:\n${diffOut.slice(0, 5_000)}`);
      }

      return { content: [{ type: "text", text: parts.join("\n") }] };
    }

    // ── get_recent_changes ────────────────────────────────────────────────────
    if (toolName === "get_recent_changes") {
      const commits = clamp(args.commits, 3, 10, 1);

      const output = await runCommand(`git log --oneline -n ${commits} --name-only`);
      const diffOutput = await runCommand(`git diff HEAD~${commits} HEAD --stat`);

      return {
        content: [
          {
            type: "text",
            text: `Recent ${commits} commits (files changed):\n${output}\n\nDiff stat:\n${diffOutput}`,
          },
        ],
      };
    }

    // ── get_env_vars ──────────────────────────────────────────────────────────
    if (toolName === "get_env_vars") {
      const envFiles = [".env", ".env.example", ".env.local", ".env.development", ".env.production"];
      const parts: string[] = [];

      for (const envFile of envFiles) {
        const filePath = path.join(session.root, envFile);
        if (!(await fileExists(filePath))) continue;

        const raw = await readFile(filePath, "utf8");
        const lines = raw.split(/\r?\n/);
        const keys = lines
          .filter((l) => l.trim() && !l.startsWith("#"))
          .map((l) => l.split("=")[0]?.trim() ?? l);

        parts.push(`${envFile}:\n${keys.join("\n")}`);
      }

      if (parts.length === 0) {
        return { content: [{ type: "text", text: "No .env files found." }] };
      }

      return {
        content: [
          {
            type: "text",
            text: `Environment variable keys (values omitted for security):\n\n${parts.join("\n\n")}`,
          },
        ],
      };
    }

    // ── get_typecheck_errors ──────────────────────────────────────────────────
    if (toolName === "get_typecheck_errors") {
      const { dir, label } = resolveModuleDir(args.module);
      const pkg = await readPackageJson(dir);
      const scripts = pkg.scripts ?? {};

      const command = scripts.typecheck
        ? "npm run typecheck"
        : scripts.build
          ? "npm run build"
          : "npx tsc --noEmit";

      const output = await runCommand(command, dir);
      return { content: [{ type: "text", text: `Module: ${label}\nCommand: ${command}\n\n${output}` }] };
    }

    // ── get_test_failures ─────────────────────────────────────────────────────
    if (toolName === "get_test_failures") {
      const { dir, label } = resolveModuleDir(args.module);
      await readPackageJson(dir);
      const output = await runCommand("npm test", dir);
      return { content: [{ type: "text", text: `Module: ${label}\nCommand: npm test\n\n${output}` }] };
    }

    // ── find_todos ────────────────────────────────────────────────────────────
    if (toolName === "find_todos") {
      const patterns = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.md", "**/*.mdx"];
      const allResults: string[] = [];

      for (const keyword of ["todo", "fixme", "hack", "note:"]) {
        const text = await searchFiles({
          query: keyword,
          patterns,
          maxResults: 10,
          contextLines: 2,
          matchAll: true,
          emptyMessage: "",
        });
        if (text && !text.includes("No ")) {
          allResults.push(`## ${keyword.toUpperCase()}\n\n${text}`);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: allResults.length > 0
              ? untrusted(allResults.join("\n\n"))
              : "No TODO/FIXME/HACK/NOTE comments found.",
          },
        ],
      };
    }

    // ── run_script ────────────────────────────────────────────────────────────
    if (toolName === "run_script") {
      const scriptName = String(args.script ?? "");
      const { dir, label } = resolveModuleDir(args.module);

      const pkg = await readPackageJson(dir);
      const scripts = pkg.scripts ?? {};

      if (!scripts[scriptName]) {
        const available = Object.keys(scripts).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Script "${scriptName}" not found in ${label === "." ? "root" : label} package.json.\n\nAvailable scripts: ${available}`,
            },
          ],
        };
      }

      const output = await runCommand(`npm run ${scriptName}`, dir);
      return { content: [{ type: "text", text: `Module: ${label}\nnpm run ${scriptName}\n\n${output}` }] };
    }

    // ── write_file ────────────────────────────────────────────────────────────
    if (toolName === "write_file") {
      const inputPath = String(args.path ?? "");
      const content = String(args.content ?? "");
      if (!inputPath) throw new Error("path is required.");

      const filePath = safePath(inputPath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
      invalidateGlobCache();

      const lineCount = content.split(/\r?\n/).length;
      return { content: [{ type: "text", text: `Written: ${inputPath} (${lineCount} lines)` }] };
    }

    // ── edit_file ─────────────────────────────────────────────────────────────
    if (toolName === "edit_file") {
      const inputPath = String(args.path ?? "");
      const oldStr = String(args.oldStr ?? "");
      const newStr = String(args.newStr ?? "");

      if (!inputPath) throw new Error("path is required.");
      if (!oldStr) throw new Error("oldStr is required.");

      const filePath = safePath(inputPath);
      const raw = await readFile(filePath, "utf8");
      const occurrences = raw.split(oldStr).length - 1;

      if (occurrences === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Edit failed: oldStr not found in ${inputPath}.\n\nTip: read_file_range first to confirm the exact content, then retry.`,
            },
          ],
        };
      }
      if (occurrences > 1) {
        return {
          content: [
            {
              type: "text",
              text: `Edit failed: oldStr matched ${occurrences} times in ${inputPath} — it must be unique.\n\nTip: include more surrounding lines in oldStr to make it unique.`,
            },
          ],
        };
      }

      const updated = raw.replace(oldStr, newStr);
      await writeFile(filePath, updated, "utf8");
      invalidateGlobCache();

      const action = newStr === "" ? "Deleted block" : "Replaced";
      return {
        content: [
          {
            type: "text",
            text: `${action} in ${inputPath}. Lines before: ${raw.split(/\r?\n/).length}, after: ${updated.split(/\r?\n/).length}.`,
          },
        ],
      };
    }

    // ── delete_file ───────────────────────────────────────────────────────────
    if (toolName === "delete_file") {
      const inputPath = String(args.path ?? "");
      const confirm = Boolean(args.confirm);
      if (!inputPath) throw new Error("path is required.");

      if (!confirm) {
        return { content: [{ type: "text", text: `Deletion refused: confirm must be true to delete ${inputPath}.` }] };
      }

      const filePath = safePath(inputPath);
      if (!(await fileExists(filePath))) {
        return { content: [{ type: "text", text: `File not found: ${inputPath}` }] };
      }

      await unlink(filePath);
      invalidateGlobCache();
      return { content: [{ type: "text", text: `Deleted: ${inputPath}` }] };
    }

    throw new Error(`Unknown tool: ${toolName}`);
  });

  return server;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

function chooseTransport(): Transport {
  if (process.argv.includes("--http")) return "http";
  if (process.argv.includes("--stdio")) return "stdio";
  return process.env.MCP_TRANSPORT === "http" ? "http" : "stdio";
}

async function main() {
  const transport = chooseTransport();

  if (transport === "http") {
    const { startHttpServer } = await import("./http.js");
    await startHttpServer({ createServer, makeSession });
    return;
  }

  const session = makeSession("stdio");
  const server = createServer(session);
  const t = new StdioServerTransport();
  await server.connect(t);
  console.error(`dev-context-mcp v3 running (stdio, full power). Repo root: ${session.root}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
