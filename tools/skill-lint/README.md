# skill-lint

A zero-dependency CLI that validates Agent Skills (`SKILL.md`) against the open specification, audits startup index token budgets, verifies bundled `scripts/` and `references/` links, and flags risky tool permissions or secret leaks.

- **Runs on:** Windows, macOS and Linux
- **Requires:** Node.js 20 or newer
- **License:** AGPL-3.0-only

---

## Contents

- [Why](#why)
- [Install](#install)
- [Usage](#usage)
- [Options](#options)
- [Configuration](#configuration)
- [What it checks](#what-it-checks)
- [Exit codes](#exit-codes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Why

AI coding assistants (Claude Code, Codex CLI, Cursor, Gemini CLI, Copilot) load the `name` and `description` of every installed `SKILL.md` into the startup context on every turn. As teams accumulate skills, silent issues creep in:

- **Invalid frontmatter** or `name` mismatches cause skills to silently fail to load.
- **Over-long descriptions and 800-line `SKILL.md` bodies** bloat startup tokens and break progressive disclosure.
- **Broken `scripts/` or `references/` links** waste agent turns mid-task.
- **Unscoped `allowed-tools: Bash` or `curl | bash` commands** expose teams to unsafe execution when sharing skills.

`skill-lint` catches all of these locally and in CI before a skill is merged.

---

## Install

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/skill-lint
npm install
```

Run directly with Node.js:

```bash
node /abs/path/to/toolshed/tools/skill-lint/src/cli.js --help
```

Or install globally:

```bash
npm install -g .
skill-lint --help
```

---

## Usage

```bash
# Auto-discover skills under .agents/skills, .claude/skills, .cursor/skills, .codex/skills, .gemini/skills, .github/skills, skills/
skill-lint

# Lint specific skill directories or SKILL.md files
skill-lint .claude/skills/deploy-check

# Enforce a startup catalog token budget and treat warnings as errors in CI
skill-lint --budget 2000 --strict

# Scaffold a new spec-compliant SKILL.md
skill-lint init .agents/skills/my-new-skill

# Machine-readable JSON output
skill-lint --json
```

Sample output:

```
skill-lint: scanned 2 skill(s) (offline estimate: chars / 4)

Skills:
  startup  body_tok  lines  refs  scripts  skill
       24       180     28     1        1  deploy-check (.claude/skills/deploy-check/SKILL.md)
       31       410     62     0        0  pr-review (.agents/skills/pr-review/SKILL.md)

Totals: 55 startup index tokens, 590 body tokens (645 total)
Startup budget: OK (55 / 2,000 tokens)
Summary: 0 errors, 0 warnings, 0 info
Status: OK
```

---

## Options

| Option | Description | Default |
|---|---|---|
| `[paths...]` | Skill directories or `SKILL.md` files to lint | Auto-discover standard skill dirs |
| `init <dir>` | Create a spec-compliant starter `SKILL.md` inside `<dir>` | |
| `--budget <tokens>` | Exit 1 if total startup index tokens (`name` + `description`) exceed `<tokens>` | None |
| `--max-body-lines <n>` | Warn when `SKILL.md` body exceeds `<n>` lines | `500` |
| `--max-body-tokens <n>` | Warn when `SKILL.md` body exceeds `<n>` tokens | `4000` |
| `--max-desc-chars <n>` | Warn when `description` exceeds `<n>` characters | `300` |
| `--ignore-rule <rule>` | Suppress a lint rule ID (repeatable) | `[]` |
| `--allow-field <key>` | Allow an extra top-level frontmatter key (repeatable) | `[]` |
| `--strict` | Treat warnings as errors (exit 1) | `false` |
| `--verbose` | Show `[INFO]` findings in text output | `false` |
| `--json` | Print the full report as JSON | `false` |
| `--force` | Overwrite an existing `SKILL.md` during `init` | `false` |
| `-h`, `--help` | Show help | |
| `-v`, `--version` | Show version | |

---

## Configuration

Add `.skill-lint.json` in your project root (or a `"skill-lint"` section in `package.json`):

```json
{
  "budget": 2000,
  "maxBodyLines": 500,
  "maxBodyTokens": 4000,
  "maxDescriptionChars": 300,
  "ignoreRules": ["frontmatter.description-no-trigger"],
  "allowedFrontmatterKeys": ["owner"],
  "strict": false
}
```

CLI flags override settings in `.skill-lint.json`.

---

## What it checks

| Rule ID | Severity | What it catches |
|---|---|---|
| `frontmatter.missing` | `error` | Missing `---` YAML frontmatter delimiters. |
| `frontmatter.invalid-yaml` | `error` | Malformed YAML syntax in frontmatter. |
| `frontmatter.name-missing` | `error` | Missing required `name` field. |
| `frontmatter.name-invalid` | `error` | `name` is over 64 chars or not lowercase alphanumeric + single hyphens. |
| `frontmatter.name-mismatch` | `error` | `name` does not match the parent directory name. |
| `frontmatter.description-missing` | `error` | Missing required `description` field. |
| `frontmatter.description-too-long` | `error` | `description` exceeds the 1024-character spec limit. |
| `frontmatter.description-verbose` | `warn` | `description` exceeds `maxDescriptionChars` (default 300). |
| `frontmatter.description-xml` | `warn` | `description` contains XML/HTML angle-bracket tags. |
| `frontmatter.description-no-trigger` | `info` | `description` lacks explicit "when to use" guidance. |
| `frontmatter.compatibility-too-long` | `error` | `compatibility` exceeds the 500-character spec limit. |
| `frontmatter.unknown-field` | `warn` | Frontmatter key outside the open spec (unless allowed via `--allow-field`). |
| `body.empty` | `warn` | `SKILL.md` has no instructions after frontmatter. |
| `body.too-long` | `warn` | Body exceeds `maxBodyLines` (500) or `maxBodyTokens` (4000). |
| `ref.broken` | `error` | Relative markdown link or `scripts/`/`references/`/`assets/` path does not exist. |
| `ref.path-escape` | `error` | Relative link traverses outside the skill directory (`..`). |
| `security.broad-allowed-tools` | `warn` | Unscoped `Bash`, `Shell`, or `*` in `allowed-tools`. |
| `security.suspicious-command` | `error` | `curl`/`wget | sh` pipes or prompt-override directives in HTML comments. |
| `security.personal-path` | `warn` | Machine-specific home directory path in `SKILL.md` or `scripts/`. |
| `security.hardcoded-secret` | `error` | Literal API key or token prefix in `SKILL.md` or `scripts/`. |
| `skill.duplicate-name` | `error` | Multiple discovered skills declare the same `name`. |

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Passed within budget and without errors (or warnings under `--strict`). |
| `1` | Startup token budget exceeded, errors found, or warnings found with `--strict`. |
| `2` | Usage error: invalid flag, missing path, or invalid `.skill-lint.json`. |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `No SKILL.md files found` | Pass the directory containing your skills (e.g. `skill-lint path/to/skills`) or create one with `skill-lint init .agents/skills/my-skill`. |
| Custom frontmatter key flagged | Pass `--allow-field <key>` or add it to `allowedFrontmatterKeys` in `.skill-lint.json`. |
| Code example link flagged as `ref.broken` | Wrap example links inside fenced code blocks (` ``` `) so the linter skips illustrative snippets. |

---

## Development

```bash
npm install
npm test
npm run typecheck
npm run coverage
```
