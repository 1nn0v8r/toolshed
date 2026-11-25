// @ts-check
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CLI_TOOLS, MCP_MODULES, MCP_ENTRY, REPO_ROOT } from "../cli/catalog.js";
import {
  buildServerEntry,
  connectClient,
  detectClientStatuses,
  disconnectClient,
} from "../cli/clients.js";
import { createUiServer } from "../cli/ui/server.js";

describe("toolshed catalog", () => {
  it("points every CLI tool entry to an existing file", () => {
    assert.ok(CLI_TOOLS.length >= 10);
    for (const tool of CLI_TOOLS) {
      assert.ok(fs.existsSync(tool.entry), `Missing CLI entry for ${tool.id}: ${tool.entry}`);
    }
  });

  it("defines all 6 consolidated MCP modules", () => {
    const ids = MCP_MODULES.map((m) => m.id);
    assert.deepEqual(ids, ["core", "git-history", "diagnostics", "test-report", "web", "db"]);
  });
});

describe("client config manager", () => {
  it("connects and disconnects clients while preserving existing servers", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "toolshed-clients-"));
    try {
      const homeDir = path.join(tmp, "home");
      const cwd = path.join(tmp, "workspace");
      fs.mkdirSync(path.join(homeDir, ".cursor"), { recursive: true });
      fs.mkdirSync(cwd, { recursive: true });

      // Pre-populate an existing server that must be preserved.
      const cursorPath = path.join(homeDir, ".cursor", "mcp.json");
      fs.writeFileSync(
        cursorPath,
        JSON.stringify({ mcpServers: { existing: { command: "echo", args: ["hi"] } }, customKey: 42 }, null, 2),
        "utf8"
      );

      const res = connectClient("cursor", {
        homeDir,
        cwd,
        modules: ["core", "git-history", "diagnostics"],
      });
      assert.equal(res.configPath, cursorPath);

      const saved = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
      assert.equal(saved.customKey, 42);
      assert.deepEqual(saved.mcpServers.existing, { command: "echo", args: ["hi"] });
      assert.equal(saved.mcpServers["dev-context"].command, "node");
      assert.equal(saved.mcpServers["dev-context"].env.MCP_MODULES, "core,git-history,diagnostics");

      // VS Code uses "servers" root key and type: "stdio"
      const vs = connectClient("vscode", { homeDir, cwd, modules: ["core", "db"], databaseUrl: "postgres://u:p@localhost/db" });
      const vsJson = JSON.parse(fs.readFileSync(vs.configPath, "utf8"));
      assert.equal(vsJson.servers["dev-context"].type, "stdio");
      assert.equal(vsJson.servers["dev-context"].env.DATABASE_URL, "postgres://u:p@localhost/db");

      // Status detection reflects connected state
      const statuses = detectClientStatuses({ homeDir, cwd });
      const cursorStatus = statuses.find((s) => s.id === "cursor");
      assert.ok(cursorStatus?.connected);
      assert.deepEqual(cursorStatus?.configuredModules, ["core", "git-history", "diagnostics"]);

      // Disconnect removes only dev-context
      const disc = disconnectClient("cursor", { homeDir, cwd });
      assert.equal(disc.removed, true);
      const after = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
      assert.equal(after.mcpServers["dev-context"], undefined);
      assert.deepEqual(after.mcpServers.existing, { command: "echo", args: ["hi"] });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("builds forward-slash paths in server entries", () => {
    const entry = buildServerEntry({ modules: ["core"], entryPath: MCP_ENTRY });
    assert.ok(!String(entry.args[0]).includes("\\"));
  });
});

describe("toolshed Web UI server", () => {
  it("serves HTML, state, preview, and connect/disconnect APIs on 127.0.0.1", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "toolshed-ui-"));
    const homeDir = path.join(tmp, "home");
    const cwd = path.join(tmp, "repo");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    const server = createUiServer({ homeDir, cwd });
    await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const base = `http://127.0.0.1:${addr.port}`;

    try {
      const htmlRes = await fetch(`${base}/`);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.ok(html.includes("toolshed"));

      const stateRes = await fetch(`${base}/api/state`);
      assert.equal(stateRes.status, 200);
      const state = await stateRes.json();
      assert.equal(state.ok, true);
      assert.equal(state.modules.length, 6);
      assert.ok(state.clients.length >= 5);

      const previewRes = await fetch(`${base}/api/preview-config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modules: ["core", "test-report"] }),
      });
      const preview = await previewRes.json();
      assert.equal(preview.ok, true);
      assert.equal(preview.snippet.mcpServers["dev-context"].env.MCP_MODULES, "core,test-report");

      const connectRes = await fetch(`${base}/api/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "cursor", modules: ["core", "diagnostics"] }),
      });
      const connected = await connectRes.json();
      assert.equal(connected.ok, true);
      assert.ok(connected.clients.find((c) => c.id === "cursor").connected);

      const discRes = await fetch(`${base}/api/disconnect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "cursor" }),
      });
      const disconnected = await discRes.json();
      assert.equal(disconnected.ok, true);
      assert.equal(disconnected.clients.find((c) => c.id === "cursor").connected, false);

      // Origin guard rejects foreign origins
      const evilRes = await fetch(`${base}/api/state`, {
        headers: { Origin: "https://evil.example" },
      });
      assert.equal(evilRes.status, 403);
    } finally {
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("toolshed CLI binary", () => {
  const binPath = path.join(REPO_ROOT, "bin", "toolshed.js");

  it("prints help and status", () => {
    const help = spawnSync(process.execPath, [binPath, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.ok(help.stdout.includes("toolshed ui"));
    assert.ok(help.stdout.includes("toolshed setup"));

    const status = spawnSync(process.execPath, [binPath, "status"], { encoding: "utf8" });
    assert.equal(status.status, 0);
    assert.ok(status.stdout.includes("dev-context-mcp"));
  });

  it("dispatches to bundled CLI tools (diff-brief, diagnostics)", () => {
    const db = spawnSync(process.execPath, [binPath, "diff-brief", "--help"], { encoding: "utf8" });
    assert.equal(db.status, 0);
    assert.ok((db.stdout + db.stderr).toLowerCase().includes("diff"));

    const diag = spawnSync(process.execPath, [binPath, "diagnostics", "--help"], { encoding: "utf8" });
    assert.equal(diag.status, 0);
  });
});
