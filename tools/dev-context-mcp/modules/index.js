// Barrel re-export of all consolidated MCP modules.
export {
  TOOLS as GIT_HISTORY_TOOLS,
  callTool as callGitHistoryTool,
} from "./git-history/tools.js";
export { ToolError as GitHistoryToolError } from "./git-history/git.js";
export {
  TOOL_DEFINITIONS as DIAGNOSTICS_TOOLS,
  handleTool as handleDiagnosticsTool,
} from "./diagnostics/server.js";
export {
  TOOL_DEFINITIONS as TEST_REPORT_TOOLS,
  handleTool as handleTestReportTool,
} from "./test-report/tools.js";
export { parseConfig as loadDbConfig } from "./db-schema/config.js";
export { createDatabase } from "./db-schema/db.js";
export {
  TOOLS as DB_SCHEMA_TOOLS,
  callTool as callDbSchemaTool,
} from "./db-schema/tools.js";
