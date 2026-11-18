# Changelog

All notable changes to repo-pack. Versions follow [Semantic Versioning](https://semver.org).

## Unreleased

### Added
- `--priority <glob>` option (repeatable) to boost matching files to the front of the pack order within token budgets.

## 0.1.0 - 2026-11-17

### Added
- `repo-pack [paths or globs...]` bundles files into one Markdown or XML document.
- File discovery through `git ls-files` (respects `.gitignore`), with a folder walk and default excludes outside git.
- `.env*` files are always skipped with a warning unless `--allow-env` is passed.
- Binary files, oversize files (`--max-file-size`) and invalid UTF-8 files are skipped and reported with a reason.
- `--include` and `--exclude` globs (repeatable, picomatch).
- `--max-tokens` budget with a deterministic priority order (docs, config, source by depth, tests) and `--order path`.
- `--format md` (collision-proof fences) and `--format xml` (CDATA with `]]>` escaping).
- `--out`, `--line-numbers`, CRLF to LF normalization, forward-slash paths on every OS.
- Summary on stderr so stdout stays clean for piping.
- Exit codes: 0 ok, 1 nothing matched or budget too small, 2 usage error.
