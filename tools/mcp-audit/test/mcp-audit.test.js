// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildReport, estimateTokens, inspectSchema } from "../src/analyzer.js";
import { auditServerConfig, DEFAULT_OPTIONS, parseMcpConfig } from "../src/config.js";
import { buildChildEnv, inspectStdioServer } from "../src/mcp-client.js";
import { run } from "../src/main.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = path.join(HERE, "fixtures", "mock-mcp-server.js");
const CLI_PATH = path.resolve(HERE, "..", "src", "cli.js");

/** @type {string[]} */
const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-audit-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("analyzer", () => {
  it("estimates tokens consistently with chars / 4", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
  });

  it("inspects schema depth, top-level props, and max enum size", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string", enum: Array.from({ length: 30 }, (_, i) => `v${i}`) },
        nested: {
          type: "object",
          properties: {
            deep: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  leaf: { type: "string" },
                },
              },
            },
          },
        },
      },
    };
    const stats = inspectSchema(schema);
    assert.equal(stats.topLevelProps, 2);
    assert.equal(stats.maxEnumSize, 30);
    assert.ok(stats.depth >= 4);
  });

  it("flags bloated tools, missing descriptions, deep schemas, and duplicate tool names", () => {
    const bigDesc = "x".repeat(1400);
    const report = buildReport({
      source: ".mcp.json",
      strict: false,
      top: 10,
      options: { ...DEFAULT_OPTIONS, maxToolTokens: 300, warnToolTokens: 150, maxDescriptionChars: 200 },
      servers: [
        {
          name: "alpha",
          transport: "stdio",
          status: "ok",
          tools: [
            { name: "shared_search", description: bigDesc, inputSchema: { type: "object" } },
            { name: "no_desc", description: "", inputSchema: { type: "object" } },
          ],
          prompts: [],
          resources: [],
          staticFindings: [],
        },
        {
          name: "beta",
          transport: "stdio",
          status: "ok",
          tools: [
            {
              name: "shared_search",
              description: "Search beta.",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
          ],
          prompts: [],
          resources: [],
          staticFindings: [],
        },
      ],
    });

    assert.equal(report.ok, false);
    const rules = new Set(report.findings.map((f) => f.rule));
    assert.ok(rules.has("tool.bloated"));
    assert.ok(rules.has("description.verbose"));
    assert.ok(rules.has("description.missing"));
    assert.ok(rules.has("tool.duplicate-name"));
    assert.ok(rules.has("annotations.missing"));
  });
});

describe("config static hygiene", () => {
  it("parses mcpServers and VS Code servers formats", () => {
    const claude = parseMcpConfig(
      { mcpServers: { docs: { command: "node", args: ["server.js"] } } },
      ".mcp.json",
    );
    assert.equal(claude.length, 1);
    assert.equal(claude[0].transport, "stdio");

    const vscode = parseMcpConfig(
      { servers: { remote: { type: "http", url: "https://example.com/mcp" } } },
      ".vscode/mcp.json",
    );
    assert.equal(vscode.length, 1);
    assert.equal(vscode[0].transport, "remote");
  });

  it("flags unpinned npx/uvx, personal paths, and hardcoded secrets while allowing env interpolation", () => {
    const fakeSecret = ["sk", "proj", "abcdefghijklmnop123456"].join("-");
    const personalHome = ["", "Users", "alice", "dev", "server.js"].join("/");

    const bad = auditServerConfig({
      name: "bad",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", personalHome],
      env: {
        OPENAI_API_KEY: fakeSecret,
        GOOD_VAR: "${MY_RUNTIME_TOKEN}",
        PLACEHOLDER_KEY: "your-api-key-here",
      },
      disabled: false,
    });

    const rules = bad.map((f) => f.rule);
    assert.ok(rules.includes("config.unpinned-npx"));
    assert.ok(rules.includes("config.personal-path"));
    assert.ok(rules.includes("config.hardcoded-secret"));
    const secretFinding = bad.find((f) => f.rule === "config.hardcoded-secret");
    assert.ok(secretFinding);
    assert.ok(!secretFinding.message.includes(fakeSecret));

    const pinned = auditServerConfig({
      name: "pinned",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem@2025.3.28"],
      env: { API_TOKEN: "${API_TOKEN}" },
      disabled: false,
    });
    assert.equal(pinned.length, 0);
  });

  it("expands ${VAR} env references when building child env", () => {
    const env = buildChildEnv({ TOKEN: "bearer-${MY_SECRET}" }, { MY_SECRET: "xyz" });
    assert.equal(env.TOKEN, "bearer-xyz");
  });
});

