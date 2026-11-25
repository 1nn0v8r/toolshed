# Changelog

All notable changes to agent-rules-sync. Versions follow [Semantic Versioning](https://semver.org).

## Unreleased

### Changed
- Relicensed from MIT to GNU AGPL-3.0-only.

## 0.1.0 - 2026-11-24

First release.

- Discover AI coding instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursor/rules/*.mdc`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.roo/rules/project.md`).
- `init`, `sync`, `diff`, and `check` subcommands with `copy` and `pointer` sync modes.
- Marker-based managed blocks that preserve tool-specific instructions outside the synced region, plus YAML frontmatter support for Cursor `.mdc` files.
- CI checks for drifted targets, broken `@path` imports and local Markdown links, package-manager contradictions across files, and token budget limits (`--max-tokens`).
- Machine-readable `--json` output and `--dry-run` support.
