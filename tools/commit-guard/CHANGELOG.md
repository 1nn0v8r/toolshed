# Changelog

All notable changes to commit-guard. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.0 - 2026-11-17

### Added
- `commit-guard check` with `--staged` (default, added lines only with real line numbers), `--all` and explicit files, plus `--json` output.
- `commit-guard install` and `uninstall` for a POSIX sh `pre-commit` hook, with `core.hooksPath` support, `--force` and automatic backup of foreign hooks.
- `commit-guard rules` to list rules and their state.
- Secret rules for AWS, GitHub, Slack, Stripe, Anthropic, OpenAI and Google keys, private keys, JWTs and generic assignments.
- `path.personal`, `file.env`, `file.large` and an opt-in `text.typography` rule.
- `.commit-guard.json` config with rule levels, `allow` regexes, `ignoreFiles` globs and `maxFileSizeKB`.
- Inline suppression with `commit-guard: ignore`.
- Masked output: only the first 4 characters of a match are ever printed.
