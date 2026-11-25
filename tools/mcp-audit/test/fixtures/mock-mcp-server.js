// @ts-check
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "normal";

if (mode === "hang") {
  // Stay alive without responding to test timeout handling
  setInterval(() => {}, 10000);
} else if (mode === "crash") {
  process.stderr.write("mock crash on startup\n");
  process.exit(1);
} else {
  // Emit a non-JSON diagnostic line on stdout before JSON-RPC traffic
  if (mode === "noisy") {
    process.stdout.write("debug: server booting...\n");
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    /** @type {{ id?: number, method?: string, params?: { cursor?: string } }} */
    const msg = JSON.parse(trimmed);

    if (msg.method === "initialize" && msg.id !== undefined) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2025-03-26",
            serverInfo: { name: "mock-mcp", version: "1.0.0" },
            capabilities: {
              tools: {},
              prompts: {},
              resources: {},
            },
          },
        }) + "\n",
      );
    } else if (msg.method === "tools/list" && msg.id !== undefined) {
      if (mode === "paginated" && !msg.params?.cursor) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: [
                {
                  name: "page_one_tool",
                  description: "First page tool.",
                  inputSchema: { type: "object", properties: { q: { type: "string" } } },
                  annotations: { readOnlyHint: true },
                },
              ],
              nextCursor: "page-2",
            },
          }) + "\n",
        );
      } else if (mode === "paginated" && msg.params?.cursor === "page-2") {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: [
                {
                  name: "page_two_tool",
                  description: "Second page tool.",
                  inputSchema: { type: "object", properties: { id: { type: "number" } } },
                  annotations: { readOnlyHint: true },
                },
              ],
            },
          }) + "\n",
        );
      } else {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: [
                {
                  name: "read_status",
                  description: "Read current status.",
                  inputSchema: { type: "object", properties: {} },
                  annotations: { readOnlyHint: true },
                },
                {
                  name: "run_query",
                  description: "Execute a query.",
                  inputSchema: {
                    type: "object",
                    properties: { sql: { type: "string" } },
                    required: ["sql"],
                  },
                  annotations: { readOnlyHint: true },
                },
              ],
            },
          }) + "\n",
        );
      }
    } else if (msg.method === "prompts/list" && msg.id !== undefined) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            prompts: [{ name: "summarize", description: "Summarize changes." }],
          },
        }) + "\n",
      );
    } else if (msg.method === "resources/list" && msg.id !== undefined) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            resources: [{ uri: "file:///docs/readme.md", name: "readme" }],
          },
        }) + "\n",
      );
    }
  });
}
