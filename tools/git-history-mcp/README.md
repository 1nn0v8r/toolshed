# git-history-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that answers "why is this code like this?" from git history, in compact, capped output.

- **Runs on:** Windows, macOS and Linux (Node.js 20 or newer)
- **Requires:** `git` on your `PATH`
- **License:** MIT

---

## Contents

- [Why](#why)
- [Install](#install)
- [Usage](#usage)
- [Tools](#tools)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Why

Raw `git log -p` and `git blame` can print thousands of lines. These tools return one line per commit or per blame group, clip patches, and say so when a cap is hit, so your assistant spends fewer tokens finding the commit that explains a line.

- Output is plain text and never contains email addresses (names only; anything address-like is replaced with `[email hidden]`).
- Every tool takes an optional `repoRoot` (absolute path). File paths are relative to the repo root and anything escaping it is rejected.
- Git runs with an argument array (no shell), `core.quotepath=false`, and NUL-separated formats, so unicode and spaced paths work on every OS.

---

## Install

You need **Node.js 20+** and **git**.

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/git-history-mcp
npm install
```

Optional global command:

```bash
npm install -g .
```

Or run it directly with `node /abs/path/to/src/server.js`. There is no build step.

### Connect your assistant

Replace `/abs/path/to/src/server.js` with the real path. On Windows, forward slashes work inside JSON.

> By default the server walks up from the directory it was launched in to the nearest git root. Desktop apps often launch it elsewhere, so set `REPO_ROOT` or pass `repoRoot` in a call.

**Claude Code**

```bash
claude mcp add git-history --scope user -- node /abs/path/to/src/server.js
```

**Claude Desktop** (`claude_desktop_config.json`; macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`)

```json
{
  "mcpServers": {
    "git-history": {
      "command": "node",
      "args": ["/abs/path/to/src/server.js"],
      "env": { "REPO_ROOT": "/abs/path/to/your/project" }
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "git-history": {
      "command": "node",
      "args": ["/abs/path/to/src/server.js"]
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`)

```json
{
  "servers": {
    "git-history": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/src/server.js"],
      "env": { "REPO_ROOT": "${workspaceFolder}" }
    }
  }
}
```

---

## Usage

Ask your assistant things like:

- "Why does line 42 of `src/app.js` look like that?" (`line_origin`, then `commit_details`)
- "Who wrote lines 10 to 40 of `src/app.js`?" (`blame_range`)
- "When was `parseToken` introduced?" (`search_commits` with `pickaxe=true`)
- "Which files change most?" (`churn`)

Example `blame_range` output:

```
L1  a1b2c3d  2026-01-10  Alice Anders  init project
L2  b2c3d4e  2026-03-10  Alice Anders  Change line two
L3-L5  a1b2c3d  2026-01-10  Alice Anders  init project
```

---

## Tools

| Tool | Arguments | Output |
|---|---|---|
| `file_history` | `path`, `limit` (15, max 100), `follow` (true) | Commits touching the file: short sha, date, author, subject, `+added/-deleted` for that file. |
| `blame_range` | `path`, `startLine`, `endLine`, `includeCode` (false) | Lines grouped by commit. Max 400 lines per call. |
| `line_origin` | `path`, `line` | The commit that last changed the line and the one before it, each with a patch clipped to 40 lines. |
| `commit_details` | `sha`, `includePatch` (false), `maxPatchLines` (200, max 2000) | Message, author, date, parents, changed files with stats, optional clipped patch. Merges are shown against the first parent. |
| `search_commits` | `query`, `author`, `since`, `until`, `path`, `pickaxe` (false), `limit` (20, max 100) | Matching commits. `query` is a literal, case-insensitive match on subject and body; with `pickaxe` it is matched against added or removed code (`git -S`). |
| `churn` | `since` ("90 days ago"), `limit` (15, max 100), `path` | Files changed most often with commit counts and lines changed. |
| `contributors` | `path`, `since`, `limit` (30, max 100) | Authors with commit counts, merges excluded. |

All tools also accept `repoRoot`. Total output is capped at 24000 characters.

---

## Configuration

| Variable | Meaning |
|---|---|
| `REPO_ROOT` | Repo to use. Default: nearest git root above the launch directory. |

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Not a git repository` | The root is not inside a git work tree. Set `REPO_ROOT` or pass `repoRoot`. |
| `git was not found on PATH` | Install git or add it to the `PATH` the client launches with. |
| `Path escapes the repo root` | Use a path inside the repo, relative to its root. |
| `file ... has only N lines` | The start line is past the end of the file at `HEAD`. |
| `Unknown commit` | The sha, branch or tag does not exist in this repo. |
| `since` seems ignored | Git ignores values it cannot parse as a date. Use `YYYY-MM-DD` or `2 weeks ago`. |
| Blame shows `uncommitted` | The lines have working tree changes not yet committed. |

---

## Development

```bash
npm install
npm test
npm run typecheck
npm run coverage
```

Tests build temporary git repos (renames, merges, unicode and spaced paths, CRLF files, several authors) and call every tool through a real MCP client over stdio. No network access is used.
