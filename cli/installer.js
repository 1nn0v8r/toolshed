// @ts-check
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { MCP_DIR, MCP_ENTRY, CLI_TOOLS } from "./catalog.js";

/**
 * Check whether dev-context-mcp and optional CLI dependencies are installed and built.
 */
export function getInstallStatus() {
  const mcpDepsInstalled = fs.existsSync(path.join(MCP_DIR, "node_modules"));
  const mcpBuilt = fs.existsSync(MCP_ENTRY);
  const cliReady = CLI_TOOLS.map((t) => ({
    id: t.id,
    name: t.name,
    category: t.category,
    description: t.description,
    example: t.example,
    needsInstall: t.needsInstall,
    ready: !t.needsInstall || (t.dir ? fs.existsSync(path.join(t.dir, "node_modules")) : true),
  }));

  return {
    mcp: {
      dir: MCP_DIR,
      entry: MCP_ENTRY,
      depsInstalled: mcpDepsInstalled,
      built: mcpBuilt,
      ready: mcpDepsInstalled && mcpBuilt,
    },
    cliTools: cliReady,
  };
}

/**
 * Run npm install (and build for MCP) inside a directory, streaming output to optional callback.
 * @param {string} dir
 * @param {string[]} args
 * @param {(chunk: string) => void} [onOutput]
 * @returns {Promise<{ ok: boolean, code: number, output: string }>}
 */
function runNpm(dir, args, onOutput) {
  return new Promise((resolve) => {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(npmCmd, args, {
      cwd: dir,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let output = "";
    const handle = (buf) => {
      const s = buf.toString("utf8");
      output += s;
      if (onOutput) onOutput(s);
    };
    child.stdout.on("data", handle);
    child.stderr.on("data", handle);
    child.on("error", (err) => {
      const msg = err.message;
      output += msg;
      if (onOutput) onOutput(msg);
      resolve({ ok: false, code: 1, output });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, code: code ?? 1, output });
    });
  });
}

/**
 * Ensure dev-context-mcp has dependencies installed and dist/server.js compiled.
 * @param {{ force?: boolean, onOutput?: (chunk: string) => void }} [opts]
 */
export async function ensureMcpReady(opts = {}) {
  const status = getInstallStatus().mcp;
  if (!opts.force && status.ready) {
    return { ok: true, skipped: true, output: "dev-context-mcp is already installed and built." };
  }

  if (opts.force || !status.depsInstalled) {
    const res = await runNpm(MCP_DIR, ["install"], opts.onOutput);
    if (!res.ok) return { ok: false, skipped: false, output: res.output };
  }

  if (opts.force || !fs.existsSync(MCP_ENTRY)) {
    const res = await runNpm(MCP_DIR, ["run", "build"], opts.onOutput);
    if (!res.ok) return { ok: false, skipped: false, output: res.output };
  }

  return { ok: true, skipped: false, output: "dev-context-mcp installed and built successfully." };
}

/**
 * Ensure a CLI tool with dependencies (e.g. repo-pack) has its node_modules installed.
 * @param {string} toolId
 * @param {(chunk: string) => void} [onOutput]
 */
export async function ensureCliToolReady(toolId, onOutput) {
  const tool = CLI_TOOLS.find((t) => t.id === toolId);
  if (!tool) throw new Error(`Unknown CLI tool: ${toolId}`);
  if (!tool.needsInstall || !tool.dir) return { ok: true, skipped: true, output: "Zero dependencies." };
  if (fs.existsSync(path.join(tool.dir, "node_modules"))) {
    return { ok: true, skipped: true, output: "Already installed." };
  }
  const res = await runNpm(tool.dir, ["install"], onOutput);
  return { ok: res.ok, skipped: false, output: res.output };
}
