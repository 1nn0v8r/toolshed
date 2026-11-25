import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const GIT_HISTORY_TOOLS: Tool[];
export function callGitHistoryTool(
  name: string,
  args: Record<string, unknown>,
  defaultRoot: string
): Promise<string>;
export class GitHistoryToolError extends Error {}

export const DIAGNOSTICS_TOOLS: Tool[];
export function handleDiagnosticsTool(
  name: string,
  args: Record<string, unknown>,
  root?: string
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

export interface TestReportSession {
  root: string;
  last: { text: string; at: string; runner: string } | null;
}
export const TEST_REPORT_TOOLS: Tool[];
export function handleTestReportTool(
  session: TestReportSession,
  name: string,
  args: Record<string, unknown>
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

export interface DbConfig {
  url: string;
  kind: "postgres" | "mysql";
  schema?: string;
  maxRows: number;
  timeoutMs: number;
  ssl: boolean;
  password?: string;
}
export interface Database {
  close(): Promise<void>;
}
export interface DbContext {
  config: DbConfig;
  getDb: () => Database;
}
export function loadDbConfig(env?: NodeJS.ProcessEnv): DbConfig;
export function createDatabase(config: DbConfig): Database;
export const DB_SCHEMA_TOOLS: (Tool & {
  handler: (args: Record<string, unknown>, ctx: DbContext) => Promise<string>;
})[];
export function callDbSchemaTool(
  name: string,
  args: Record<string, unknown>,
  ctx: DbContext
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
