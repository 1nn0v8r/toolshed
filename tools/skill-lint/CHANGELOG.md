# Changelog

All notable changes to skill-lint. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.0 - 2026-11-25

### Added
- Auto-discovery of `SKILL.md` files across standard agent skill directories (`.agents/skills`, `.claude/skills`, `.cursor/skills`, `.codex/skills`, `.gemini/skills`, `.github/skills`, `skills`).
- Zero-dependency YAML frontmatter parser and validation against the Agent Skills open specification (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`).
- Startup index token estimation and `--budget` enforcement, plus progressive-disclosure limits (`--max-body-lines`, `--max-body-tokens`, `--max-desc-chars`).
- Relative link and bundled asset verification (`scripts/`, `references/`, `assets/`), path-escape checks, and duplicate skill name detection.
- Security hygiene checks for unscoped `allowed-tools`, `curl/wget | sh` pipes, prompt-override HTML comments, hardcoded secrets, and personal home paths.
- `skill-lint init <dir>` starter template generator, `.skill-lint.json` configuration, `--strict`, and `--json`.
