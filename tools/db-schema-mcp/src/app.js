// @ts-check
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, callTool } from "./tools.js";

export const SERVER_NAME = "db-schema-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Build the MCP server. The database handle is created lazily on first use so
 * the server can start and list tools even when the database is unreachable.
 * @param {import("./config.js").Config} config
 * @param {() => import("./db.js").Database} [dbFactory]
 */
export function createApp(config, dbFactory) {
  /** @type {import("./db.js").Database | null} */
  let db = null;
  const getDb = () => {
    if (!db) db = dbFactory ? dbFactory() : null;
    if (!db) throw new Error("no database factory configured");
    return db;
  };
  const ctx = { config, getDb };

  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = /** @type {Record<string, unknown>} */ (request.params.arguments ?? {});
    return callTool(request.params.name, args, ctx);
  });

  return {
    server,
    async close() {
      if (db) await db.close().catch(() => {});
      db = null;
    },
  };
}
