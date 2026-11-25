#!/usr/bin/env node
// @ts-check
import fs from "node:fs";
import { spawn } from "node:child_process";
import { CLI_TOOLS, MCP_ENTRY, MCP_MODULES } from "../cli/catalog.js";
import { detectClientStatuses } from "../cli/clients.js";
import { getInstallStatus, ensureMcpReady } from "../cli/installer.js";
import { runSetup } from "../cli/setup.js";
import { startUiServer } from "../cli/ui/server.js";

function printHelp() {
  console.log(`
toolshed - One CLI, one visual UI, and one unified MCP server for AI-assisted coding.

Usage:
  toolshed ui [--port 4317] [--no-open]   Open the visual Web UI installer & dashboard
  toolshed setup [options]                Interactive CLI wizard to build & connect dev-context MCP
  toolshed status                         Show MCP build state, connected AI clients, and CLI tools
  toolshed mcp [args...]                  Start the unified dev-context MCP server directly
  toolshed <tool> [args...]               Run any standalone toolshed CLI

Setup options:
  --client <ids>        Comma-separated clients (claude-code,claude-desktop,cursor,vscode,windsurf,gemini-cli)
  --modules <names>     Comma-separated MCP modules (${MCP_MODULES.map((m) => m.id).join(",")})
  --database-url <url>  Optional PostgreSQL/MySQL URL for the read-only db module
  --repo-root <path>    Default REPO_ROOT (used by Claude Desktop)
  --rebuild             Force reinstall & rebuild of dev-context-mcp
  --yes, -y             Non-interactive mode using detected clients and defaults

Available CLI tools:`);

  /** @type {Record<string, typeof CLI_TOOLS>} */
  const groups = {};
  for (const t of CLI_TOOLS) {
    (groups[t.category] ||= []).push(t);
  }
  for (const [cat, items] of Object.entries(groups)) {
    console.log(`\n  ${cat}:`);
    for (const item of items) {
      console.log(`    ${item.id.padEnd(20)} ${item.description}`);
    }
  }
  console.log("");
}

function printStatus() {
  const install = getInstallStatus();
  const clients = detectClientStatuses();

  console.log("\n=== toolshed status ===\n");
  console.log(`Unified MCP server (dev-context-mcp):`);
  console.log(`  Status:  ${install.mcp.ready ? "READY" : "NEEDS BUILD (run: toolshed setup)"}`);
  console.log(`  Entry:   ${install.mcp.entry}`);
  console.log(`  Modules: ${MCP_MODULES.map((m) => `${m.id}(${m.toolCount})`).join(", ")}\n`);

  console.log("AI Clients:");
  for (const c of clients) {
    const tag = c.connected ? "[CONNECTED]" : c.detected ? "[DETECTED] " : "[not found]";
    const mods = c.configuredModules ? ` modules=${c.configuredModules.join(",")}` : "";
    console.log(`  ${tag} ${c.name.padEnd(22)} ${c.configPath}${mods}`);
  }

  console.log(`\nCLI Tools (${install.cliTools.length} available via \`toolshed <name>\`):`);
  for (const t of install.cliTools) {
    const tag = t.ready ? "[READY]" : "[INSTALL NEEDED]";
    console.log(`  ${tag.padEnd(16)} ${t.id.padEnd(20)} ${t.example}`);
  }
  console.log("");
}

/**
 * Forward execution to a Node.js script with inherited stdio.
 * @param {string} scriptPath
 * @param {string[]} args
 */
function runNodeScript(scriptPath, args) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: "inherit",
    windowsHide: false,
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    return;
  }

  if (cmd === "status") {
    printStatus();
    return;
  }

  if (cmd === "setup" || cmd === "install") {
    await runSetup(rest);
    return;
  }

  if (cmd === "ui" || cmd === "dashboard") {
    let port = Number(process.env.TOOLSHED_UI_PORT) || 4317;
    let host = process.env.TOOLSHED_UI_HOST || "127.0.0.1";
    let openBrowser = true;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--no-open") openBrowser = false;
      else if (a === "--port" && rest[i + 1]) port = Number(rest[++i]) || 4317;
      else if (a.startsWith("--port=")) port = Number(a.slice(7)) || 4317;
      else if (a === "--host" && rest[i + 1]) host = rest[++i];
      else if (a.startsWith("--host=")) host = a.slice(7);
    }
    await startUiServer({ port, host, openBrowser });
    return;
  }

  if (cmd === "mcp") {
    if (!fs.existsSync(MCP_ENTRY)) {
      console.error("dev-context-mcp is not built yet. Building now...");
      const res = await ensureMcpReady();
      if (!res.ok) {
        console.error(res.output);
        process.exit(1);
      }
    }
    runNodeScript(MCP_ENTRY, rest);
    return;
  }

  const cliTool = CLI_TOOLS.find((t) => t.id === cmd);
  if (cliTool) {
    runNodeScript(cliTool.entry, rest);
    return;
  }

  console.error(`Unknown command: "${cmd}". Run \`toolshed --help\` to see available commands.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
