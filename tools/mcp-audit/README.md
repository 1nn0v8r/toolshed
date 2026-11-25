# mcp-audit

A fast, zero-dependency CLI that audits MCP servers and client configs for upfront token tax, schema bloat, tool name collisions, and config hygiene.

- **Runs on:** Windows, macOS and Linux
- **Requires:** Node.js 20 or newer
- **License:** AGPL-3.0-only

---

## Contents

- [Why](#why)
- [Install](#install)
- [Usage](#usage)
- [Options](#options)
- [Configuration](#configuration)
- [What it checks](#what-it-checks)
- [Exit codes](#exit-codes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Why

Connecting multiple Model Context Protocol (MCP) servers can quietly consume tens of thousands of tokens on every turn before you type a single prompt. Bloated tool descriptions, deeply nested schemas, duplicate tool names across servers, unpinned `npx` launches, and literal secrets in `.mcp.json` degrade agent accuracy and inflate costs.

`mcp-audit` connects to stdio MCP servers (or reads a config or saved JSON payload), measures the exact token footprint per server and per tool, enforces token budgets in CI, and flags schema and config issues early.

---

## Install

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/mcp-audit
npm install
```

Run it directly with Node.js:

```bash
node /abs/path/to/toolshed/tools/mcp-audit/src/cli.js --help
```

Or install the `mcp-audit` binary globally:

```bash
npm install -g .
mcp-audit --help
```

---

## Usage

```bash
# Auto-discover .mcp.json, .cursor/mcp.json, or .vscode/mcp.json in current directory
mcp-audit

# Audit a specific MCP config file
mcp-audit --config /abs/path/to/.mcp.json

# Audit a single stdio MCP server directly
mcp-audit -- node /abs/path/to/server.js

# Enforce a total upfront token budget in CI (exits 1 if exceeded)
mcp-audit --budget 8000 --strict

# Static config audit only (do not spawn MCP server processes)
mcp-audit --no-connect

# Audit a saved tools/list JSON file or stdin
cat tools-list.json | mcp-audit --from-json -

# Machine-readable JSON report
mcp-audit --json
```

Sample output:

```
mcp-audit: .mcp.json (offline estimate: chars / 4)

Servers:
  tokens   share   tools  prompts  resources  status    server
   1,420   71.0%       5        0          0  ok        git-history
     580   29.0%       2        1          0  ok        test-report

Top tools (7 of 7):
  tokens   desc  schema  depth  server/tool
     410     68     342      2  git-history/file_history
     295     52     243      1  test-report/run_tests

Findings (1):
  [WARN]  tool.bloated (git-history/file_history): Tool schema costs ~410 tokens (warn threshold 300)

Total: 2,000 tokens (7,998 bytes) across 7 tools, 1 prompts, 0 resources
Budget: OK (2,000 / 8,000 tokens)
Summary: 0 errors, 1 warnings, 3 info (3 info hidden; pass --verbose to show)
Status: OK
```

---

## Options

| Option | Description | Default |
|---|---|---|
| `[dir \| config-file]` | Directory to auto-discover an MCP config or path to a config file | Current directory |
| `-- <command> [args...]` | Directly spawn and audit a single stdio MCP server | |
| `--config <file>` | Explicit MCP config file path | Auto-discovered |
| `--from-json <file>` | Audit a saved `tools/list` JSON file (or `-` for stdin) | |
| `--server <name>` | Only audit the named server (repeatable) | All servers |
| `--budget <tokens>` | Exit 1 when total estimated tokens exceed `<tokens>` | None |
| `--max-tool-tokens <n>` | Error threshold for a single tool schema | `600` |
| `--warn-tool-tokens <n>` | Warning threshold for a single tool schema | `300` |
| `--top <n>` | Maximum tools shown in the Top tools table (`0` = all) | `10` |
| `--timeout <ms>` | Per-server stdio handshake timeout in milliseconds | `8000` |
| `--no-connect`, `--static` | Audit config statically without spawning server processes | `false` |
| `--ignore-rule <rule>` | Suppress a lint rule ID (repeatable) | `[]` |
| `--strict` | Treat warnings as errors (exit 1) | `false` |
| `--verbose` | Show `[INFO]` findings (such as `annotations.missing`) | `false` |
| `--json` | Output the full report as JSON | `false` |
| `-h`, `--help` | Show help | |
| `-v`, `--version` | Show version | |

---

## Configuration

Add a `.mcp-audit.json` file in your project root (or an `"mcp-audit"` section in `package.json`):

```json
{
  "budget": 8000,
  "maxToolTokens": 600,
  "warnToolTokens": 300,
  "maxDescriptionChars": 300,
  "maxSchemaDepth": 4,
  "maxSchemaProps": 12,
  "timeoutMs": 8000,
  "ignoreRules": ["annotations.missing"],
  "ignoreServers": ["disabled-legacy"]
}
```

CLI flags override values in `.mcp-audit.json`.

Supported MCP config files for auto-discovery (checked in order):
1. `.mcp.json`
2. `.cursor/mcp.json`
3. `.vscode/mcp.json`
4. `mcp.json`

Both `"mcpServers"` (Claude, Cursor, Windsurf) and `"servers"` (VS Code) config keys are supported. `${VAR}` references in `env` blocks are expanded from your environment when spawning stdio servers.

---

## What it checks

| Rule ID | Severity | What it catches |
|---|---|---|
| `tool.bloated` | `warn` / `error` | Tool schema + description exceeds `warnToolTokens` or `maxToolTokens`. |
| `tool.duplicate-name` | `error` | Two or more enabled servers expose the same tool name. |
| `description.missing` | `warn` | Tool has an empty or missing description. |
| `description.verbose` | `warn` | Tool description exceeds `maxDescriptionChars` (default 300). |
| `schema.deep` | `warn` | `inputSchema` nesting depth exceeds `maxSchemaDepth` (default 4). |
| `schema.wide` | `warn` | `inputSchema` has more than `maxSchemaProps` top-level properties (default 12). |
| `schema.unbounded-enum` | `warn` | An `enum` inside `inputSchema` has more than 25 values. |
| `annotations.missing` | `info` | Tool does not declare MCP `annotations` (`readOnlyHint`, `destructiveHint`, etc.). |
| `config.hardcoded-secret` | `error` | Literal secret or API token inside `env` instead of `${VAR}` interpolation. |
| `config.unpinned-npx` | `warn` | `npx`, `pnpx`, `bunx`, or `uvx` invocation without a pinned package version. |
| `config.personal-path` | `warn` | Machine-specific home directory path in `command`, `args`, or `cwd`. |
| `server.connect-failed` | `error` | Stdio MCP server failed to start, crashed, or timed out. |

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Audit passed within budget and without errors (or warnings under `--strict`). |
| `1` | Token budget exceeded, one or more errors found, or warnings found with `--strict`. |
| `2` | Usage error: invalid CLI flag, missing MCP config, or malformed JSON. |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `No MCP config found` (exit 2) | Pass `--config <file>`, use `-- <command> [args...]` to audit a server directly, or use `--from-json <file>`. |
| `Timed out after 8000ms` | Increase `--timeout <ms>` for servers that install packages on startup, or pin dependencies first. |
| Remote `http`/`sse` server shows `skipped` | Stdio introspection spawns local commands; export the server's `tools/list` JSON and pass `--from-json`. |
| Want only config hygiene without launching servers | Pass `--no-connect` (or `--static`). |

---

## Development

```bash
npm install
npm test
npm run typecheck
npm run coverage
```
