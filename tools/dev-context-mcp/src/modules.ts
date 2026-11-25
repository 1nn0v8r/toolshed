// Unified module registry for dev-context-mcp.
//
// Consolidates git-history, diagnostics-trim, test-report, and opt-in db-schema
// into a single MCP server with toggleable modules so users only configure one
// server while still controlling upfront schema token cost.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Session } from "./security.js";

import {
  GIT_HISTORY_TOOLS,
  callGitHistoryTool,
  GitHistoryToolError,
  DIAGNOSTICS_TOOLS,
  handleDiagnosticsTool,
  TEST_REPORT_TOOLS,
  handleTestReportTool,
  type TestReportSession,
  loadDbConfig,
  type DbConfig,
  createDatabase,
  type Database,
  DB_SCHEMA_TOOLS,
  callDbSchemaTool,
} from "../modules/index.js";

export type ModuleName =
  | "core"
  | "git-history"
  | "diagnostics"
  | "test-report"
  | "web"
  | "db";

export const ALL_MODULES: readonly ModuleName[] = [
  "core",
  "git-history",
  "diagnostics",
  "test-report",
  "web",
  "db",
] as const;

export const DEFAULT_MODULES: readonly ModuleName[] = [
  "core",
  "git-history",
  "diagnostics",
  "test-report",
  "web",
] as const;

export interface ModuleInfo {
  name: ModuleName;
  label: string;
  description: string;
  defaultEnabled: boolean | "auto";
}

export const MODULE_CATALOG: readonly ModuleInfo[] = [
  {
    name: "core",
    label: "Core Repo Tools",
    description: "Orientation, file search/read/edit, git status, scripts, and shell.",
    defaultEnabled: true,
  },
  {
    name: "git-history",
    label: "Git History & Blame",
    description: "File history, grouped blame, line origin, commit search, churn, and contributors.",
    defaultEnabled: true,
  },
  {
    name: "diagnostics",
    label: "Diagnostics Trimmer",
    description: "Run typecheckers/linters (tsc, eslint, ruff, pyright, cargo) with deduplicated output.",
    defaultEnabled: true,
  },
  {
    name: "test-report",
    label: "Test Reporter",
    description: "Auto-detect test runners and return only failing tests with trimmed stack traces.",
    defaultEnabled: true,
  },
  {
    name: "web",
    label: "Web & Browser",
    description: "Fetch URLs, web search, and optional Playwright browsing/screenshots.",
    defaultEnabled: true,
  },
  {
    name: "db",
    label: "Database Schema (Read-Only)",
    description: "Inspect PostgreSQL/MySQL schemas and run guarded SELECT queries (auto-enabled when DATABASE_URL is set).",
    defaultEnabled: "auto",
  },
];

function parseCsvFlag(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function getArgValue(prefix: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

/**
 * Resolve which modules are enabled for this server process.
 *
 * Precedence:
 *   1. --modules=... CLI flag or MCP_MODULES env var (comma-separated allowlist, or "all")
 *   2. Otherwise: DEFAULT_MODULES + ("db" if DATABASE_URL is set)
 *   3. Subtract --disable-modules=... or MCP_DISABLED_MODULES
 */
export function resolveEnabledModules(env: NodeJS.ProcessEnv = process.env): Set<ModuleName> {
  const valid = new Set<string>(ALL_MODULES);
  const rawInclude = getArgValue("--modules=") ?? env.MCP_MODULES;
  const rawDisable = getArgValue("--disable-modules=") ?? env.MCP_DISABLED_MODULES;

  let enabled: Set<ModuleName>;
  const includeTokens = parseCsvFlag(rawInclude);
  if (includeTokens.length > 0) {
    if (includeTokens.includes("all")) {
      enabled = new Set<ModuleName>(ALL_MODULES);
    } else {
      enabled = new Set<ModuleName>();
      for (const token of includeTokens) {
        if (valid.has(token)) enabled.add(token as ModuleName);
      }
    }
  } else {
    enabled = new Set<ModuleName>(DEFAULT_MODULES);
    if (env.DATABASE_URL && env.DATABASE_URL.trim() !== "") {
      enabled.add("db");
    }
  }

  for (const token of parseCsvFlag(rawDisable)) {
    if (valid.has(token)) enabled.delete(token as ModuleName);
  }

  return enabled;
}

const repoRootProp = {
  type: "string",
  description:
    "Optional absolute path to the repo root for this call. Overrides the session default.",
};

function withRepoRoot(tools: Tool[]): Tool[] {
  return tools.map((t) => {
    const schema = t.inputSchema as {
      type: "object";
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
    if (schema.properties && "repoRoot" in schema.properties) return t;
    return {
      ...t,
      inputSchema: {
        ...schema,
        properties: {
          ...(schema.properties ?? {}),
          repoRoot: repoRootProp,
        },
      },
    };
  });
}

const gitHistoryDefs: Tool[] = GIT_HISTORY_TOOLS;
const diagnosticsDefs: Tool[] = withRepoRoot(DIAGNOSTICS_TOOLS);
const testReportDefs: Tool[] = withRepoRoot(TEST_REPORT_TOOLS);
const dbSchemaDefs: Tool[] = DB_SCHEMA_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
}));

