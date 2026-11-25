# Changelog

All notable changes to this tool are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Changed
- Relicensed from MIT to GNU AGPL-3.0-only.

## 0.1.0 - 2026-11-17

### Added

- `token-count [paths...]` CLI that reports estimated token cost per file, with share of total.
- File discovery through `git ls-files` inside git repos, and a directory walk with default excludes elsewhere.
- Binary file detection (NUL byte in the first 8 KB).
- Offline estimate (`ceil(chars / 4)`) and `--exact` mode using the Anthropic token counting API with retries.
- `--top`, `--by-dir`, `--json`, `--budget`, `--model`, `--help` and `--version` options.
- Stdin input with `-`.
