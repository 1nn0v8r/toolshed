#!/usr/bin/env node
// @ts-check
import fs from "node:fs";
import { parseWithPreset } from "./detect.js";
import { filterDiagnostics } from "./filters.js";
import { formatDiagnostics } from "./format.js";
import { runCommand } from "./runner.js";
import { startServer } from "./server.js";

const HELP = `diagnostics-trim-mcp: token-compact, deduplicated diagnostics for AI assistants.

Usage:
  diagnostics-trim-mcp [options] -- <command...>
  <command> | diagnostics-trim-mcp [options]
  diagnostics-trim-mcp --server

Options:
  --preset <auto|tsc|eslint|python|cargo>  Parser preset (default: auto)
  --max <n>                               Maximum diagnostics to show (default: 15)
  --no-snippets                           Do not include source code snippets
  --server                                Start MCP server on stdio
  -h, --help                              Show this help
  -v, --version                           Show the version
`;

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (argv.includes("-v") || argv.includes("--version")) {
    process.stdout.write("0.1.0\n");
    process.exit(0);
  }

  if (argv.includes("--server")) {
    await startServer();
    return;
  }

  /** @type {'auto' | 'tsc' | 'eslint' | 'python' | 'cargo'} */
  let preset = "auto";
  let max = 15;
  let snippets = true;
  let command = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      command = argv.slice(i + 1).join(" ");
      break;
    }
    if (a === "--preset" && argv[i + 1]) {
      preset = /** @type {any} */ (argv[++i]);
    } else if (a === "--max" && argv[i + 1]) {
      max = parseInt(argv[++i], 10) || 15;
    } else if (a === "--no-snippets") {
      snippets = false;
    }
  }

  if (command) {
    const { exitCode, output } = await runCommand(command, process.cwd());
    const rawList = parseWithPreset(output, preset);
    const { kept, suppressedCount } = filterDiagnostics(rawList);
    const report = formatDiagnostics(kept, {
      root: process.cwd(),
      maxErrors: max,
      suppressedCount,
      includeSnippets: snippets,
    });
    process.stdout.write(report + "\n");
    process.exit(exitCode !== 0 ? 1 : 0);
  }

  // If stdin has data piped into it
  if (!process.stdin.isTTY) {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    const rawList = parseWithPreset(input, preset);
    const { kept, suppressedCount } = filterDiagnostics(rawList);
    const report = formatDiagnostics(kept, {
      root: process.cwd(),
      maxErrors: max,
      suppressedCount,
      includeSnippets: snippets,
    });
    process.stdout.write(report + "\n");
    process.exit(kept.length > 0 ? 1 : 0);
  }

  // Default to server mode if run standalone
  await startServer();
}

main().catch((err) => {
  process.stderr.write(`diagnostics-trim-mcp: ${err.message}\n`);
  process.exit(2);
});
