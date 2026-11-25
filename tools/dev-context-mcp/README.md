# dev-context-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI coding assistants (Claude Code, Claude Desktop, Cursor, VS Code and others) a curated, repo-scoped toolset: search, read and edit files, inspect git, run quality checks and shell commands, and browse the web.

Every tool returns **compact, capped output**, so your assistant spends fewer tokens per task than it does with raw `cat`, `grep`, `find` and `git` calls.

- **Runs on:** Windows, macOS and Linux (Node.js 20 or newer)
- **Transports:** stdio (local, default) or Streamable HTTP (hardened, for containers and shared servers)
- **License:** MIT

---

## Contents

- [Why it saves tokens](#why-it-saves-tokens)
- [Install](#install)
- [Connect your assistant](#connect-your-assistant)
- [Tools](#tools)
- [Configuration](#configuration)
- [Run as a container (HTTP)](#run-as-a-container-http)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Why it saves tokens

| Technique | Example |
|---|---|
| **Summaries instead of files** | `get_env_vars` returns key names only. `get_package_summary` returns script and dependency names. `get_architecture_docs` returns titles, short summaries and key rules. |
| **Hard output caps** | 150 lines per file by default, 30 grep matches, 10 search hits, 300 tree entries, about 4k tokens for manifests. |
| **Head and tail clipping** | Long command output keeps the start and the end, so test and build summaries survive. |
| **Noise excluded** | `node_modules`, `dist`, `build`, `coverage`, lockfiles, source maps and logs are never searched. |
| **Fewer round trips** | `read_multiple_files` reads up to 5 files in one call. |
| **Fast search** | Uses [ripgrep](https://github.com/BurntSushi/ripgrep) when installed, with a short-lived file list cache. |

---

## Install

You need **Node.js 20+** and **git**. [ripgrep](https://github.com/BurntSushi/ripgrep#installation) is optional but makes search faster.

### Easiest: Visual Web UI or CLI wizard (from repo root)

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed
npm run ui       # Visual dashboard to toggle modules & connect AI clients
# or:
npm run setup    # Interactive terminal setup wizard
```

### Manual install

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/dev-context-mcp
npm install
```

`npm install` also compiles the server to `dist/`. The entry point you register with a client is:

```
<where you cloned>/toolshed/tools/dev-context-mcp/dist/server.js
```

Print the exact absolute path for your machine:

```bash
node -e "console.log(require('path').resolve('dist/server.js'))"
```

### Optional: install as a global command

```bash
npm install -g .
```

This puts `dev-context-mcp` on your `PATH`. Registering with `node` and the absolute path (below) works the same on every OS, so prefer that unless you need the short command.

### Updating

```bash
cd toolshed && git pull
cd tools/dev-context-mcp && npm install
```

Then restart or reconnect the MCP server in your client.

---

## Connect your assistant

Replace `/abs/path/to/dist/server.js` with the path printed above. On Windows use either forward slashes (`C:/code/toolshed/...`) or escaped backslashes (`C:\\code\\toolshed\\...`) inside JSON.

> **Which repo does it work on?** By default the server walks up from the directory it was launched in to the nearest git root. Terminal clients like Claude Code launch it inside your project, so this just works. Desktop apps usually launch it from their own directory, so set `REPO_ROOT` in the config, or ask the assistant to call `set_repo_root`.

### Claude Code

```bash
claude mcp add dev-context --scope user -- node /abs/path/to/dist/server.js
```

`--scope user` makes it available in every project. Check it with `claude mcp list`.

### Claude Desktop

Edit `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "dev-context": {
      "command": "node",
      "args": ["/abs/path/to/dist/server.js"],
      "env": { "REPO_ROOT": "/abs/path/to/your/project" }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "dev-context": {
      "command": "node",
      "args": ["/abs/path/to/dist/server.js"]
    }
  }
}
```

### VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "dev-context": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/dist/server.js"],
      "env": { "REPO_ROOT": "${workspaceFolder}" }
    }
  }
}
```

### Any other MCP client

Run `node /abs/path/to/dist/server.js` as a stdio server. For remote or shared use, see [Run as a container](#run-as-a-container-http).

### Tell the assistant to prefer it

Assistants still reach for their built-in tools out of habit. Add a short rule to your global instructions (for example `~/.claude/CLAUDE.md`):

```markdown
When the dev-context MCP is connected, prefer it for code search (search_code, grep,
find_references), reading several files (read_multiple_files), git (get_git_status,
get_recent_changes), package info (get_package_summary) and env keys (get_env_vars).
```

---

## Tools

`dev-context-mcp` v4 consolidates all dev MCP capabilities into one server with **6 toggleable modules**:

- `core` (default ON): Orientation, search, read/write, git status, scripts, shell
- `git-history` (default ON): `file_history`, `blame_range`, `line_origin`, `commit_details`, `search_commits`, `churn`, `contributors`
- `diagnostics` (default ON): `check_diagnostics`, `trim_diagnostics` (deduplicated `tsc`, `eslint`, `pyright`, `ruff`, `cargo` diagnostics)
- `test-report` (default ON): `detect_test_runner`, `run_tests`, `parse_report`, `list_failures_from_last_run`
- `web` (default ON): `fetch_url`, `web_search`, `browse_page`, `screenshot`
- `db` (auto-enabled when `DATABASE_URL` is set): `list_tables`, `describe_table`, `list_relationships`, `sample_rows`, `run_select`, `connection_info`

Control modules with `MCP_MODULES=core,git-history,diagnostics,test-report` (or `MCP_DISABLED_MODULES=web`), or visually in `toolshed ui`.

### Orientation

| Tool | Returns |
|---|---|
| `get_project_manifest` | Compact JSON project summary: stack, scripts, key directories, modules, config files. Reads `.claude/manifest.json` if present, else auto-detects. Secrets redacted. |
| `get_project_tree` | Sorted file tree (default depth 3, up to 300 entries). |
| `get_architecture_docs` | Index of docs in `.claude/docs/`, `docs/architecture/` and `docs/adr/` with summaries and key rules, or one doc in full (capped). |
| `get_project_context` | Project notes such as `NOTES.md`, `TODO.md` and `.claude/notes/`. |
| `get_package_summary` | Scripts and dependency names from `package.json`. Supports monorepo `module`. |
| `get_env_vars` | Keys from `.env*` files. Never values. |

### Read and search

| Tool | Returns |
|---|---|
| `read_file_range` | A line window from one file (default 150 lines from `startLine`, max 300). |
| `read_multiple_files` | Up to 5 files in one call, 150 lines each by default. |
| `read_doc` | One Markdown or text doc. |
| `list_directory` | One folder's entries. |
| `find_files` | Files matching a glob. |
| `grep` | Regex matches as `file:line: text`. |
| `search_code` | Substring search across source and config files, with context. |
| `search_docs` | Substring search across Markdown docs. |
| `find_references` | Every reference to a symbol. |
| `find_exports` | Export statements for a name (JS/TS). |
| `find_api_endpoint` | Route and endpoint definitions. |
| `find_schema` | Schemas, validators, types, Prisma and SQL. |
| `find_todos` | `TODO`, `FIXME`, `HACK` and `NOTE:` markers. |
| `get_audit_summaries`, `search_audits` | Audit notes in `.claude/audits/`. |

### Git and quality

| Tool | Returns |
|---|---|
| `get_git_status` | Branch, short status, recent commits, optional staged diff. |
| `get_recent_changes` | Files changed in the last N commits plus a diff stat. |
| `get_typecheck_errors` | Output of `typecheck`, else `build`, else `tsc --noEmit`. |
| `get_test_failures` | Output of `npm test`. |
| `run_script` | Runs a script defined in `package.json` (refuses unknown names). |
| `run_command` | Any shell command (escape hatch). |

### Write

| Tool | Does |
|---|---|
| `edit_file` | Exact, unique string replacement. |
| `write_file` | Create or overwrite a file. |
| `delete_file` | Delete a file (requires `confirm: true`). |
| `set_repo_root` | Switch the active repo for the session. |

Every repo-aware tool also accepts an optional `repoRoot` argument, so one session can work across several repos safely.

### Web

| Tool | Does |
|---|---|
| `fetch_url` | Fetches a URL and strips HTML to text (15k characters by default). |
| `web_search` | SearXNG (`SEARXNG_URL`), then Tavily (`TAVILY_API_KEY`), then keyless DuckDuckGo. |
| `browse_page` | Renders a JavaScript page with Playwright and returns its text. |
| `screenshot` | Playwright PNG, saved in the repo or returned inline. |

`browse_page` and `screenshot` need Playwright, which is optional (about 700 MB):

```bash
npm install playwright && npx playwright install chromium
```

---

## Configuration

All settings are environment variables. None are required for local stdio use.

| Variable | Effect |
|---|---|
| `REPO_ROOT` | Pin the starting repo root. |
| `MCP_SHELL` | Shell for `run_command`. Default: `/bin/sh` on macOS/Linux; Git Bash on Windows when installed, else `cmd.exe`. |
| `MCP_RIPGREP_PATH` | Explicit `rg` binary. Otherwise found on `PATH`, else a JavaScript fallback is used. |
| `SEARXNG_URL` | Use a SearXNG instance for `web_search`. |
| `TAVILY_API_KEY` | Use Tavily for `web_search` when `SEARXNG_URL` is unset. |
| `MCP_TRANSPORT` | `stdio` (default) or `http`. The flags `--stdio` and `--http` also work. |
| `MCP_HTTP_HOST`, `MCP_HTTP_PORT` | HTTP bind address. Default `127.0.0.1:3000`. |
| `MCP_AUTH_TOKEN` | Bearer token. **Required** for HTTP. |
| `MCP_ROOT_BASE` | In HTTP mode, `set_repo_root` and `repoRoot` must stay under this folder. |
| `MCP_ALLOW_EXEC`, `MCP_ALLOW_WRITE`, `MCP_ALLOW_ADMIN` | Enable risky tool tiers in HTTP mode. `MCP_DANGEROUS=1` enables all three. |

---

## Run as a container (HTTP)

The Docker stack runs the server with browser tools plus a private [SearXNG](https://github.com/searxng/searxng) search backend. With [`just`](https://github.com/casey/just) installed:

```bash
just up      # creates .env with random secrets on first run, then starts the stack
just url     # endpoint to give your client
just token   # bearer token your client must send
just down    # stop everything
```

Without `just`, copy `.env.example` to `.env`, fill in `MCP_AUTH_TOKEN` and `SEARXNG_SECRET` (for example with `openssl rand -hex 32`), set `WORKSPACE` to the repo to mount, then run `docker compose up -d --build`.

Point your client at `http://127.0.0.1:3000/mcp` with the header `Authorization: Bearer <token>`. Use `just up-lean` (or `MCP_TARGET=runtime`) for a much smaller image without browser tools.

A PM2 config (`ecosystem.config.cjs`) is included for running the HTTP server without Docker.

---

## Security model

Tools are grouped into capability tiers:

| Tier | Tools | stdio | HTTP default |
|---|---|:-:|:-:|
| read | read, search, git, context, env keys | on | on |
| web | `fetch_url`, `web_search`, `browse_page`, `screenshot` | on | on, with SSRF guard |
| exec | `run_command`, `run_script`, typecheck, tests | on | off (`MCP_ALLOW_EXEC=1`) |
| write | `write_file`, `edit_file`, `delete_file` | on | off (`MCP_ALLOW_WRITE=1`) |
| admin | `set_repo_root` | on | off (`MCP_ALLOW_ADMIN=1`) |

- **stdio is full power by design.** It runs as you, on your machine, for one client.
- **HTTP is hardened.** It needs a bearer token, binds to loopback, hides disabled tiers from the tool list and refuses them at call time.
- **Path sandbox.** File paths cannot escape the active repo root.
- **SSRF guard.** In HTTP mode, web tools block private and loopback addresses, rechecked across redirects.
- **Untrusted content.** File, search and web output is labelled as data so the model does not follow instructions inside it.

Only expose the HTTP server beyond localhost behind a TLS reverse proxy.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Client shows the server as failed | Run `node /abs/path/to/dist/server.js` in a terminal. It should print `dev-context-mcp v3 running` and wait. If `dist/` is missing, run `npm install` again. |
| Tools operate on the wrong folder | Set `REPO_ROOT` in the client config, or call `set_repo_root`. |
| `run_command` fails on Windows with POSIX commands | Install [Git for Windows](https://git-scm.com/download/win) for Git Bash, or set `MCP_SHELL`. |
| Search is slow on large repos | Install ripgrep. |
| `browse_page` says Playwright is missing | Run the Playwright install command under [Web](#web). |
| Changes to `src/` have no effect | Run `npm run build`, then reconnect the server. |

---

## Development

```bash
npm run dev         # run from source with tsx (stdio)
npm run typecheck   # tsc --noEmit (tsx does not typecheck)
npm run build       # compile to dist/
npm test            # smoke test: stdio, search, fetch_url, HTTP auth and tier gating
```

Source layout:

| File | Role |
|---|---|
| `src/server.ts` | Server factory and tool dispatch |
| `src/tools.ts` | Tool definitions (names, descriptions, input schemas) |
| `src/search.ts` | ripgrep integration and file list cache |
| `src/web.ts` | Web and browser tools |
| `src/security.ts` | Capability tiers and root confinement |
| `src/http.ts` | Streamable HTTP transport and auth |
| `src/util.ts` | Shared helpers (output clipping, path sandbox) |

See the repo's [contributing guide](../../CONTRIBUTING.md) before opening a pull request.
