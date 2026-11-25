# Changelog

All notable changes to dev-context-mcp. Versions follow [Semantic Versioning](https://semver.org).

## Unreleased

### Added
- Consolidated `git-history`, `diagnostics`, `test-report`, and opt-in `db` (read-only PostgreSQL/MySQL) modules directly into `dev-context-mcp`.
- Toggleable module loading via `MCP_MODULES`, `MCP_DISABLED_MODULES`, `--modules=...`, and `--disable-modules=...` (with `db` auto-enabled when `DATABASE_URL` is set).
- Consolidated module test suites and smoke tests.

### Changed
- Bumped version to `4.0.0` to reflect the unified modular MCP architecture.
- Updated `Dockerfile` to copy `modules/` and include `git` for git-history tools.

## 3.1.0 - 2026-11-17

### Added
- `get_project_manifest` and `get_architecture_docs` for compact project orientation.
- Optional `repoRoot` argument on every repo-aware tool.
- Search now covers Python, Go, Rust, Java, Kotlin, C#, Ruby, PHP, Swift, Vue, Svelte and shell files.
- `npm install` builds the server automatically.

### Changed
- `run_command` picks its shell per OS: `/bin/sh` on macOS/Linux, Git Bash on Windows when installed, else `cmd.exe`.
- Long command output keeps both the start and the end.
- `read_file_range` defaults to a 150-line window from `startLine`.
- JSON output is compact, and the project tree is sorted before truncating.

### Fixed
- Failed commands no longer print stderr twice.
- `find_todos` no longer drops results containing the text "No ".
- `read_file_range` no longer returns nothing when `startLine` is past 150.

## 3.0.0 - 2026-06-25

First public version: stdio and hardened HTTP transports, capability tiers, ripgrep search, web and browser tools, Docker stack with SearXNG.
