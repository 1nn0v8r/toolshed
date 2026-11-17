# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.0 - 2026-11-17

### Added

- MCP stdio server `db-schema-mcp` for PostgreSQL (12+) and MySQL (8+).
- Tools: `list_tables`, `describe_table`, `list_relationships`, `sample_rows`, `run_select`, `connection_info`.
- Three-layer read-only protection for `run_select`: a tokenizing SQL guard, execution inside a READ ONLY transaction that is always rolled back, and a row cap with truncation reporting.
- Statement timeout, `DB_MAX_ROWS` (hard max 500) and `DB_SCHEMA` configuration.
- Masking of secret-looking columns in `sample_rows`, truncation of long values, and redaction of credentials in every error message.
- Unit tests for the guard, formatting and redaction, plus Docker-based integration tests for both databases.
