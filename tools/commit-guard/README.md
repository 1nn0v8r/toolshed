# commit-guard

A zero-dependency CLI and git pre-commit hook that blocks commits containing secrets, machine-specific personal paths, `.env` files, oversized files and (optionally) typographic characters. It is the local first line of defense before CI secret scanning.

- **Runs on:** Windows (Git Bash), macOS and Linux
- **Requires:** Node.js 20 or newer, and git on `PATH`
- **License:** MIT

---

## Contents

- [Why](#why)
- [Install](#install)
- [Usage](#usage)
- [Options](#options)
- [Rules](#rules)
- [Configuration](#configuration)
- [Exit codes](#exit-codes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Why

CI secret scanners run after you push, when the secret is already in your branch history. commit-guard runs before the commit exists, so a leaked key or a path that exposes your username never leaves your machine.

- Scans only the **added lines** of the staged diff, with real line numbers, so old content never blocks new work.
- Never prints a full secret: matches are masked to the first 4 characters followed by `***`.
- No runtime dependencies: only Node.js and git.

---

## Install

You need **Node.js 20+** and **git**.

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/commit-guard
npm install
```

`npm install` only pulls development tools (TypeScript and Node typings) used for tests. The CLI itself has no dependencies.

Optional: install it as a global command.

```bash
npm install -g .
commit-guard --help
```

Or run it by path without installing anything globally:

```bash
node /abs/path/to/toolshed/tools/commit-guard/src/cli.js --help
```

### Enable the hook in a repository

From inside the repository you want to protect:

```bash
node /abs/path/to/toolshed/tools/commit-guard/src/cli.js install
```

This writes `.git/hooks/pre-commit` (or the folder named by `core.hooksPath`, if set). The hook is a POSIX `sh` script that runs `node "<absolute path to src/cli.js>" check --staged`, so it works under Git Bash on Windows and `sh` on macOS and Linux. If you move the clone, run `install` again.

---

## Usage

```bash
# Scan what is staged (the default)
commit-guard check
commit-guard check --staged

# Scan every tracked file
commit-guard check --all

# Scan specific files, whole (works outside a git repo too)
commit-guard check src/config.js notes.md

# Machine-readable output
commit-guard check --json

# Hook management
commit-guard install
commit-guard install --force     # replace a foreign hook, keeping a backup
commit-guard uninstall           # removes only a hook commit-guard installed

# List rules and whether they are enabled
commit-guard rules
```

Example output, one finding per line as `path:line  severity  rule-id  message`:

```
src/aws.js:12  error  secret.aws-access-key  AWS access key (AKIA***)
docs/setup.md:4  warn  path.personal  Machine-specific home path (user jdoe***)
.env:0  error  file.env  Environment file must not be committed (use .env.example)
commit-guard: 2 errors, 1 warning (3 files scanned)
```

File-level findings (`file.env`, `file.large`) use line `0`.

### Suppressing a finding

- Put `commit-guard: ignore` in a comment on the same line.
- Add a regex to `allow` in the config. It is tested against the whole line and against the matched text.
- Add a glob to `ignoreFiles` in the config to skip whole files.
- As a last resort for a single commit: `git commit --no-verify`.

---

## Options

| Command | Option | Meaning |
|---|---|---|
| `check` | `--staged` | Scan added lines of the staged diff plus the staged file list (default) |
| `check` | `--all` | Scan all tracked files |
| `check` | `<files...>` | Scan the given files in full |
| `check` | `--json` | Print `{ ok, summary, findings }` as JSON |
| `install` | `--force` | Replace an existing pre-commit hook that is not ours; the old one is saved as `pre-commit.commit-guard-backup` |
| `uninstall` | | Remove the hook, only if it carries commit-guard's marker comment |
| `rules` | `--json` | List rules as JSON |
| any | `-h`, `--help` | Show help |
| any | `-v`, `--version` | Show the version |

`--staged`, `--all` and explicit files are mutually exclusive.

---

## Rules

| Id | Default | What it catches |
|---|---|---|
| `secret.aws-access-key` | error | `AKIA` or `ASIA` followed by 16 uppercase alphanumerics (the documented `...EXAMPLE` key is allowed) |
| `secret.github-token` | error | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` and `github_pat_` tokens |
| `secret.private-key` | error | `BEGIN ... PRIVATE KEY` PEM headers |
| `secret.slack-token` | error | `xoxb-`, `xoxa-`, `xoxp-`, `xoxr-`, `xoxs-` tokens |
| `secret.stripe-live` | error | `sk_live_` and `rk_live_` keys |
| `secret.anthropic-key` | error | `sk-ant-` keys |
| `secret.openai-key` | error | `sk-` followed by 20 or more characters, and `sk-proj-` keys |
| `secret.google-api-key` | error | `AIza` followed by 35 characters |
| `secret.jwt` | error | Three base64url segments starting with `eyJ` |
| `secret.generic-assignment` | error | Names like `api_key`, `secret`, `token` or `password` assigned a quoted value of 12 or more characters that contains a digit and mixed character classes. Placeholders such as `changeme`, `replace-with-...`, `<...>`, `${...}`, `xxx`, `example` and `your-...` are ignored |
| `path.personal` | warn | Absolute home paths with a username: `C:\Users\<name>\`, `C:/Users/<name>/`, `/Users/<name>/`, `/home/<name>/`. Placeholders such as `<name>`, `you`, `user`, `username`, `example` and `...` are ignored |
| `file.env` | error | Files named `.env` or `.env.*`, except `.env.example`, `.env.sample` and `.env.template` |
| `file.large` | warn | Files over `maxFileSizeKB` (default 1024) |
| `text.typography` | off | Em dash, en dash and ellipsis characters, detected by code point |

Binary files (a NUL byte in the first 8000 bytes) are not scanned for content. Files over 16 MB are not read for content, but `file.large` still reports them.

---

## Configuration

Create `.commit-guard.json` at the repository root. Every key is optional.

```json
{
  "rules": {
    "path.personal": "error",
    "text.typography": "warn",
    "secret.jwt": "off"
  },
  "allow": ["^FIXTURE_", "test-only-token"],
  "ignoreFiles": ["fixtures/**", "*.snap", "docs/legacy/"],
  "maxFileSizeKB": 512
}
```

| Key | Type | Meaning |
|---|---|---|
| `rules` | object | Map of rule id to `"off"`, `"warn"` or `"error"`. Setting `"warn"` or `"error"` on a rule that is off by default turns it on |
| `allow` | string array | JavaScript regular expressions. A finding is dropped when a regex matches its line or its matched text |
| `ignoreFiles` | string array | Globs matched against repo-relative paths with forward slashes. `*` and `?` stay within a folder, `**` crosses folders, a pattern without `/` matches that name at any depth, and a trailing `/` matches a folder |
| `maxFileSizeKB` | number | Size limit for `file.large` |

An invalid config (bad JSON, unknown key or rule id, bad level, invalid regex) stops the run with exit code 2.

---

## Exit codes

| Code | Meaning |
|---|---|
| 0 | No error findings (warnings are allowed) |
| 1 | At least one error finding, or `install` refused to overwrite a foreign hook, or `uninstall` found a foreign hook |
| 2 | Usage error, invalid config, git missing, or not inside a git repository when one is needed |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `install` says a hook already exists | It is not ours. Merge the call by hand, or run `install --force` (the old hook is backed up) |
| The hook does not run | Check `git config core.hooksPath`: the hook lives there when it is set. Run `install` again from inside the repo |
| The hook says `node: command not found` | Make sure `node` is on the `PATH` seen by git. GUI git clients sometimes use a reduced `PATH` |
| The hook stopped working after moving the clone | The hook stores an absolute path to `src/cli.js`. Run `install` again |
| A test fixture or sample key is flagged | Add `commit-guard: ignore` to the line, or use `allow` or `ignoreFiles` in `.commit-guard.json` |
| `commit-guard: not inside a git repository` | `--staged` and `--all` need a repository. Pass file names to scan outside one |
| `commit-guard: .commit-guard.json: ...` | Fix the config described in the message |
| A warning blocks nothing but you want it to | Set that rule to `"error"` in the config |

---

## Development

```bash
cd toolshed/tools/commit-guard
npm install
npm test              # node --test, includes end-to-end tests in temporary git repos
npm run typecheck     # tsc with checkJs
npm run coverage      # node --test with coverage
```

Tests build secret-looking strings at runtime from pieces, so no source file contains a literal secret. Keep it that way when adding tests.