const TOOL_TO_MODULE = new Map<string, ModuleName>();
for (const t of gitHistoryDefs) TOOL_TO_MODULE.set(t.name, "git-history");
for (const t of diagnosticsDefs) TOOL_TO_MODULE.set(t.name, "diagnostics");
for (const t of testReportDefs) TOOL_TO_MODULE.set(t.name, "test-report");
for (const t of dbSchemaDefs) TOOL_TO_MODULE.set(t.name, "db");

export function getExtensionToolModule(toolName: string): ModuleName | null {
  return TOOL_TO_MODULE.get(toolName) ?? null;
}

export function isExtensionTool(toolName: string): boolean {
  return TOOL_TO_MODULE.has(toolName);
}

export function getExtensionToolDefinitions(enabled: Set<ModuleName>): Tool[] {
  const out: Tool[] = [];
  if (enabled.has("git-history")) out.push(...gitHistoryDefs);
  if (enabled.has("diagnostics")) out.push(...diagnosticsDefs);
  if (enabled.has("test-report")) out.push(...testReportDefs);
  if (enabled.has("db")) out.push(...dbSchemaDefs);
  return out;
}

export interface ExtensionState {
  testReport: TestReportSession;
  dbConfig: DbConfig | null;
  db: Database | null;
  close: () => Promise<void>;
}

export function createExtensionState(initialRoot: string): ExtensionState {
  const state: ExtensionState = {
    testReport: { root: initialRoot, last: null },
    dbConfig: null,
    db: null,
    async close() {
      if (state.db) {
        await state.db.close().catch(() => {});
        state.db = null;
      }
    },
  };
  return state;
}

export async function handleExtensionTool(
  toolName: string,
  args: Record<string, unknown>,
  session: Session,
  state: ExtensionState,
  resolveRoot: (args: Record<string, unknown>) => string
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const mod = TOOL_TO_MODULE.get(toolName);
  if (!mod) {
    return { content: [{ type: "text", text: `Unknown tool: ${toolName}` }], isError: true };
  }

  if (mod === "git-history") {
    const root = resolveRoot(args);
    try {
      // Pass resolved root as defaultRoot and clear args.repoRoot so confineRoot is enforced.
      const safeArgs = { ...args };
      delete safeArgs.repoRoot;
      const text = await callGitHistoryTool(toolName, safeArgs, root);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const msg =
        err instanceof GitHistoryToolError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  }

  if (mod === "diagnostics") {
    const root = resolveRoot(args);
    return handleDiagnosticsTool(toolName, args, root);
  }

  if (mod === "test-report") {
    const root = resolveRoot(args);
    state.testReport.root = root;
    return handleTestReportTool(state.testReport, toolName, args);
  }

  if (mod === "db") {
    if (!state.dbConfig) {
      try {
        state.dbConfig = loadDbConfig(process.env);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Database module is enabled but not configured: ${msg}. Set DATABASE_URL (postgres://... or mysql://...) in your MCP server env.`,
            },
          ],
          isError: true,
        };
      }
    }
    const config = state.dbConfig;
    const getDb = () => {
      if (!state.db) state.db = createDatabase(config);
      return state.db;
    };
    // Ensure session parameter is used (capability check already ran before dispatch).
    void session;
    return callDbSchemaTool(toolName, args, { config, getDb });
  }

  return { content: [{ type: "text", text: `Unknown tool: ${toolName}` }], isError: true };
}
