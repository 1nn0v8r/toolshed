// @ts-check
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseWithPreset } from "./detect.js";
import { filterDiagnostics } from "./filters.js";
import { formatDiagnostics } from "./format.js";
import { runCommand } from "./runner.js";

export const TOOL_DEFINITIONS = [
  {
    name: "check_diagnostics",
    description: "Runs a typecheck or lint command in the workspace and returns token-compact, deduplicated diagnostics without cascading errors.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command to execute (for example 'npm run typecheck', 'npx tsc --noEmit', 'cargo check', 'ruff check .')",
        },
        preset: {
          type: "string",
          enum: ["auto", "tsc", "eslint", "python", "cargo"],
          description: "Parser preset to use (default: auto)",
        },
        maxErrors: {
          type: "number",
          description: "Maximum number of diagnostics to include in the output (default: 15)",
        },
        includeSnippets: {
          type: "boolean",
          description: "Include a 2-line code snippet showing the error site (default: true)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "trim_diagnostics",
    description: "Accepts raw compiler or linter output text and compresses it to the essential error anchors and snippets.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Raw diagnostic log or error text from a previous terminal run",
        },
        preset: {
          type: "string",
          enum: ["auto", "tsc", "eslint", "python", "cargo"],
          description: "Parser preset to use (default: auto)",
        },
        maxErrors: {
          type: "number",
          description: "Maximum number of diagnostics to include in the output (default: 15)",
        },
        includeSnippets: {
          type: "boolean",
          description: "Include a 2-line code snippet showing the error site (default: true)",
        },
      },
      required: ["text"],
    },
  },
];

/**
 * Handle tool execution.
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string} [root]
 * @returns {Promise<{ content: { type: 'text', text: string }[], isError?: boolean }>}
 */
export async function handleTool(name, args, root = process.cwd()) {
  const preset = /** @type {'auto' | 'tsc' | 'eslint' | 'python' | 'cargo'} */ (args.preset || "auto");
  const maxErrors = typeof args.maxErrors === "number" ? args.maxErrors : 15;
  const includeSnippets = args.includeSnippets !== false;

  if (name === "trim_diagnostics") {
    const text = String(args.text || "");
    const rawList = parseWithPreset(text, preset);
    const { kept, suppressedCount } = filterDiagnostics(rawList);
    const report = formatDiagnostics(kept, {
      root,
      maxErrors,
      suppressedCount,
      includeSnippets,
    });
    return {
      content: [{ type: "text", text: report }],
      isError: kept.some((d) => d.severity === "error"),
    };
  }

  if (name === "check_diagnostics") {
    const cmd = String(args.command || "");
    const { exitCode, output } = await runCommand(cmd, root);
    const rawList = parseWithPreset(output, preset);
    const { kept, suppressedCount } = filterDiagnostics(rawList);
    const report = formatDiagnostics(kept, {
      root,
      maxErrors,
      suppressedCount,
      includeSnippets,
    });
    return {
      content: [{ type: "text", text: report }],
      isError: exitCode !== 0 || kept.some((d) => d.severity === "error"),
    };
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
}

/**
 * Start the MCP server on stdio.
 */
export async function startServer() {
  const server = new Server(
    { name: "diagnostics-trim-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = /** @type {Record<string, unknown>} */ (request.params.arguments ?? {});
    return handleTool(request.params.name, args);
  });

  await server.connect(new StdioServerTransport());
}
