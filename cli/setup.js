// @ts-check
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { MCP_MODULES } from "./catalog.js";
import { detectClientStatuses, connectClient } from "./clients.js";
import { ensureMcpReady, getInstallStatus } from "./installer.js";

/**
 * Parse simple CLI flags for `toolshed setup`.
 * @param {string[]} argv
 */
function parseSetupArgs(argv) {
  /** @type {{ clients: string[], modules: string[] | null, databaseUrl: string, repoRoot: string, yes: boolean, forceBuild: boolean }} */
  const opts = {
    clients: [],
    modules: null,
    databaseUrl: "",
    repoRoot: "",
    yes: false,
    forceBuild: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--rebuild") opts.forceBuild = true;
    else if (a === "--client" && argv[i + 1]) opts.clients.push(...argv[++i].split(",").map((s) => s.trim()).filter(Boolean));
    else if (a.startsWith("--client=")) opts.clients.push(...a.slice(9).split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--modules" && argv[i + 1]) opts.modules = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--modules=")) opts.modules = a.slice(10).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--database-url" && argv[i + 1]) opts.databaseUrl = argv[++i];
    else if (a.startsWith("--database-url=")) opts.databaseUrl = a.slice(15);
    else if (a === "--repo-root" && argv[i + 1]) opts.repoRoot = argv[++i];
    else if (a.startsWith("--repo-root=")) opts.repoRoot = a.slice(12);
  }
  return opts;
}

/**
 * Run interactive (or flag-driven) setup for the unified dev-context MCP server.
 * @param {string[]} argv
 */
export async function runSetup(argv) {
  const opts = parseSetupArgs(argv);
  const statuses = detectClientStatuses();

  console.log("\n=== toolshed setup (Unified dev-context MCP) ===\n");
  console.log("One MCP server, toggleable modules. No more configuring 5 separate servers.");
  console.log("Tip: Prefer a visual dashboard? Run `toolshed ui` instead.\n");

  const mcpStatus = getInstallStatus().mcp;
  if (!mcpStatus.ready || opts.forceBuild) {
    console.log("Step 1/3: Installing & building dev-context-mcp...");
    const buildRes = await ensureMcpReady({
      force: opts.forceBuild,
      onOutput: (chunk) => process.stdout.write(chunk),
    });
    if (!buildRes.ok) {
      console.error("\nFailed to build dev-context-mcp.");
      process.exitCode = 1;
      return;
    }
    console.log("Done: dev-context-mcp is ready.\n");
  } else {
    console.log("Step 1/3: dev-context-mcp is already installed and built.\n");
  }

  // Non-interactive mode when --yes or --client is passed
  if (opts.yes || opts.clients.length > 0) {
    const selectedModules =
      opts.modules ??
      MCP_MODULES.filter((m) => m.defaultEnabled || (m.id === "db" && opts.databaseUrl)).map((m) => m.id);
    const targetClients =
      opts.clients.length > 0
        ? opts.clients
        : statuses.filter((c) => c.detected && c.scope === "user").map((c) => c.id);

    if (targetClients.length === 0) {
      console.log("No AI clients were auto-detected. Pass --client claude-code,cursor,vscode,claude-desktop or run `toolshed ui`.");
      return;
    }

    for (const id of targetClients) {
      const res = connectClient(id, {
        modules: selectedModules,
        databaseUrl: opts.databaseUrl,
        repoRoot: opts.repoRoot,
      });
      console.log(`Connected ${res.name} -> ${res.configPath}`);
    }
    console.log("\nSetup complete! Restart or reconnect your AI client to load dev-context.\n");
    return;
  }

  // Interactive prompt mode (zero dependencies via node:readline/promises)
  const rl = readline.createInterface({ input, output });
  try {
    console.log("Step 2/3: Choose MCP modules to enable:");
    MCP_MODULES.forEach((m, idx) => {
      const tag = m.defaultEnabled ? "default ON" : "opt-in";
      console.log(`  ${idx + 1}. [${tag}] ${m.id} (${m.toolCount} tools) - ${m.description}`);
    });
    const modAnswer = (
      await rl.question("\nEnter module numbers or names (comma-separated, or press Enter for defaults): ")
    ).trim();

    /** @type {string[]} */
    let selectedModules;
    if (!modAnswer) {
      selectedModules = MCP_MODULES.filter((m) => m.defaultEnabled).map((m) => m.id);
    } else if (modAnswer.toLowerCase() === "all") {
      selectedModules = MCP_MODULES.map((m) => m.id);
    } else {
      selectedModules = [];
      for (const tok of modAnswer.split(",").map((s) => s.trim()).filter(Boolean)) {
        const asNum = Number(tok);
        if (Number.isInteger(asNum) && asNum >= 1 && asNum <= MCP_MODULES.length) {
          selectedModules.push(MCP_MODULES[asNum - 1].id);
        } else {
          const found = MCP_MODULES.find((m) => m.id === tok.toLowerCase());
          if (found) selectedModules.push(found.id);
        }
      }
      if (selectedModules.length === 0) {
        selectedModules = MCP_MODULES.filter((m) => m.defaultEnabled).map((m) => m.id);
      }
    }
    selectedModules = [...new Set(selectedModules)];

    let databaseUrl = opts.databaseUrl;
    if (selectedModules.includes("db") && !databaseUrl) {
      databaseUrl = (
        await rl.question("DATABASE_URL for db module (postgres://... or mysql://..., or Enter to set later): ")
      ).trim();
    }

    console.log("\nStep 3/3: Choose AI clients to connect:");
    statuses.forEach((c, idx) => {
      const state = c.connected ? "connected" : c.detected ? "detected" : "not found";
      console.log(`  ${idx + 1}. ${c.name} [${state}] - ${c.configPath}`);
    });
    const clientAnswer = (
      await rl.question("\nEnter client numbers (comma-separated, e.g. 1,3, or Enter to connect all detected): ")
    ).trim();

    /** @type {string[]} */
    let selectedClients = [];
    if (!clientAnswer) {
      selectedClients = statuses.filter((c) => c.detected && c.scope === "user").map((c) => c.id);
    } else {
      for (const tok of clientAnswer.split(",").map((s) => s.trim()).filter(Boolean)) {
        const asNum = Number(tok);
        if (Number.isInteger(asNum) && asNum >= 1 && asNum <= statuses.length) {
          selectedClients.push(statuses[asNum - 1].id);
        } else {
          const found = statuses.find((c) => c.id === tok.toLowerCase());
          if (found) selectedClients.push(found.id);
        }
      }
    }

    if (selectedClients.length === 0) {
      console.log("\nNo clients selected. Nothing was written.");
      return;
    }

    let repoRoot = opts.repoRoot;
    if (selectedClients.includes("claude-desktop") && !repoRoot) {
      repoRoot = (
        await rl.question(`Default REPO_ROOT for Claude Desktop (Enter for ${process.cwd()}): `)
      ).trim();
    }

    console.log("");
    for (const id of [...new Set(selectedClients)]) {
      const res = connectClient(id, {
        modules: selectedModules,
        databaseUrl,
        repoRoot,
      });
      console.log(`  [OK] Connected ${res.name}`);
      console.log(`       Config: ${res.configPath}`);
    }
    console.log(`\nEnabled modules: ${selectedModules.join(", ")}`);
    console.log("Restart or reconnect your AI assistant to start using dev-context.\n");
  } finally {
    rl.close();
  }
}
