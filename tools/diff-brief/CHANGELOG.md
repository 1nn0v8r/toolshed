# Changelog

All notable changes to diff-brief. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.0 - 2026-11-25

First release.

- Parse unified diffs from git ranges, working tree, staged changes, single commits, files, or stdin.
- Separate noise (lockfiles, snapshots, minified/build artifacts) and summarize `package.json` dependency deltas.
- Detect review risk flags (`test-skip`, `assertion-removed`, `type-suppression`, `debug-leftover`, `sensitive-surface`, `unpaired-source`, `todo-added`, `large-deletion`, `binary-added`).
- Extract changed symbols and hunk line ranges, and format compact `text`, `md`, or `json` briefs within a `--max-tokens` budget.
- Support `.diffbriefrc.json` / `package.json` configuration and CI exit-code gates (`--fail-on`, `--fail-on-flag`).
