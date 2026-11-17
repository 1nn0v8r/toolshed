# Changelog

All notable changes to changelog-gen. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.0 - 2026-11-17

### Added

- Generate Keep a Changelog sections from git commits, from the latest tag matching `--tag-prefix` to HEAD
- `--from`, `--to` and `--path` for explicit ranges and monorepo folders
- Conventional Commits and `tool-name: Subject` classification, with a Breaking section
- `--write` to insert a section into a changelog or replace its Unreleased section, preserving CRLF
- `--json`, `--no-hash`, `--all`, `--include-merges`, `--scope`, `--version-label` and `--date`
