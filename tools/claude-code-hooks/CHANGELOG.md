# Changelog

All notable changes to this tool are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Changed
- Relicensed from MIT to GNU AGPL-3.0-only.

## 0.1.0 - 2026-11-17

### Added

- `protect-files` PreToolUse hook: blocks reading or writing `.env` files, keys, certificates, credential files and `.ssh/`, including common shell access patterns.
- `block-secrets` PreToolUse hook: blocks edits that add API keys, tokens, private keys and secret-looking assignments, with masked reasons.
- `guard-bash` PreToolUse hook: denies destructive shell commands and asks before risky ones, parsing chained commands, quotes and substitutions.
- `auto-format` PostToolUse hook: runs the project's own prettier, ruff, black, gofmt or rustfmt on edited files; never installs anything and never blocks.
- `claude-code-hooks` CLI with `install`, `uninstall`, `status` and `test` commands for user, project and local scopes, with backups and idempotent merges.
- `hooks.config.json` support for extra and allow globs and command allow rules.
