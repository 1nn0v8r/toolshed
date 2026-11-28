# Changelog

All notable changes to flake-check. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.0 - 2026-11-28

First release.

- Add static test flakiness scanner (`scan`) with 8 rules covering focused/skipped tests, hardcoded ports, arbitrary sleeps, unmocked wall-clock calls, unseeded randomness, live external network calls, and shared fixed temp paths, plus inline `flake-check-ignore` suppressions.
- Add stress-runner (`run`) supporting `--runs`, parallel `--jobs`, `--stop-on-flake`, `--timeout`, timing variance statistics (`min`, `median`, `p95`, `max`, `CV%`), and per-test-case failure tracking for TAP (`node --test`), Jest/Vitest, `pytest -v`, and `go test -v`.
- Support `.flake-check.json` configuration (`init`), git `--staged` / `--changed` / `--diff` scoping, and human, `--json`, `--md`, and `--sarif` (SARIF 2.1.0) outputs.
