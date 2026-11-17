# env-check

A CLI that compares the environment variables your code actually reads with what `.env.example` documents, so missing or stale settings are caught in CI.

- **Runs on:** Windows, macOS and Linux
- **Requires:** Node.js 20 or newer (git is optional, used to respect `.gitignore`)
- **License:** MIT

---

## Contents

- [Why](#why)
- [Install](#install)
- [Usage](#usage)
- [Options](#options)
- [Configuration](#configuration)
- [What it detects](#what-it-detects)
- [Exit codes](#exit-codes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Why

`.env.example` drifts. Someone adds `process.env.STRIPE_KEY`, nobody documents it, and the next person to clone the repo hits a confusing runtime error. Or a setting is removed from the code and its example line lives on for years.

env-check reads your source, reads the example file, and tells you the difference. It only ever reports **key names and file locations**. Values from `.env` files are never printed, and the parser does not even keep them in memory after reading a line.

## Install

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/env-check
npm install
```

Run it with node and the absolute path (works the same on every OS):

```bash
node /abs/path/to/toolshed/tools/env-check/src/cli.js /abs/path/to/your/project
```

Optional: install as a global command, which puts `env-check` on your `PATH`:

```bash
npm install -g .
```

## Usage

```bash
# Check the current directory against ./.env.example
env-check

# Check another folder
env-check apps/web

# Use a different example file, ignore some names, and fail on stale keys too
env-check --example .env.sample --ignore "AWS_*" --ignore SENTRY_DSN --strict

# Machine-readable output for CI
env-check --json

# Add every missing key to .env.example with an empty value
env-check --fix
```

Sample output:

```
env-check: scanned 42 files (git)

Used in code but missing from .env.example (1):
  STRIPE_KEY  src/billing.ts:12, src/webhook.ts:4

In .env.example but never used in code (1):
  OLD_FLAG

2 dynamic reads that could not be checked: src/config.ts:30, src/config.ts:41

Problems found.
```

Which files are scanned:

- Inside a git repo, env-check uses `git ls-files` (tracked plus untracked files that are not ignored), so `.gitignore` is respected.
- Otherwise (or if git is not installed) it walks the folder and skips `node_modules`, `.git`, `dist`, `build`, `coverage`, `vendor` and `.venv`.
- Files over 2 MB are skipped and counted in the report.

The three checks:

1. **Used in code but missing from the example**, with `file:line` locations.
2. **In the example but never used.** Reported always, an error only with `--strict`.
3. **In the example but missing from your real `.env`.** Runs when `./.env` exists or when you pass `--env <file>`.

## Options

| Option | Description |
|---|---|
| `[dir]` | Directory to check. Default: the current directory. |
| `--example <file>` | Example file to compare against. Default: `.env.example`. Relative paths resolve against `dir`. |
| `--env <file>` | Real env file to check example keys against. Default: `.env` if it exists. Relative to `dir`. |
| `--ignore <name or glob>` | Ignore a variable. Repeatable. `*` and `?` are supported and matching is case-sensitive. |
| `--fix` | Append missing keys to the example file with empty values under `# Added by env-check`. Existing content and line endings are preserved. Creates the file if it does not exist. |
| `--json` | Print the report as JSON. |
| `--strict` | Treat unused example keys as an error as well. |
| `-h`, `--help` | Show help. |
| `-v`, `--version` | Show the version. |

Built-in ignores for well-known runtime variables: `NODE_ENV`, `PATH`, `HOME`, `CI`, `PWD`, `USER`, `USERNAME`, `SHELL`, `TERM`, `LANG`, `TMPDIR`, `TEMP`, `TMP`, `HOSTNAME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, Windows system variables (`PATHEXT`, `ProgramFiles`, `ProgramW6432`, `SystemRoot`, `windir`, `ComSpec` and similar), and POSIX conventions (`LOGNAME`, `EDITOR`, `TZ`, `LC_ALL`, `NO_COLOR`, `FORCE_COLOR`, `XDG_*_HOME` and similar). Built-ins match case-insensitively, as Windows does; your own `--ignore` names are case-sensitive. `PORT` is **not** ignored. Vite's `import.meta.env.MODE`, `DEV`, `PROD`, `SSR` and `BASE_URL` are skipped too.

### JSON output

```json
{
  "dir": ".",
  "example": { "file": ".env.example", "found": true },
  "envFile": null,
  "scannedFiles": 42,
  "skippedLargeFiles": 0,
  "mode": "git",
  "strict": false,
  "missing": [{ "name": "STRIPE_KEY", "locations": [{ "file": "src/billing.ts", "line": 12 }] }],
  "unused": ["OLD_FLAG"],
  "missingInEnv": [],
  "dynamic": { "count": 2, "locations": [{ "file": "src/config.ts", "line": 30 }] },
  "fixed": [],
  "ok": false
}
```

## Configuration

Put a `.env-check.json` in the directory you check:

```json
{
  "example": ".env.sample",
  "ignore": ["AWS_*", "SENTRY_DSN"],
  "paths": ["src", "server"]
}
```

| Key | Meaning |
|---|---|
| `example` | Example file path (command line `--example` wins). |
| `ignore` | Names or globs to ignore (added to any `--ignore` flags). |
| `paths` | Only scan these files or folders, relative to the directory. |

An invalid config file is a usage error (exit code 2).

## What it detects

| Language | Reads that are recognised |
|---|---|
| JS / TS (`.js .jsx .mjs .cjs .ts .tsx .mts .cts .vue .svelte .astro`) | `process.env.NAME`, `process.env["NAME"]`, `process.env['NAME']`, `const { A, B } = process.env`, `import.meta.env.NAME`, `Deno.env.get("NAME")`, `Bun.env.NAME` |
| Python | `os.environ["NAME"]`, `os.environ.get("NAME")`, `os.getenv("NAME")` (also bare `environ` and `getenv`) |
| Go | `os.Getenv("NAME")`, `os.LookupEnv("NAME")` |
| Ruby | `ENV["NAME"]`, `ENV.fetch("NAME")` |
| PHP | `getenv('NAME')`, `$_ENV['NAME']`, Laravel `env('NAME')` |
| Rust | `env::var("NAME")`, `std::env::var("NAME")`, `env::var_os`, `env!` and `option_env!` |
| docker-compose files | `${NAME}`, `${NAME:-x}`, `${NAME:?msg}` (and the `-`, `?`, `+` variants) |

Limits to know about:

- **Dynamic access** such as `process.env[key]` cannot be resolved. It is counted and listed as "dynamic reads that could not be checked".
- Lines that are entirely a comment are ignored. Reads inside block comments that do not start the line, strings or generated code are not.
- Detection is pattern based, not a full parse. Names must be literals.
- Example and env files accept `KEY=VALUE`, `export KEY=`, comments, blank lines, quoted values (including multi-line) and CRLF.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Clean. |
| 1 | Problems found: variables missing from the example, example keys missing from `.env`, or (with `--strict`) unused example keys. |
| 2 | Usage error: bad option, missing directory or file given on the command line, invalid config. |

With `--fix`, keys that were missing are added and no longer count as a problem. Other problems still produce exit code 1.

## Troubleshooting

| Problem | Fix |
|---|---|
| A variable you read is not reported | It is probably accessed dynamically, through a name that is not a literal, or in a file type that is not scanned. Check the "dynamic reads" line. |
| A well-known variable is reported | Add it with `--ignore NAME` or to `ignore` in `.env-check.json`. |
| Too many example keys flagged as unused | They may be read by tools outside your code (for example a framework). Add them to `ignore`. |
| Files in a git repo are not scanned | They are probably listed in `.gitignore`. Untracked files that are not ignored are scanned. |
| `example file not found` (exit 2) | The path you gave to `--example` does not exist. Relative paths resolve against the directory being checked. Use `--fix` to create it. |
| Fails in CI only because of `.env` | A `.env` file exists in the CI checkout and lacks keys. Remove it from the job or pass `--env` explicitly where you want that check. |

## Development

```bash
npm install
npm test
npm run typecheck
npm run coverage
```

Tests build temporary projects (and temporary git repos) under the OS temp folder and spawn the real CLI. No network access is needed.
