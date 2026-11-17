#!/usr/bin/env node
// @ts-check
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultRoot, ToolError } from "./git.js";
import { callTool, finalize, TOOLS } from "./tools.js";

/**
 * Build the MCP server.
 * @param {string} [root] default repo root
 * @returns {Server}
 */
export function createServer(root) {
  const server = new Server({ name: "git-history-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = /** @type {Record<string, unknown>} */ (request.params.arguments ?? {});
    try {
      const text = await callTool(request.params.name, args, root ?? defaultRoot());
      return { content: [{ type: "text", text }] };
    } catch (e) {
      const msg = e instanceof ToolError ? e.message : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
      return { isError: true, content: [{ type: "text", text: finalize(msg) }] };
    }
  });

  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

/** True when this file is the process entry point. */
function isEntry() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
