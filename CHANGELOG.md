# Changelog

All notable changes to the unified `toolshed` package (CLI, Web UI installer, Docker stack, and consolidated MCP server).

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
