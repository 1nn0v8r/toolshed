# Changelog

All notable changes to the unified `toolshed` package (CLI, Web UI installer, Docker stack, and consolidated MCP server).

## 1.1.0 - 2026-11-28

### Added
- `flake-check` CLI (`toolshed flake-check`): static test flakiness scanner (8 rules, inline suppressions, SARIF/JSON/Markdown) and parallel stress-runner with timing stats and per-test failure tracking (#60).
- `prompt-shield` CLI (`toolshed prompt-shield`): invisible Unicode, ASCII smuggling, Trojan Source bidi, and prompt-injection scanner across AI rules, diffs, stdin, and MCP servers (#56).
- `skill-lint` CLI (`toolshed skill-lint`): Agent Skills (`SKILL.md`) spec validator, startup token budget auditor, and link/permission checker (#55).
- One-command tarball and Docker install instructions in `README.md` (#47).

### Changed
- Updated `dev-context-mcp` dependencies to resolve security advisories and grouped Dependabot updates (#49, #50).
- Synced README and guides with unified CLI, AGPL-3.0 licensing, and release workflow (#54).
- Exempted Dependabot PRs from the `changelog` PR check (#52).

## 1.0.0 - 2026-11-25

### Added
- Unified zero-dependency `toolshed` CLI (`toolshed ui`, `toolshed setup`, `toolshed status`, `toolshed mcp`, and `toolshed <tool>`).
- Geist-styled local Web UI dashboard (`toolshed ui`) with live MCP module toggles, schema token estimator, light/dark theme, inline SVG logo, and one-click AI client installer.
- Auto-configuration for 12 AI clients: Antigravity, Claude Code, Claude Desktop, OpenAI Codex CLI (TOML), Cursor, Gemini CLI, Windsurf, VS Code, Project `.mcp.json`, Cline, Roo Code, and Zed.
- Consolidated `dev-context-mcp` v4.0.0 with 6 toggleable modules (`core`, `git-history`, `diagnostics`, `test-report`, `web`, `db`).
- Root `Dockerfile` and `docker-compose.yml` running `toolshed-ui` (`4317`) and `dev-context-mcp` HTTP (`4318`).
- Automated GitHub Releases with `.tgz` tarballs and `ghcr.io` container images.

### Changed
- Licensed under GNU AGPL-3.0-only.
