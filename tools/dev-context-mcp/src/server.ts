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
import { exec as execCb, spawnSync } from "node:child_process";
import { promisify } from "node:util";

import { EXCLUDES, untrusted, fileExists, safePathIn, clamp, clip, execErrorText } from "./util.js";
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

// Source-file extensions searched by code tools (brace-expansion body for globs).
// find_exports keeps its JS/TS-only globs since it matches `export` syntax.
const CODE_EXTS = "ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,cs,rb,php,swift,vue,svelte,sh";

// Shell used by the run_command tool. Override with MCP_SHELL.
//   macOS/Linux: /bin/sh
//   Windows:     Git Bash when installed (POSIX commands behave the same as on
//                other OSes), otherwise Node's default (cmd.exe via ComSpec).
// On Windows we never pick System32\bash.exe: that is the WSL launcher, which
// runs commands inside Linux where Windows paths do not resolve.
function resolveRunShell(): string | undefined {
  if (process.env.MCP_SHELL) return process.env.MCP_SHELL;
  if (process.platform !== "win32") return "/bin/sh";

  const candidates: string[] = [];
  for (const base of [process.env.ProgramFiles, process.env["ProgramW6432"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")]) {
    if (base) candidates.push(path.join(base, "Git", "bin", "bash.exe"));
  }
  const where = spawnSync("where", ["bash"], { encoding: "utf8", windowsHide: true });
  if (where.status === 0) candidates.push(...where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));

  const isWslLauncher = (p: string) => /\\windows\\(system32|sysnative)\\/i.test(p) || /\\windowsapps\\/i.test(p);
  return candidates.find((p) => !isWslLauncher(p) && existsSync(p));
}

const RUN_SHELL = resolveRunShell();

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
//   2. nearest git root above the launch cwd  (auto-detect, "works for any repo")
//   3. the launch cwd itself  (fallback for non-git dirs)
export function resolveInitialRoot(): string {
  return process.env.REPO_ROOT
    ? path.resolve(process.env.REPO_ROOT)
    : detectRepoRoot(process.cwd());
}

// Build a fresh, independent session for a transport. Each HTTP connection gets
// its own, so one client's set_repo_root can never affect another's.
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

  // ── Per-session helpers ─────────────────────────────────────────────────────

  // Resolve per-call repoRoot override (validated through confineRoot) or fall
  // back to the session default. Every repo-aware handler calls this first.
  const resolveRoot = (args: Record<string, unknown>): string => {
    const override = String(args.repoRoot ?? "").trim();
    if (!override) return session.root;
    return confineRoot(session, path.resolve(override));
  };

  const safePath = (root: string, inputPath: string) => safePathIn(root, inputPath);

  const resolveModuleDir = (root: string, input?: unknown): { dir: string; label: string } => {
    const raw = String(input ?? "").trim();
    if (!raw || raw === ".") return { dir: root, label: "." };
    return { dir: safePath(root, raw), label: raw };
  };

  const readPackageJson = async (root: string, dir: string) => {
    const packagePath = path.join(dir, "package.json");
    const relative = path.relative(root, packagePath);
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
      const body = `${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
      return clip(body || "Command completed with no output.", 20_000);
    } catch (error: unknown) {
      return clip(execErrorText(error), 20_000);
    }
  };

  const searchFiles = async (root: string, options: {
    query: string;
    patterns: string[];
    maxResults: number;
    contextLines: number;
    emptyMessage: string;
    matchAll?: boolean;
    regex?: boolean;
    /** Return results without the untrusted prefix (caller wraps once). */
    raw?: boolean;
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
    let files = await rgFilesWithMatches(root, {
      pattern: rawQuery,
      fixed,
      ignoreCase: true,
      includeGlobs: options.patterns,
    });
    if (files === null) {
      files = await cachedGlob(root, [...options.patterns, ...EXCLUDES], {
        absolute: true,
        onlyFiles: true,
      });
    }
    files.sort();

    const results: string[] = [];

    for (const file of files) {
      const relativePath = path.relative(root, file);
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

    if (results.length === 0) return options.emptyMessage;
    const joined = results.slice(0, options.maxResults).join("\n\n---\n\n");
    return options.raw ? joined : untrusted(joined);
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

    // Capability guard, block disabled tiers before doing any work.
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
      const root = resolveRoot(args);
      const depth = clamp(args.depth, 3, 5, 1);

      const files = await cachedGlob(root, ["**/*", ...EXCLUDES, "!**/.claude/audits/**"], {
        onlyFiles: true,
        dot: false,
      });

      const inDepth = files.filter((f) => f.split(/[\\/]/).length <= depth).sort();
      const trimmed = inDepth.slice(0, 300).join("\n");
      const more = inDepth.length > 300
        ? `\n\n(${inDepth.length - 300} more files; lower depth or use list_directory/find_files)`
        : "";

      return { content: [{ type: "text", text: `Repo root: ${root}\n\n${trimmed}${more}` }] };
    }

    // ── run_command ───────────────────────────────────────────────────────────
    if (toolName === "run_command") {
      const root = resolveRoot(args);
      const command = String(args.command ?? "").trim();
      if (!command) throw new Error("command is required.");

      const cwdArg = String(args.cwd ?? "").trim();
      const cwd = cwdArg && cwdArg !== "." ? safePath(root, cwdArg) : root;
      const timeout = clamp(args.timeoutMs, 60_000, 120_000, 1);

      try {
        const { stdout, stderr } = await exec(command, {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024,
          shell: RUN_SHELL,
        });
        const body = `${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim() || "(no output)";
        return { content: [{ type: "text", text: untrusted(`$ ${command}\n\n${clip(body, 30_000)}`) }] };
      } catch (error: unknown) {
        return { content: [{ type: "text", text: untrusted(`$ ${command}\n\n${clip(execErrorText(error), 30_000)}`) }] };
      }
    }

    // ── list_directory ────────────────────────────────────────────────────────
    if (toolName === "list_directory") {
      const root = resolveRoot(args);
      const inputPath = String(args.path ?? ".").trim() || ".";
      const dir = inputPath === "." ? root : safePath(root, inputPath);

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
      const root = resolveRoot(args);
      const pattern = String(args.pattern ?? "").trim();
      if (!pattern) throw new Error("pattern is required.");
      const limit = clamp(args.limit, 200, 1000, 1);

      const files = await cachedGlob(root, [pattern, ...EXCLUDES], {
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
      const root = resolveRoot(args);
      const pattern = String(args.pattern ?? "");
      if (!pattern) throw new Error("pattern is required.");
      const ignoreCase = args.ignoreCase !== false;
      const maxResults = clamp(args.maxResults, 30, 100, 1);
      const globArg = String(args.glob ?? "").trim();
      const patterns = globArg
        ? [globArg]
        : [`**/*.{${CODE_EXTS},json,yml,yaml,toml,sql,prisma,css,scss,html,md,mdx}`];

      let re: RegExp;
      try {
        re = new RegExp(pattern, ignoreCase ? "i" : "");
      } catch (e) {
        throw new Error(`Invalid regex: ${(e as Error).message}`);
      }

      // ripgrep fast path, native scan, no per-file JS read.
      const rg = await rgGrep(root, { pattern, ignoreCase, includeGlobs: patterns, maxResults });
      if (rg !== null) {
        const text = rg.length
          ? untrusted(rg.map((m) => `${m.rel}:${m.line}: ${m.text.trim().slice(0, 200)}`).join("\n"))
          : `No matches for /${pattern}/${ignoreCase ? "i" : ""}.`;
        return { content: [{ type: "text", text }] };
      }

      // JS fallback when rg is unavailable (or rejected the pattern).
      const files = await cachedGlob(root, [...patterns, ...EXCLUDES], {
        absolute: true,
        onlyFiles: true,
      });

      const results: string[] = [];
      for (const file of files) {
        const rel = path.relative(root, file);
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
      const root = resolveRoot(args);
      const { dir, label } = resolveModuleDir(root, args.module);
      const pkg = await readPackageJson(root, dir);

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
              }
            ),
          },
        ],
      };
    }

    // ── read_file_range ───────────────────────────────────────────────────────
    if (toolName === "read_file_range") {
      const root = resolveRoot(args);
      const inputPath = String(args.path ?? "");
      const startLine = Math.max(1, Math.floor(Number(args.startLine ?? 1)) || 1);
      // Default window is 150 lines from startLine (not a fixed line 150, which
      // returned nothing for any startLine past 150). Hard cap: 300 lines.
      const requestedEnd = Math.floor(Number(args.endLine ?? startLine + 149)) || startLine + 149;
      const endLine = Math.min(Math.max(requestedEnd, startLine), startLine + 299);

      const filePath = safePath(root, inputPath);
      const raw = await readFile(filePath, "utf8");
      if (raw.length > 500_000) throw new Error("File too large.");

      const lines = raw.split(/\r?\n/);
      if (startLine > lines.length) {
        return { content: [{ type: "text", text: `File: ${inputPath} has only ${lines.length} lines (requested from ${startLine}).` }] };
      }
      const selected = lines.slice(startLine - 1, endLine).join("\n");
      const shownEnd = Math.min(endLine, lines.length);
      const more = shownEnd < lines.length ? `\n... (${lines.length - shownEnd} more lines)` : "";

      return {
        content: [
          {
            type: "text",
            text: untrusted(`File: ${inputPath}\nLines: ${startLine}-${shownEnd} of ${lines.length}\n\n${selected}${more}`),
          },
        ],
      };
    }

    // ── read_multiple_files ───────────────────────────────────────────────────
    if (toolName === "read_multiple_files") {
      const root = resolveRoot(args);
      const paths = (args.paths as string[]) ?? [];
      const maxLinesEach = clamp(args.maxLinesEach, 150, 300, 1);

      if (paths.length === 0) return { content: [{ type: "text", text: "No paths provided." }] };
      if (paths.length > 5) throw new Error("Maximum 5 files per call.");

      const parts: string[] = [];

      for (const inputPath of paths) {
        const filePath = safePath(root, inputPath);
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
      const root = resolveRoot(args);
      const text = await searchFiles(root, {
        query: String(args.query ?? ""),
        patterns: [`**/*.{${CODE_EXTS},json,yml,yaml,toml,prisma,sql}`],
        maxResults: 10,
        contextLines: 4,
        emptyMessage: `No code matches found for "${String(args.query ?? "")}".`,
      });
      return { content: [{ type: "text", text }] };
    }

    // ── search_docs ───────────────────────────────────────────────────────────
    if (toolName === "search_docs") {
      const root = resolveRoot(args);
      const text = await searchFiles(root, {
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
      const root = resolveRoot(args);
      const inputPath = String(args.path ?? "");
      const maxLines = clamp(args.maxLines, 120, 300, 1);

      if (!inputPath.match(/\.(md|mdx|txt)$/i)) {
        throw new Error("read_doc supports .md, .mdx, and .txt files only.");
      }

      const filePath = safePath(root, inputPath);
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
      const root = resolveRoot(args);
      const text = await searchFiles(root, {
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
      const root = resolveRoot(args);
      const text = await searchFiles(root, {
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
      const root = resolveRoot(args);
      const symbol = String(args.symbol ?? "");
      const text = await searchFiles(root, {
        query: symbol,
        patterns: [`**/*.{${CODE_EXTS}}`],
        maxResults: 15,
        contextLines: 3,
        matchAll: true,
        emptyMessage: `No references found for "${symbol}".`,
      });
      return { content: [{ type: "text", text }] };
    }

    // ── find_exports ──────────────────────────────────────────────────────────
    if (toolName === "find_exports") {
      const root = resolveRoot(args);
      const name = String(args.name ?? "");
      const text = await searchFiles(root, {
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
      const root = resolveRoot(args);
      const moduleFilter = String(args.module ?? "").toLowerCase();
      const maxLinesEach = clamp(args.maxLinesEach, 120, 300, 1);

      const auditDir = path.join(root, ".claude", "audits");
      if (!(await fileExists(auditDir))) {
        return { content: [{ type: "text", text: "No .claude/audits/ directory found in this repo." }] };
      }

      const files = await fg([".claude/audits/**/*.md"], {
        cwd: root,
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
        const relativePath = path.relative(root, file);
        const raw = await readFile(file, "utf8");
        const lines = raw.split(/\r?\n/);
        const limited = lines.slice(0, maxLinesEach).join("\n");
        const truncated = lines.length > maxLinesEach
          ? `\n... (${lines.length - maxLinesEach} more lines, use read_file_range to read further)`
          : "";
        parts.push(`Audit: ${relativePath}\n\n${limited}${truncated}`);
      }

      return {
        content: [{ type: "text", text: untrusted(parts.join("\n\n═══════════════════════\n\n")) }],
      };
    }

    // ── search_audits ─────────────────────────────────────────────────────────
    if (toolName === "search_audits") {
      const root = resolveRoot(args);
      const text = await searchFiles(root, {
        query: String(args.query ?? ""),
        patterns: [".claude/audits/**/*.md"],
        maxResults: 10,
        contextLines: 4,
        matchAll: true,
        emptyMessage: `No audit findings matched "${String(args.query ?? "")}".`,
      });
      return { content: [{ type: "text", text }] };
    }

    // ── get_architecture_docs ───────────────────────────────────────────────
    if (toolName === "get_architecture_docs") {
      const root = resolveRoot(args);
      const CURATED_DIRS = [".claude/docs", "docs/architecture", "docs/adr"];
      const DOC_GLOBS = CURATED_DIRS.map((d) => `${d}/**/*.md`);

      // Classify by path
      const classifyType = (relPath: string): string => {
        if (relPath.startsWith("docs/adr")) return "adr";
        if (relPath.startsWith("docs/architecture")) return "architecture";
        return "guide";
      };

      // Extract title from first heading or filename
      const extractTitle = (content: string, relPath: string): string => {
        const headingMatch = content.match(/^#\s+(.+)/m);
        if (headingMatch?.[1]) return headingMatch[1].trim();
        return path.basename(relPath, ".md").replace(/[-_]/g, " ");
      };

      // Extract summary: first non-heading, non-empty paragraph (up to 200 chars)
      const extractSummary = (content: string): string => {
        const lines = content.split(/\r?\n/);
        const paras: string[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---")) continue;
          paras.push(trimmed);
          if (paras.join(" ").length >= 200) break;
        }
        const summary = paras.join(" ");
        return summary.length > 200 ? summary.slice(0, 200) + "..." : summary;
      };

      // Extract key rules: lines starting with - or * that contain "must", "never", "always", "do not", "required"
      const RULE_PATTERN = /\b(must|never|always|do not|don't|required|shall not|forbidden|prohibited)\b/i;
      const extractKeyRules = (content: string): string[] => {
        const rules: string[] = [];
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if ((trimmed.startsWith("- ") || trimmed.startsWith("* ")) && RULE_PATTERN.test(trimmed)) {
            rules.push(trimmed.slice(2).trim());
            if (rules.length >= 5) break;
          }
        }
        return rules;
      };

      // Single-doc mode: return full content (capped)
      const requestedPath = args.path ? String(args.path) : null;
      if (requestedPath) {
        const safe = safePathIn(root, requestedPath);
        if (!safe) {
          return { content: [{ type: "text", text: `Path "${requestedPath}" is outside the repo root.` }], isError: true };
        }
        const inCurated = CURATED_DIRS.some((d) => requestedPath.startsWith(d));
        if (!inCurated) {
          return {
            content: [{ type: "text", text: `Path "${requestedPath}" is not in a curated docs directory (${CURATED_DIRS.join(", ")}).` }],
            isError: true,
          };
        }
        if (!(await fileExists(safe))) {
          return { content: [{ type: "text", text: `Document not found: ${requestedPath}` }], isError: true };
        }
        const raw = await readFile(safe, "utf8");
        const title = extractTitle(raw, requestedPath);
        const docType = classifyType(requestedPath);
        const keyRules = extractKeyRules(raw);
        const capped = raw.length > 16_000 ? raw.slice(0, 16_000) + "\n... (truncated to ~4,000 tokens)" : raw;
        const result = { title, path: requestedPath, type: docType, keyRules, content: capped };
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      // Index mode: list all curated docs with summaries
      const allFiles = await fg(DOC_GLOBS, { cwd: root, absolute: true, onlyFiles: true });

      if (allFiles.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              source: "curated-docs",
              documents: [],
              note: `No architecture docs found in curated paths: ${CURATED_DIRS.join(", ")}`,
            }),
          }],
        };
      }

      const documents: { title: string; path: string; type: string; summary: string; keyRules: string[] }[] = [];
      let totalSize = 0;
      for (const absPath of allFiles.sort()) {
        if (totalSize > 14_000) break;
        const relPath = path.relative(root, absPath).replace(/\\/g, "/");
        const raw = await readFile(absPath, "utf8");
        const title = extractTitle(raw, relPath);
        const docType = classifyType(relPath);
        const summary = extractSummary(raw);
        const keyRules = extractKeyRules(raw);
        const entry = { title, path: relPath, type: docType, summary, keyRules };
        const entryJson = JSON.stringify(entry);
        totalSize += entryJson.length;
        documents.push(entry);
      }

      const result = { source: "curated-docs", documents };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    // ── get_project_manifest ──────────────────────────────────────────────────
    if (toolName === "get_project_manifest") {
      const root = resolveRoot(args);
      // 1. Try explicit manifest files
      const manifestCandidates = [
        path.join(root, ".claude", "manifest.json"),
        path.join(root, ".claude", "project.json"),
      ];

      const SECRET_KEYS = /secret|password|token|credential|api.?key|database.?url|connection.?string|smtp.?pass|private.?key|jwt|session.?secret|auth.?secret/i;
      const redact = (obj: unknown): unknown =>
        JSON.parse(JSON.stringify(obj, (k, v) => {
          if (SECRET_KEYS.test(k) && typeof v === "string") return "[REDACTED]";
          return v;
        }));
      const cap = (json: string): string =>
        json.length > 16_000 ? json.slice(0, 16_000) + "\n... (truncated to ~4,000 tokens)" : json;

      for (const candidate of manifestCandidates) {
        if (await fileExists(candidate)) {
          try {
            const raw = await readFile(candidate, "utf8");
            const parsed = JSON.parse(raw);
            if (!parsed.source) parsed.source = "manifest";
            const output = cap(JSON.stringify(redact(parsed)));
            return { content: [{ type: "text", text: output }] };
          } catch {
            // Malformed JSON - fall through to auto-detection
          }
        }
      }

      // 2. Auto-detect from package.json + directory structure
      const manifest: Record<string, unknown> = { source: "auto-detected" };

      // Package.json
      const pkgPath = path.join(root, "package.json");
      if (await fileExists(pkgPath)) {
        try {
          const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
          manifest.name = pkg.name || path.basename(root);
          manifest.version = pkg.version;
          manifest.description = pkg.description;

          // Stack detection from dependencies
          const allDeps = {
            ...pkg.dependencies,
            ...pkg.devDependencies,
          };
          const stack: string[] = [];
          if (allDeps.react || allDeps["react-dom"]) stack.push("React");
          if (allDeps.next) stack.push("Next.js");
          if (allDeps.vue) stack.push("Vue");
          if (allDeps.svelte) stack.push("Svelte");
          if (allDeps.express) stack.push("Express");
          if (allDeps.fastify) stack.push("Fastify");
          if (allDeps.hono) stack.push("Hono");
          if (allDeps["@nestjs/core"]) stack.push("NestJS");
          if (allDeps.prisma || allDeps["@prisma/client"]) stack.push("Prisma");
          if (allDeps.drizzle || allDeps["drizzle-orm"]) stack.push("Drizzle");
          if (allDeps.knex) stack.push("Knex");
          if (allDeps.tailwindcss) stack.push("Tailwind");
          if (allDeps.typescript || allDeps.tsx) stack.push("TypeScript");
          if (allDeps["expo"] || allDeps["react-native"]) stack.push("React Native");
          if (allDeps.bullmq) stack.push("BullMQ");
          if (allDeps.ioredis || allDeps.redis) stack.push("Redis");
          if (allDeps.docker || existsSync(path.join(root, "docker-compose.yml"))
              || existsSync(path.join(root, "docker-compose.yaml"))
              || existsSync(path.join(root, "Dockerfile")))
            stack.push("Docker");

          if (stack.length > 0) manifest.stack = stack;

          // Scripts
          if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
            manifest.scripts = Object.keys(pkg.scripts);
          }
        } catch {
          manifest.name = path.basename(root);
        }
      } else {
        manifest.name = path.basename(root);
      }

      // Key directories
      const DIR_LABELS: Record<string, string> = {
        src: "Frontend application source",
        lib: "Shared library code",
        app: "Application entry point",
        apps: "Monorepo application packages",
        packages: "Monorepo shared packages",
        server: "Backend server code",
        client: "Client-side code",
        api: "API layer",
        web: "Web application",
        mobile: "Mobile application",
        shared: "Shared cross-platform code",
        common: "Common utilities",
        services: "Service layer",
        components: "UI components",
        pages: "Page-level components or routes",
        routes: "Route definitions",
        middleware: "Middleware handlers",
        models: "Data models",
        schemas: "Schema definitions",
        migrations: "Database migrations",
        tests: "Test suites",
        test: "Test suites",
        __tests__: "Test suites",
        e2e: "End-to-end tests",
        scripts: "Build and utility scripts",
        config: "Configuration files",
        deploy: "Deployment configuration",
        ".claude": "Project context and audits",
      };
      const keyDirs: { path: string; description: string }[] = [];
      for (const [d, desc] of Object.entries(DIR_LABELS)) {
        if (existsSync(path.join(root, d))) keyDirs.push({ path: d, description: desc });
      }
      if (keyDirs.length > 0) manifest.directories = keyDirs;

      // Monorepo detection
      const packagesDir = path.join(root, "packages");
      const appsDir = path.join(root, "apps");
      const modules: string[] = [];
      for (const dir of [packagesDir, appsDir]) {
        if (existsSync(dir)) {
          try {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory() && !entry.name.startsWith(".")) {
                modules.push(path.relative(root, path.join(dir, entry.name)));
              }
            }
          } catch { /* skip */ }
        }
      }
      if (modules.length > 0) manifest.modules = modules;

      // Config files present
      const configFiles = [
        "tsconfig.json", ".eslintrc.json", ".eslintrc.js", "eslint.config.js",
        "prettier.config.js", ".prettierrc", "vite.config.ts", "next.config.js",
        "next.config.ts", "tailwind.config.ts", "tailwind.config.js",
        "docker-compose.yml", "docker-compose.yaml", "Dockerfile",
        ".env.example", "turbo.json", "nx.json", "pnpm-workspace.yaml",
        "drizzle.config.ts", "prisma/schema.prisma",
      ];
      const detectedConfigs: string[] = [];
      for (const f of configFiles) {
        if (existsSync(path.join(root, f))) detectedConfigs.push(f);
      }
      if (detectedConfigs.length > 0) manifest.configFiles = detectedConfigs;

      const output = cap(JSON.stringify(manifest));
      return { content: [{ type: "text", text: output }] };
    }

    // ── get_project_context ───────────────────────────────────────────────────
    if (toolName === "get_project_context") {
      const root = resolveRoot(args);
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
        const filePath = path.join(root, candidate);
        if (await fileExists(filePath)) {
          const raw = await readFile(filePath, "utf8");
          const lines = raw.split(/\r?\n/);
          const limited = lines.slice(0, maxLinesEach).join("\n");
          const truncated = lines.length > maxLinesEach ? `\n... (${lines.length - maxLinesEach} more lines)` : "";
          parts.push(`File: ${candidate}\n\n${limited}${truncated}`);
        }
      }

      const notesDir = path.join(root, ".claude", "notes");
      if (await fileExists(notesDir)) {
        const noteFiles = await fg([".claude/notes/**/*.md", ".claude/notes/**/*.txt"], {
          cwd: root,
          absolute: true,
          onlyFiles: true,
        });
        for (const file of noteFiles.slice(0, 5)) {
          const relativePath = path.relative(root, file);
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
      const root = resolveRoot(args);
      const commits = clamp(args.commits, 10, 30, 1);
      const includeDiff = Boolean(args.includeDiff ?? false);

      const statusOut = await runCommand("git status --short", root);
      const logOut = await runCommand(`git log --oneline --decorate -n ${commits}`, root);
      const branchOut = await runCommand("git branch --show-current", root);

      const parts = [
        `Branch: ${branchOut.trim()}`,
        `\nStatus:\n${statusOut || "(clean)"}`,
        `\nRecent commits:\n${logOut}`,
      ];

      if (includeDiff) {
        const diffOut = await runCommand("git diff --staged", root);
        if (diffOut) parts.push(`\nStaged diff:\n${diffOut.slice(0, 5_000)}`);
      }

      return { content: [{ type: "text", text: parts.join("\n") }] };
    }

    // ── get_recent_changes ────────────────────────────────────────────────────
    if (toolName === "get_recent_changes") {
      const root = resolveRoot(args);
      const commits = clamp(args.commits, 3, 10, 1);

      const output = await runCommand(`git log --oneline -n ${commits} --name-only`, root);
      const diffOutput = await runCommand(`git diff HEAD~${commits} HEAD --stat`, root);

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
      const root = resolveRoot(args);
      const envFiles = [".env", ".env.example", ".env.local", ".env.development", ".env.production"];
      const parts: string[] = [];

      for (const envFile of envFiles) {
        const filePath = path.join(root, envFile);
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
      const root = resolveRoot(args);
      const { dir, label } = resolveModuleDir(root, args.module);
      const pkg = await readPackageJson(root, dir);
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
      const root = resolveRoot(args);
      const { dir, label } = resolveModuleDir(root, args.module);
      await readPackageJson(root, dir);
      const output = await runCommand("npm test", dir);
      return { content: [{ type: "text", text: `Module: ${label}\nCommand: npm test\n\n${output}` }] };
    }

    // ── find_todos ────────────────────────────────────────────────────────────
    if (toolName === "find_todos") {
      const root = resolveRoot(args);
      const patterns = [`**/*.{${CODE_EXTS},md,mdx}`];
      const allResults: string[] = [];

      // Word-boundary, comment-marker style matches only, so prose like
      // "photodocument" or "a note: about" in docs does not flood the output.
      const markers: [string, string][] = [
        ["TODO", "\\bTODO\\b"],
        ["FIXME", "\\bFIXME\\b"],
        ["HACK", "\\bHACK\\b"],
        ["NOTE", "\\bNOTE:"],
      ];
      for (const [label, query] of markers) {
        const text = await searchFiles(root, {
          query,
          regex: true,
          patterns,
          maxResults: 10,
          contextLines: 1,
          matchAll: true,
          raw: true,
          emptyMessage: "",
        });
        if (text) allResults.push(`## ${label}\n\n${text}`);
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
      const root = resolveRoot(args);
      const scriptName = String(args.script ?? "");
      const { dir, label } = resolveModuleDir(root, args.module);

      const pkg = await readPackageJson(root, dir);
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
      const root = resolveRoot(args);
      const inputPath = String(args.path ?? "");
      const content = String(args.content ?? "");
      if (!inputPath) throw new Error("path is required.");

      const filePath = safePath(root, inputPath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
      invalidateGlobCache();

      const lineCount = content.split(/\r?\n/).length;
      return { content: [{ type: "text", text: `Written: ${inputPath} (${lineCount} lines)` }] };
    }

    // ── edit_file ─────────────────────────────────────────────────────────────
    if (toolName === "edit_file") {
      const root = resolveRoot(args);
      const inputPath = String(args.path ?? "");
      const oldStr = String(args.oldStr ?? "");
      const newStr = String(args.newStr ?? "");

      if (!inputPath) throw new Error("path is required.");
      if (!oldStr) throw new Error("oldStr is required.");

      const filePath = safePath(root, inputPath);
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
              text: `Edit failed: oldStr matched ${occurrences} times in ${inputPath}, it must be unique.\n\nTip: include more surrounding lines in oldStr to make it unique.`,
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
      const root = resolveRoot(args);
      const inputPath = String(args.path ?? "");
      const confirm = Boolean(args.confirm);
      if (!inputPath) throw new Error("path is required.");

      if (!confirm) {
        return { content: [{ type: "text", text: `Deletion refused: confirm must be true to delete ${inputPath}.` }] };
      }

      const filePath = safePath(root, inputPath);
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
