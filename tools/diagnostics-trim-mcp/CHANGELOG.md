# Changelog

All notable changes to diagnostics-trim-mcp. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.0 - 2026-11-18

### Added
- First release.
- MCP tools `check_diagnostics` and `trim_diagnostics`.
- Diagnostic parsers for TypeScript (tsc), ESLint (compact and JSON), Python (Pyright, Mypy, Ruff) and Rust (cargo check).
- Deduplication and cascading error suppression filters to protect LLM context windows.
- Code snippet generation with error pointers.
- CLI executable for running commands or piping compiler stdout directly.
