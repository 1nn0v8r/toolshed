# dev-context-mcp

A Model Context Protocol (MCP) server that gives an AI coding assistant a curated,
repo-scoped toolset — read/search/edit files, run quality checks, inspect git, run
shell commands, **and browse the web** — instead of reaching for raw
`cat`/`grep`/`find`/`bash`/`curl`.

It runs two ways:

| Transport | Posture | Use it for |
|-----------|---------|------------|
| **stdio** (default) | **full power** — every tool on, no token | Your local machine, one client per session (the normal Claude Code setup). |
| **http** (Streamable HTTP) | **hardened** — bearer token required, binds loopback, dangerous tools off by default | Containers, shared/remote servers, many concurrent clients. |

- **Source:** [`src/`](src) — `server.ts` (factory + dispatch), `security.ts`, `http.ts`, `search.ts`, `web.ts`, `tools.ts`, `util.ts`
- **Runtime:** Node ≥ 20 (uses native `fetch`). Build with `tsc` → run `node dist/server.js`.
- **Optional:** [`ripgrep`](https://github.com/BurntSushi/ripgrep) on `PATH` (fast search; falls back to a JS scan), [`playwright`](https://playwright.dev) (browser tools).

---

## Quick start (Docker, with `just`)

The whole stack — the MCP server (with browser tools) **and** a private SearXNG
search backend — runs with one command. Needs Docker and
[`just`](https://github.com/casey/just).

```bash
just up        # build + start everything (creates .env with a random token on first run)
just url       # the endpoint to point your MCP client at
just token     # the bearer token clients must send
just logs      # follow logs   ·   just ps   ·   just health
just down      # stop & remove everything
```

`just up` writes a `.env` (random `MCP_AUTH_TOKEN`, `WORKSPACE=.`, `MCP_PORT=3000`)
the first time — both `docker compose` and `just` read it, so you never export
anything by hand. Edit `WORKSPACE` to point at the repo you want the tools to
operate on, and `MCP_PORT` if 3000 is taken. `just up-lean` skips the ~1 GB browser
image. Run `just` to list every command.

Point your client at the printed URL with `Authorization: Bearer <just token>`.

---

## Install (portable)

```bash
npm install
npm run build        # emits dist/
```

Register it for Claude Code in `~/.claude.json` under `mcpServers`, referencing the
**built** entry point (faster than `tsx`, no per-spawn compile):

```jsonc
{
  "mcpServers": {
    "dev-context": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/dev-context-mcp/dist/server.js"],
      "env": {}
    }
  }
}
```

Because `package.json` declares a `bin`, you can also `npm i -g .` (or publish it) and
reference it by name on any machine instead of a hardcoded path:

```jsonc
{ "mcpServers": { "dev-context": { "type": "stdio", "command": "dev-context-mcp" } } }
```

A stdio server is spawned once per client session with `cwd` set to the session's
directory — that cwd seeds the repo root (see below). Rebuild (`npm run build`) and
reconnect after editing `src/`.

---

## Repo root resolution

Every file/search/git/quality tool operates relative to a single **active root**,
resolved at startup in order:

1. **`REPO_ROOT`** env — explicit pin.
2. **Nearest `.git` ancestor** of the launch `cwd` — auto-detected, so launching in a
   subdirectory still roots at the repo top. This is what makes it "work for any repo".
3. **The launch `cwd`** — fallback for non-git dirs.

At runtime, **`set_repo_root`** retargets it (in hardened mode, confined under
`MCP_ROOT_BASE`). In HTTP mode each connection gets its **own** root, so concurrent
clients never interfere.

---

## Security model

The dangerous power (`run_command` is arbitrary shell; `write`/`delete`; `set_repo_root`)
is gated by **capability tiers**, enabled per transport:

| Tier | Tools | stdio | http (default) |
|------|-------|:-----:|:--------------:|
| `read` | tree, read, search, git, context, env | ✅ | ✅ |
| `web` | `fetch_url`, `web_search`, `browse_page`, `screenshot` | ✅ | ✅ (SSRF-guarded) |
| `exec` | `run_command`, `run_script`, typecheck, test | ✅ | ⛔ → `MCP_ALLOW_EXEC=1` |
| `write` | `write_file`, `edit_file`, `delete_file` | ✅ | ⛔ → `MCP_ALLOW_WRITE=1` |
| `admin` | `set_repo_root` | ✅ | ⛔ → `MCP_ALLOW_ADMIN=1` |

In HTTP mode, disabled tiers are **hidden from `tools/list`** and refused at call time
with a clear reason. Other protections:

- **Auth:** HTTP requires `MCP_AUTH_TOKEN` (the server refuses to boot without it) and
  binds `127.0.0.1` by default. Expose beyond loopback only behind a TLS reverse proxy.
- **Path sandbox:** relative paths are resolved against the active root and rejected if
  they escape it (`..`). `set_repo_root` is confined under `MCP_ROOT_BASE` when hardened.
- **SSRF guard:** `fetch_url`/`browse_page`/`screenshot` allow only `http(s)` and, in
  hardened mode, block private/loopback targets — re-checked across redirects and DNS.
- **Untrusted content:** file/web/search output is prefixed so the model treats it as
  data, not instructions.
- **`delete_file`** requires `confirm: true`.

### Environment variables

| Var | Effect |
|-----|--------|
| `REPO_ROOT` | Pin the initial active root. |
| `MCP_ROOT_BASE` | Confinement base for `set_repo_root` in hardened mode (default = `REPO_ROOT`). |
| `MCP_TRANSPORT` | `stdio` (default) or `http`. CLI flags `--http` / `--stdio` also work. |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` | HTTP bind host/port (default `127.0.0.1` / `3000`). |
| `MCP_AUTH_TOKEN` | **Required** bearer token for HTTP. |
| `MCP_DANGEROUS` | Enable `write`+`exec`+`admin` together in HTTP. |
| `MCP_ALLOW_WRITE` / `MCP_ALLOW_EXEC` / `MCP_ALLOW_ADMIN` | Enable individual tiers in HTTP. |
| `MCP_SHELL` | Shell for `run_command` (default `bash` on Windows, `/bin/sh` elsewhere). |
| `MCP_RIPGREP_PATH` | Explicit `rg` binary path (else auto-resolved from `PATH`; else JS fallback). |
| `SEARXNG_URL` | `web_search` via a self-hosted SearXNG instance (e.g. `http://searxng:8080`). |
| `TAVILY_API_KEY` | `web_search` via Tavily (free tier). Used if `SEARXNG_URL` is unset. Else keyless DuckDuckGo. |

---

## Run as a container (HTTP)

`just up` (above) is the easy path. To drive `docker compose` directly without
`just`, set the same vars (in `.env` or the shell) yourself:

```bash
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)
export WORKSPACE=/abs/path/to/your/repo     # mounted at /workspace
export MCP_PORT=3000                         # host port (override if taken)
docker compose up --build
```

Point an MCP client at `http://127.0.0.1:3000/mcp` with `Authorization: Bearer $MCP_AUTH_TOKEN`.
The compose stack also starts a private **SearXNG** instance ([`searxng/settings.yml`](searxng/settings.yml))
that backs `web_search` with no key and no rate limits — it's reachable only on the internal
network, not published to the host. The light image carries ripgrep + the read/web tiers;
enable `exec`/`write` via the commented env in [`docker-compose.yml`](docker-compose.yml). For
browser tools, build the `browser` target (`docker build --target browser .` or set
`target: browser` in compose) — it adds Playwright + Chromium (~700 MB).

---

## Web / browse tools

| Tool | Notes |
|------|-------|
| `fetch_url` | GET a URL; HTML stripped to text (or `raw`). SSRF-guarded. |
| `web_search` | SearXNG (`SEARXNG_URL`) → Tavily (`TAVILY_API_KEY`) → keyless DuckDuckGo. |
| `browse_page` | Render a JS page (Playwright) and read its text. |
| `screenshot` | Playwright PNG to a repo-relative path, or inline image. |

`browse_page`/`screenshot` need Playwright; until it's installed they return setup
instructions and everything else keeps working:

```bash
npm install playwright && npx playwright install chromium
```

---

## Tools

**Repo/shell:** `set_repo_root`, `run_command`, `list_directory`, `find_files`, `grep`
**Read/search:** `get_project_tree`, `read_file_range`, `read_multiple_files`, `read_doc`,
`search_code`, `search_docs`, `find_api_endpoint`, `find_schema`, `find_references`, `find_exports`
**Context:** `get_package_summary`, `get_project_context`, `get_audit_summaries`,
`search_audits`, `get_env_vars`, `get_git_status`, `get_recent_changes`
**Quality:** `get_typecheck_errors`, `get_test_failures`, `find_todos`, `run_script`
**Write:** `write_file`, `edit_file`, `delete_file`
**Web:** `fetch_url`, `web_search`, `browse_page`, `screenshot`

Search (`grep`, `search_code`, `find_*`, …) uses ripgrep when available — it narrows to
files that actually match before any JS read — and caches the file list briefly
(invalidated on writes), so repeated calls don't re-walk the tree.

---

## Development

```bash
npm run dev          # run under tsx (stdio)
npm run start:http   # node dist/server.js --http   (needs MCP_AUTH_TOKEN)
npm run typecheck    # tsc --noEmit  (tsx does NOT typecheck — run before shipping)
npm test             # smoke-test.mjs — exercises stdio, search, fetch_url, HTTP auth + gating
```

[`smoke-test.mjs`](smoke-test.mjs) launches the server in a git subdirectory to verify
root auto-detection, drives the core tools, fetches a local HTTP fixture, then boots the
HTTP transport to confirm auth rejection, capability filtering, and the `MCP_ALLOW_EXEC`
opt-in.

## Limits

- One process per session in stdio (no network) — HTTP lifts this with per-session isolation.
- Tool output is capped (20–50 k chars) to protect the token budget.
- `run_command`: 60 s default / 120 s max timeout, 1 MB buffer, no streaming.
- HTTP auth is a single shared bearer token (not per-user identity) — fine for a
  personal/internal stack; front with TLS + a proxy for anything public.
- Playwright is opt-in (~700 MB); the keyless DuckDuckGo search is best-effort/rate-limited.
