# Changelog

All notable changes to mcp-audit. Versions follow [Semantic Versioning](https://semver.org).

## Unreleased

### Changed
- Relicensed from MIT to GNU AGPL-3.0-only.

## 0.1.0 - 2026-11-23

### Added
- Live stdio MCP handshake (`initialize`, `tools/list`, `prompts/list`, `resources/list`) with `nextCursor` pagination and configurable timeouts.
- Auto-discovery and parsing for `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, and `mcp.json` configs.
- Direct command auditing via `-- <command> [args...]` and offline JSON auditing via `--from-json <file | ->`.
- Token cost estimation per server and per tool (description vs schema breakdown) with `--budget`, `--top`, and `--json`.
- Schema and config hygiene rules (`tool.bloated`, `tool.duplicate-name`, `description.missing`, `description.verbose`, `schema.deep`, `schema.wide`, `schema.unbounded-enum`, `annotations.missing`, `config.hardcoded-secret`, `config.unpinned-npx`, `config.personal-path`).
- `.mcp-audit.json` and `package.json#mcp-audit` project configuration support, `--strict`, and `--no-connect`.
