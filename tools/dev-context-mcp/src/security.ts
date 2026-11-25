// Capability/security model.
//
// The server runs in one of two postures:
//   • stdio  → "full power": the only caller is the local client (like your own
//              shell), so every tool is enabled with no token.
//   • http   → "hardened":  the server listens on a socket, so dangerous tiers
//              are OFF by default and must be opted into with env flags, and a
//              bearer token is required (enforced in src/http.ts).
//
// Each tool is tagged with one capability tier. A request is allowed only if the
// session has that tier enabled.

import path from "node:path";
import type { ModuleName } from "./modules.js";

export type Capability = "read" | "write" | "exec" | "admin" | "web";

export type Transport = "stdio" | "http";

export interface Session {
  /** Active repo root for this session (mutable via set_repo_root). */
  root: string;
  /** Capability tiers enabled for this session. */
  caps: Set<Capability>;
  /** Enabled tool modules for this session. */
  modules: Set<ModuleName>;
  /** stdio/local, dangerous tiers enabled without flags, set_repo_root unconfined. */
  fullPower: boolean;
  /** When set (hardened mode), set_repo_root targets are confined under this dir. */
  rootBase: string | null;
}

// Tool → required capability tier. Read/web are low-risk; write/exec/admin are
// the dangerous tiers gated in hardened mode.
export const TOOL_CAPS: Record<string, Capability> = {
  // ── read: inspect the repo, never mutate, never run project code ──
  get_project_tree: "read",
  get_package_summary: "read",
  read_file_range: "read",
  read_multiple_files: "read",
  list_directory: "read",
  find_files: "read",
  grep: "read",
  search_code: "read",
  search_docs: "read",
  read_doc: "read",
  find_api_endpoint: "read",
  find_schema: "read",
  find_references: "read",
  find_exports: "read",
  find_todos: "read",
  get_audit_summaries: "read",
  search_audits: "read",
  get_project_context: "read",
  get_project_manifest: "read",
  get_architecture_docs: "read",
  get_git_status: "read",
  get_recent_changes: "read",
  get_env_vars: "read",
  // -- git-history module (read-only git inspection) --
  file_history: "read",
  blame_range: "read",
  line_origin: "read",
  commit_details: "read",
  search_commits: "read",
  churn: "read",
  contributors: "read",
  // -- diagnostics module --
  trim_diagnostics: "read",
  check_diagnostics: "exec",
  // -- test-report module --
  detect_test_runner: "read",
  parse_report: "read",
  list_failures_from_last_run: "read",
  run_tests: "exec",
  // -- db module (read-only guarded SELECT and schema inspection) --
  list_tables: "read",
  describe_table: "read",
  list_relationships: "read",
  sample_rows: "read",
  run_select: "read",
  connection_info: "read",
  // ── web: reach the network (SSRF-guarded in hardened mode) ──
  fetch_url: "web",
  web_search: "web",
  browse_page: "web",
  screenshot: "web",
  // ── exec: run project code / arbitrary shell ──
  run_command: "exec",
  run_script: "exec",
  get_typecheck_errors: "exec",
  get_test_failures: "exec",
  // ── write: mutate the filesystem ──
  write_file: "write",
  edit_file: "write",
  delete_file: "write",
  // ── admin: retarget the active root ──
  set_repo_root: "admin",
};

function envFlag(name: string): boolean {
  const v = process.env[name];
  return v === "1" || v?.toLowerCase() === "true";
}

const FLAG_FOR: Partial<Record<Capability, string>> = {
  write: "MCP_ALLOW_WRITE",
  exec: "MCP_ALLOW_EXEC",
  admin: "MCP_ALLOW_ADMIN",
};

// Decide which tiers are enabled for a transport. read+web are always on; the
// dangerous tiers are always on for stdio and opt-in for http.
export function resolveCapabilities(transport: Transport): {
  caps: Set<Capability>;
  fullPower: boolean;
} {
  const caps = new Set<Capability>(["read", "web"]);

  if (transport === "stdio") {
    caps.add("write");
    caps.add("exec");
    caps.add("admin");
    return { caps, fullPower: true };
  }

  // http, hardened. Opt in per-tier, or all at once with MCP_DANGEROUS.
  const all = envFlag("MCP_DANGEROUS");
  if (all || envFlag("MCP_ALLOW_WRITE")) caps.add("write");
  if (all || envFlag("MCP_ALLOW_EXEC")) caps.add("exec");
  if (all || envFlag("MCP_ALLOW_ADMIN")) caps.add("admin");
  return { caps, fullPower: false };
}

// Returns an explanatory error string if the tool is blocked in this session,
// or null if it is allowed. Unknown tools return null (handled as "unknown tool"
// by the dispatcher).
export function capabilityError(session: Session, toolName: string): string | null {
  const need = TOOL_CAPS[toolName];
  if (!need) return null;
  if (session.caps.has(need)) return null;

  const flag = FLAG_FOR[need];
  return (
    `Tool "${toolName}" needs the "${need}" capability, which is disabled in this server's hardened (HTTP) mode.` +
    (flag ? ` Enable it by setting ${flag}=1 (or MCP_DANGEROUS=1) on the server, then reconnect.` : "")
  );
}

// In hardened mode, keep set_repo_root from escaping the mounted/allowed base.
// In full-power mode the target is returned unchanged (intended "any repo" power).
export function confineRoot(session: Session, target: string): string {
  if (session.fullPower || !session.rootBase) return target;
  const rel = path.relative(session.rootBase, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `set_repo_root denied: ${target} is outside the allowed base (${session.rootBase}). ` +
        `In hardened mode the root can only move within MCP_ROOT_BASE/REPO_ROOT.`
    );
  }
  return target;
}
