# Changelog

All notable changes to this tool are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.0 - 2026-11-17

### Added

- MCP stdio server `test-report-mcp` with four tools: `detect_test_runner`, `run_tests`, `parse_report` and `list_failures_from_last_run`.
- Runner support for vitest, jest, node:test, mocha, pytest and go test, using machine-readable reports (JUnit XML, JSON, TAP, `go test -json`).
- Parsers for JUnit, Jest JSON, Mocha JSON, TAP and Go JSON with nested suites, skipped tests, errors versus failures, CRLF input and unicode names.
- Compact output: summary, per-failure name, `file:line`, message capped at 20 lines, stack trimmed to 8 project frames, total cap of about 12000 characters.
- Runner crash fallback that returns the last 60 lines of output, and a timeout that kills the whole process tree.
- Repo-root confinement for `cwd`, `files` and report paths, including symlink checks.
- Unit and end-to-end tests, including a real `node --test` run through an MCP client.
