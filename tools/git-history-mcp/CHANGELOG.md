# Changelog

## 0.1.0 - 2026-11-17

### Added

- MCP stdio server `git-history-mcp` with seven tools: `file_history`, `blame_range`, `line_origin`,
  `commit_details`, `search_commits`, `churn` and `contributors`.
- Compact, capped plain-text output with the cap stated whenever it is hit.
- Repo root from `REPO_ROOT`, else the nearest git root above the working directory, with a per-call
  `repoRoot` override.
- Path escape rejection, including symlinks that point outside the repo.
- Email addresses are never printed (author names only; address-like text is redacted).
- Unit tests for the parsers and end-to-end tests through a real MCP client over stdio.
