# Changelog

All notable changes to env-check. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.0 - 2026-11-17

### Added
- Scan JS/TS, Python, Go, Ruby, PHP, Rust and docker-compose files for environment variable reads.
- Report variables used in code but missing from `.env.example`, example keys that are never used, and example keys missing from a real `.env`.
- Dynamic reads (for example `process.env[key]`) are counted and listed as unchecked.
- `--ignore` (names or globs), built-in ignores for well-known runtime variables, and a `.env-check.json` config file.
- `--fix` appends missing keys to the example file, preserving content and line endings.
- `--json` output and `--strict` mode.
- Values from `.env` files are never read into the report or printed.
