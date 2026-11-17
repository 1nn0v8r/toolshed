#!/usr/bin/env node
// @ts-check
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseConfig, ConfigError } from "./config.js";
import { createDatabase } from "./db.js";
import { createApp } from "./app.js";
import { redactSecrets } from "./redact.js";

let config;
try {
  config = parseConfig(process.env);
} catch (e) {
  const msg = e instanceof ConfigError ? e.message : "invalid configuration";
  process.stderr.write(`db-schema-mcp: ${msg}\n`);
  process.exit(2);
}

const app = createApp(config, () => createDatabase(/** @type {import("./config.js").Config} */ (config)));
const transport = new StdioServerTransport();

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown);

try {
  await app.server.connect(transport);
} catch (e) {
  process.stderr.write(`db-schema-mcp: ${redactSecrets(e instanceof Error ? e.message : String(e), config)}\n`);
  process.exit(1);
}
