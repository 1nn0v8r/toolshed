// Tool definitions (the static tools/list payload). Kept separate from the
// dispatch so the list can be filtered by capability in createServer().
//
// Web/browse tools (fetch_url, web_search, browse_page, screenshot) are appended
// by getWebToolDefinitions() in src/web.ts and merged in here, so they only
// appear once their handlers exist.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getWebToolDefinitions } from "./web.js";

const moduleArg = {
  module: {
    type: "string",
    description:
      "Optional path to a module/subdirectory relative to the repo root (e.g. 'packages/api'). " +
      "Use this in monorepos where each module has its own package.json. Defaults to the repo root.",
  },
} as const;

const coreTools: Tool[] = [
  // ── Repo ────────────────────────────────────────────────────────────────
  {
    name: "set_repo_root",
    description:
      "Point the dev-context server at a different repository for the rest of this session. " +
      "Pass an absolute path to a repo root; all subsequent file/search/git/quality tools operate relative to it. " +
      "By default the server auto-detects the git root of the directory it was launched in, so you only need this to switch to a different repo (or to a subdirectory you want treated as the root).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the repo root to switch to." },
      },
      required: ["path"],
    },
  },
  // ── Shell / FS ──────────────────────────────────────────────────────────
  {
    name: "run_command",
    description:
      "Run an arbitrary shell command from the active repo root (escape hatch for anything the specialized tools don't cover). " +
      "Captures stdout+stderr, 60s default timeout. Prefer a specialized tool when one fits (get_git_status, run_script, get_typecheck_errors, search_code, grep …) — they return cleaner, structured output.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        cwd: {
          type: "string",
          description: "Optional subdirectory (relative to repo root) to run in. Defaults to the repo root.",
        },
        timeoutMs: { type: "number", description: "Timeout in milliseconds. Default 60000, max 120000." },
      },
      required: ["command"],
    },
  },
  {
    name: "list_directory",
    description:
      "List files and subdirectories directly under a path (relative to repo root). Use for targeted exploration of one folder; use get_project_tree for the whole repo.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path from repo root. Defaults to the repo root." },
      },
    },
  },
  {
    name: "find_files",
    description:
      "Find files matching a glob pattern (e.g. '**/*.test.ts', 'src/**/*.tsx'), relative to repo root. Respects standard excludes (node_modules, dist, build, .git, lockfiles).",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. '**/*.ts'." },
        limit: { type: "number", description: "Max files to return. Default 200, max 1000." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents with a regular expression (search_code is plain substring; this is regex). Optionally restrict to a glob. Returns file:line: matches.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression (JavaScript syntax)." },
        glob: {
          type: "string",
          description: "Optional glob to limit files, e.g. '**/*.ts'. Defaults to common source + doc types.",
        },
        ignoreCase: { type: "boolean", description: "Case-insensitive. Default true." },
        maxResults: { type: "number", description: "Max matches to return. Default 30, max 100." },
      },
      required: ["pattern"],
    },
  },
  // ── File reading & code search ────────────────────────────────────────────
  {
    name: "get_project_tree",
    description:
      "Get the project directory tree. Always call this first at the start of any analysis, audit, or refactor task before reading individual files.",
    inputSchema: {
      type: "object",
      properties: { depth: { type: "number", description: "Tree depth. Default 3, max 5." } },
    },
  },
  {
    name: "get_package_summary",
    description:
      "Read package.json and return scripts and dependency names. Call this early in any task involving build, deps, or scripts — do not run 'cat package.json' or 'ls' in bash. " +
      "Pass `module` to target a subdirectory's package.json in a monorepo (e.g. 'packages/api').",
    inputSchema: { type: "object", properties: { ...moduleArg } },
  },
  {
    name: "read_file_range",
    description:
      "Read a specific line range from a single file. Use for targeted reads of one file. For reading multiple related files together, prefer read_multiple_files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
      },
      required: ["path"],
    },
  },
  {
    name: "read_multiple_files",
    description:
      "Read up to 5 related files in one call. Always prefer this over separate read_file_range calls when you need several files. Minimises round-trips.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          maxItems: 5,
          description: "Relative paths from repo root.",
        },
        maxLinesEach: { type: "number", description: "Max lines to return per file. Default 150." },
      },
      required: ["paths"],
    },
  },
  {
    name: "search_code",
    description:
      "Search source code and config files for a query string. Use this instead of 'grep' or 'findstr' shell commands.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "search_docs",
    description:
      "Search markdown and documentation files. Use this instead of 'grep' on .md files or reading entire docs manually.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "read_doc",
    description:
      "Read a single markdown document by relative path. Use read_multiple_files if you need more than one doc.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, maxLines: { type: "number" } },
      required: ["path"],
    },
  },
  {
    name: "find_api_endpoint",
    description:
      "Search for an API route or endpoint definition by method or path text. Use this instead of grep-ing route files manually.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "find_schema",
    description:
      "Search for database schemas, Zod validators, and TypeScript types. Call this before manually reading schema files.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "find_references",
    description:
      "Find all files that reference a function, variable, class, or symbol name. Use instead of grep/findstr for symbol lookups.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Symbol name to find references for." } },
      required: ["symbol"],
    },
  },
  {
    name: "find_exports",
    description:
      "Find all export statements for a given name across the codebase. Use before tracing an import chain manually.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Export name to search for." } },
      required: ["name"],
    },
  },
  // ── Project context ────────────────────────────────────────────────────────
  {
    name: "get_audit_summaries",
    description:
      "Read all audit files from .claude/audits/. Always call this before any architecture review, risk assessment, or module analysis task. Do not use bash to read audit files.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string", description: "Optional module filter, e.g. 'packages/api'. Omit for all audits." },
        maxLinesEach: { type: "number", description: "Max lines per audit file. Default 120." },
      },
    },
  },
  {
    name: "search_audits",
    description:
      "Search audit files in .claude/audits/ for a specific term or finding. Use instead of grep on audit files.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "get_project_context",
    description:
      "Read project notes: log.txt, 'my thoughts.txt', .claude/notes/, and any journal files at repo root. Call this at the start of a session instead of manually cat-ing these files.",
    inputSchema: {
      type: "object",
      properties: { maxLinesEach: { type: "number", description: "Max lines per file. Default 60." } },
    },
  },
  {
    name: "get_git_status",
    description:
      "Get git status, staged changes, and recent commits. Always call this instead of running 'git status', 'git log', or 'git diff' in bash.",
    inputSchema: {
      type: "object",
      properties: {
        commits: { type: "number", description: "Number of recent commits to include. Default 10." },
        includeDiff: { type: "boolean", description: "Include diff of staged files. Default false." },
      },
    },
  },
  {
    name: "get_recent_changes",
    description:
      "Get files changed in recent git commits with their diffs. Use instead of 'git show' or 'git diff HEAD~N' in bash.",
    inputSchema: {
      type: "object",
      properties: { commits: { type: "number", description: "How many recent commits to include. Default 3." } },
    },
  },
  {
    name: "get_env_vars",
    description:
      "List environment variable keys from .env, .env.example, .env.local etc. Returns keys only, never values. Use instead of cat-ing env files.",
    inputSchema: { type: "object", properties: {} },
  },
  // ── Quality ──────────────────────────────────────────────────────────────
  {
    name: "get_typecheck_errors",
    description:
      "Run TypeScript typecheck and return compiler output. Call this instead of running tsc manually in bash. " +
      "Pass `module` to typecheck a subdirectory/package in a monorepo (e.g. 'packages/api') — required when the repo root has no package.json of its own.",
    inputSchema: { type: "object", properties: { ...moduleArg } },
  },
  {
    name: "get_test_failures",
    description:
      "Run the test suite and return output. Call this instead of running 'npm test' in bash. " +
      "Pass `module` to run tests for a subdirectory/package in a monorepo (e.g. 'packages/api') — required when the repo root has no package.json of its own.",
    inputSchema: { type: "object", properties: { ...moduleArg } },
  },
  {
    name: "find_todos",
    description:
      "Find TODO, FIXME, HACK, and NOTE comments across the codebase. Use instead of grep-ing for these patterns.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run_script",
    description:
      "Run a named npm script from package.json (e.g. 'lint', 'format', 'db:migrate'). Safer than running arbitrary shell commands. Will refuse scripts not in package.json. " +
      "Pass `module` to run a script defined in a subdirectory's package.json in a monorepo (e.g. 'packages/api').",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "The npm script name as defined in package.json scripts." },
        ...moduleArg,
      },
      required: ["script"],
    },
  },
  // ── Write ──────────────────────────────────────────────────────────────────
  {
    name: "write_file",
    description:
      "Write or overwrite a file with new content. Use for creating new files or fully replacing a file. " +
      "For surgical edits to existing files, prefer edit_file (str_replace) to avoid rewriting unchanged lines.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path from repo root. Parent directories are created automatically.",
        },
        content: { type: "string", description: "Full file content to write." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Edit an existing file by replacing an exact string with new text (str_replace). " +
      "oldStr must match the file content exactly — include enough surrounding lines to make it unique. " +
      "Use this for targeted fixes. Use write_file when replacing the whole file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path from repo root." },
        oldStr: { type: "string", description: "Exact string to find and replace. Must appear exactly once in the file." },
        newStr: { type: "string", description: "Replacement string. Pass empty string to delete the matched block." },
      },
      required: ["path", "oldStr", "newStr"],
    },
  },
  {
    name: "delete_file",
    description:
      "Delete a file from the repo. Use for removing leaked secrets, stale artifacts, or dead code files. " +
      "This is permanent — ensure the file is not needed before deleting.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path from repo root." },
        confirm: { type: "boolean", description: "Must be true to proceed. Prevents accidental deletion." },
      },
      required: ["path", "confirm"],
    },
  },
];

export function getToolDefinitions(): Tool[] {
  return [...coreTools, ...getWebToolDefinitions()];
}