describe("mcp-client live stdio handshake", () => {
  it("connects, initializes, and collects tools, prompts, and resources", async () => {
    const res = await inspectStdioServer({
      command: process.execPath,
      args: [MOCK_SERVER, "noisy"],
      timeoutMs: 5000,
    });
    assert.equal(res.serverInfo.name, "mock-mcp");
    assert.equal(res.tools.length, 2);
    assert.equal(res.prompts.length, 1);
    assert.equal(res.resources.length, 1);
  });

  it("follows nextCursor pagination on tools/list", async () => {
    const res = await inspectStdioServer({
      command: process.execPath,
      args: [MOCK_SERVER, "paginated"],
      timeoutMs: 5000,
    });
    assert.deepEqual(
      res.tools.map((t) => t.name),
      ["page_one_tool", "page_two_tool"],
    );
  });

  it("times out cleanly when server hangs", async () => {
    await assert.rejects(
      () =>
        inspectStdioServer({
          command: process.execPath,
          args: [MOCK_SERVER, "hang"],
          timeoutMs: 250,
        }),
      /Timed out after 250ms/,
    );
  });
});

describe("CLI end-to-end", () => {
  it("audits a live stdio command via -- and enforces --budget", async () => {
    let out = "";
    let err = "";
    const codeOk = await run(["--json", "--", process.execPath, MOCK_SERVER], {
      cwd: process.cwd(),
      out: (s) => (out += s),
      err: (s) => (err += s),
    });
    assert.equal(codeOk, 0);
    assert.equal(err, "");
    const parsed = JSON.parse(out);
    assert.equal(parsed.totalTools, 2);
    assert.equal(parsed.totalPrompts, 1);
    assert.equal(parsed.totalResources, 1);
    assert.ok(parsed.totalTokens > 0);

    let outOver = "";
    const codeOver = await run(["--budget", "1", "--", process.execPath, MOCK_SERVER], {
      cwd: process.cwd(),
      out: (s) => (outOver += s),
      err: () => {},
    });
    assert.equal(codeOver, 1);
    assert.match(outOver, /Budget: EXCEEDED/);
  });

  it("discovers .mcp.json in a project directory and respects --no-connect", async () => {
    const dir = makeTempDir();
    mkdirSync(path.join(dir, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          mock: { command: process.execPath, args: [MOCK_SERVER] },
          disabledSrv: { command: process.execPath, args: [MOCK_SERVER], disabled: true },
        },
      }),
    );

    let out = "";
    const code = await run([dir, "--json"], {
      cwd: dir,
      out: (s) => (out += s),
      err: () => {},
    });
    assert.equal(code, 0);
    const report = JSON.parse(out);
    assert.equal(report.servers.length, 2);
    assert.equal(report.servers[0].status, "ok");
    assert.equal(report.servers[1].status, "disabled");

    let staticOut = "";
    const staticCode = await run([dir, "--no-connect", "--json"], {
      cwd: dir,
      out: (s) => (staticOut += s),
      err: () => {},
    });
    assert.equal(staticCode, 0);
    const staticReport = JSON.parse(staticOut);
    assert.equal(staticReport.servers[0].status, "skipped");
  });

  it("audits --from-json stdin and enforces --strict", async () => {
    const payload = JSON.stringify({
      tools: [
        {
          name: "bare_tool",
          description: "",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });

    let out = "";
    const codeWarn = await run(["--from-json", "-"], {
      cwd: process.cwd(),
      stdinText: payload,
      out: (s) => (out += s),
      err: () => {},
    });
    assert.equal(codeWarn, 0);

    const codeStrict = await run(["--from-json", "-", "--strict"], {
      cwd: process.cwd(),
      stdinText: payload,
      out: () => {},
      err: () => {},
    });
    assert.equal(codeStrict, 1);
  });

  it("spawns the real cli.js binary and returns exit code 2 on missing config", () => {
    const emptyDir = makeTempDir();
    const res = spawnSync(process.execPath, [CLI_PATH], {
      cwd: emptyDir,
      encoding: "utf8",
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /No MCP config found/);
  });
});
