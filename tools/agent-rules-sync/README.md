# agent-rules-sync

A zero-dependency CLI that keeps AI coding assistant instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Cursor `.mdc`, GitHub Copilot, Windsurf) in sync and catches drift, broken references, and token bloat in CI.

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
- [How syncing works](#how-syncing-works)
- [Exit codes](#exit-codes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Why

Teams using multiple AI coding assistants in the same repository end up maintaining `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursor/rules/project.mdc`, and `.windsurfrules` separately. When someone updates a build command or coding convention in one file, the others silently drift, causing different assistants to follow contradictory rules. At the same time, stale `@path` imports break quietly and oversized rule files waste thousands of context tokens on every turn.

`agent-rules-sync` treats one file (default `AGENTS.md`) as the single source of truth, syncs managed blocks or thin pointers to the other tools while preserving tool-specific notes, and checks for drift, broken file references, package-manager contradictions, and token budget overruns in CI.

---

## Install

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/agent-rules-sync
npm install
```

Run directly with Node.js on any OS:

```bash
node /abs/path/to/toolshed/tools/agent-rules-sync/src/cli.js check /abs/path/to/your/project
```

Or install globally to put `agent-rules-sync` on your `PATH`:

```bash
npm install -g .
agent-rules-sync --help
```

---

## Usage

```bash
# 1. Discover existing rule files and create .agent-rules.json (and AGENTS.md if missing)
agent-rules-sync init

# 2. Sync AGENTS.md into configured targets (copy mode by default)
agent-rules-sync sync

# Preview changes without writing
agent-rules-sync sync --dry-run

# Sync using thin pointer/import wrappers instead of full copies
agent-rules-sync sync --mode pointer --targets claude,copilot,cursor

# 3. Show line-by-line drift (exits 1 if any target differs)
agent-rules-sync diff

# 4. Run full CI check (drift, broken @imports/links, contradictions, token budget)
agent-rules-sync check --max-tokens 1500 --strict

# Inventory of all detected rule files and estimated token counts
agent-rules-sync status --json
```

Sample output:

```text
agent-rules-sync (check): 4 instruction file(s) found

Sync status (source: AGENTS.md):
  [in-sync] CLAUDE.md (copy)
  [in-sync] .github/copilot-instructions.md (copy)
  [drifted] .cursor/rules/project.mdc (copy)

Instruction files & token estimates:
  .cursor/rules/project.mdc: ~412 tokens (38 lines, 1648 bytes)
  .github/copilot-instructions.md: ~380 tokens (31 lines, 1520 bytes)
  AGENTS.md: ~380 tokens (31 lines, 1520 bytes)
  CLAUDE.md: ~395 tokens (33 lines, 1580 bytes)

Problems found.
```

---

## Options

| Option | Description | Default |
|---|---|---|
| `[command]` | `check`, `sync`, `diff`, `init`, or `status` | `check` |
| `[dir]`, `--path <dir>` | Project directory to inspect or sync | `.` |
| `--source <file>` | Canonical instruction file relative to project root | `AGENTS.md` |
| `--targets <list>` | Comma-separated or repeatable target aliases or paths | Configured targets |
| `--mode <copy\|pointer>` | Embed canonical rules (`copy`) or write `@import`/link wrappers (`pointer`) | `copy` |
| `--max-tokens <n>` | Fail `check` if any rule file exceeds this estimated token count | Unset |
| `--from <file>` | With `init`: seed `AGENTS.md` from an existing rule file | Auto-detected |
| `--force` | With `init`: overwrite existing `.agent-rules.json` | `false` |
| `--dry-run` | Preview `init` or `sync` without writing files | `false` |
| `--strict` | Fail `check` on contradictions and unmanaged rule files | `false` |
| `--no-links` | Skip broken `@path` import and Markdown link checks | `false` |
| `--no-contradictions` | Skip cross-file package-manager contradiction warnings | `false` |
| `--json` | Emit machine-readable JSON output | `false` |
| `-h`, `--help` | Show help | |
| `-v`, `--version` | Show version | |

### Target Aliases

| Alias | Path |
|---|---|
| `agents` | `AGENTS.md` |
| `claude` | `CLAUDE.md` |
| `gemini` | `GEMINI.md` |
| `copilot` | `.github/copilot-instructions.md` |
| `cursor` | `.cursor/rules/project.mdc` |
| `cursorrules` | `.cursorrules` |
| `windsurf` | `.windsurfrules` |
| `cline` | `.clinerules` |
| `roo` | `.roo/rules/project.md` |

Custom relative paths (for example `--targets .cursor/rules/backend.mdc`) are also supported.

---

## Configuration

Create `.agent-rules.json` in your project root (or generate one with `agent-rules-sync init`):

```json
{
  "source": "AGENTS.md",
  "mode": "copy",
  "maxTokens": 2000,
  "checkLinks": true,
  "checkContradictions": true,
  "strict": false,
  "targets": [
    { "path": "CLAUDE.md", "mode": "pointer" },
    ".github/copilot-instructions.md",
    {
      "path": ".cursor/rules/project.mdc",
      "description": "Repository coding guidelines",
      "alwaysApply": true
    }
  ]
}
```

CLI flags override values in `.agent-rules.json`.

---

## How syncing works

1. **Managed blocks preserve custom rules:** Synced content is wrapped between `<!-- agent-rules-sync:start source="AGENTS.md" -->` and `<!-- agent-rules-sync:end -->`. Anything you write above or below those markers (for example tool-specific sections) is kept intact on every sync.
2. **Cursor `.mdc` frontmatter:** Existing YAML frontmatter (`--- ... ---`) in `.mdc` files is preserved. New `.mdc` files receive default frontmatter (`description`, `globs`, `alwaysApply: true`).
3. **Line endings:** Existing CRLF (`\r\n`) or LF (`\n`) line endings in target files are preserved.
4. **Pointer mode:** Targets that support `@path` imports (`CLAUDE.md`, `GEMINI.md`) receive `@AGENTS.md`; nested files like `.github/copilot-instructions.md` or `.cursor/rules/project.mdc` receive relative Markdown links (`../AGENTS.md`, `../../AGENTS.md`).

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean, or sync/init/status completed successfully. |
| `1` | Problems found: drifted/missing targets, broken references, token budget exceeded, or (with `--strict`) contradictions or unmanaged files. |
| `2` | Usage error, missing directory/source file, path traversal, or invalid `.agent-rules.json`. |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `No targets configured or detected` during `sync` | Run `agent-rules-sync init` or pass `--targets claude,copilot,cursor`. |
| `.agent-rules.json already exists` during `init` | Pass `--force` to regenerate it, or edit `.agent-rules.json` directly. |
| Valid npm package name flagged as broken `@import` | Only line-start `@path` references with a file extension or `./` / `../` prefix are checked; wrap examples inside fenced code blocks or backticks. |
| False positive package-manager contradiction | Negative phrasing (`never use npm`) is ignored automatically, or pass `--no-contradictions`. |

---

## Development

```bash
npm install
npm test
npm run typecheck
npm run coverage
```

Tests create isolated temporary directories under the OS temp folder and exercise both the module API and the `src/cli.js` child process. No network access is needed.
