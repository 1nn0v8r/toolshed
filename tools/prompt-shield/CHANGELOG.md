# Changelog

All notable changes to prompt-shield. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.0 - 2026-11-26

First release.

- Detect and decode Unicode Tag ASCII smuggling (`U+E0000..U+E007F`), Trojan Source bidirectional controls, and stealth zero-width characters (while preserving leading UTF-8 BOMs and emoji ZWJ sequences).
- Scan AI instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `SKILL.md`, `.cursor/rules/**`, `.github/copilot-instructions.md`), Markdown HTML comments, staged git diffs (`--staged`), and `--stdin` streams for prompt injection and credential exfiltration.
- Audit `.mcp.json` / `.cursor/mcp.json` / `.vscode/mcp.json` configs statically (`--mcp`), scan saved `tools/list` JSON payloads (`--from-json`), and inspect live stdio MCP servers (`--inspect-mcp` or `-- <command>`).
- Safely strip invisible Unicode characters (`strip`) with `--dry-run` and `--backup` options.
- Output human-readable reports, `--json`, and `--sarif` (SARIF 2.1.0) for CI and GitHub Code Scanning.
