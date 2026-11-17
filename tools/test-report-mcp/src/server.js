#!/usr/bin/env node
// @ts-check
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_DEFINITIONS, handleTool } from "./tools.js";
import { resolveRoot } from "./util.js";

/** @type {import("./tools.js").Session} */
const session = { root: resolveRoot(), last: null };

const server = new Server({ name: "test-report-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = /** @type {Record<string, unknown>} */ (request.params.arguments ?? {});
  return handleTool(session, request.params.name, args);
});

await server.connect(new StdioServerTransport());
