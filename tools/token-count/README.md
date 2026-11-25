# token-count

A command-line tool that estimates how many tokens files or folders will cost before you paste them into an AI assistant.

- **Runs on:** Windows, macOS and Linux (Node.js 20 or newer)
- **Requires:** Node.js 20+, and `git` (optional, used for file discovery inside repos). `--exact` also needs an Anthropic API key.
- **License:** AGPL-3.0-only

---

## Contents

- [Why](#why)
- [Install](#install)
- [Usage](#usage)
- [Options](#options)
- [Configuration](#configuration)
- [Exit codes](#exit-codes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Why

Pasting a whole folder into an assistant can blow past its context window or cost more than you expected. `token-count` shows which files are the expensive ones, and what share of the total each takes, so you can trim before you paste.

- **Offline by default.** The default result is an estimate (`ceil(characters / 4)`), clearly labeled as one. No network, no key.
- **Exact when you need it.** `--exact` asks the Anthropic token counting API for real numbers, one file at a time.
- **Sensible discovery.** Inside a git repo it uses `git ls-files`, so `.gitignore` is respected. Elsewhere it walks the folder and skips `node_modules`, `.git`, `dist`, `build`, `coverage`, lockfiles and `*.map`. Binary files are skipped.

---

## Install

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/token-count
npm install
```

Optionally put the command on your PATH:

```bash
npm install -g .
token-count --help
```

Or run it without installing globally:

```bash
node /abs/path/to/toolshed/tools/token-count/src/cli.js --help
```

---

## Usage

```bash
# Current directory
token-count

# Specific files and folders
token-count src README.md

# Only the 10 biggest files
token-count --top 10

# Totals per top-level directory
token-count --by-dir

# Fail (exit 1) when the total is over 50,000 tokens
token-count src --budget 50000

# Machine-readable output
token-count --json

# Real counts from the Anthropic API
export ANTHROPIC_API_KEY=your-key-here
token-count src --exact --model claude-haiku-5-5

# Read text from stdin
cat notes.md | token-count -
```

Example output:

```
Estimated token counts (offline estimate: characters / 4, not exact)

tokens  share  path
 4,210  61.2%  src/server.js
 1,950  28.3%  src/util.js
   720  10.5%  README.md

Total: 6,880 tokens (estimate) across 3 files
```

Paths are printed with forward slashes, relative to the root. The root is the directory you pass when you give exactly one directory, otherwise the current directory.

---

## Options

| Option | Description |
|---|---|
| `[paths...]` | Files or folders to count. Defaults to the current directory. |
| `-` | Also read text from stdin (shown as `<stdin>`). Alone, it skips the directory scan. |
| `--exact` | Use the Anthropic token counting API instead of the offline estimate. |
| `--model <id>` | Model for `--exact`. Default `claude-haiku-5-5`. |
| `--top <n>` | Show only the `n` largest rows. The total still covers everything. |
| `--by-dir` | Aggregate by top-level directory. Files in the root are grouped as `(root)`. |
| `--json` | Print JSON: `mode`, `model` (exact only), `total`, `fileCount`, `skippedBinary`, `rows`, `truncated`, `budget`. |
| `--budget <n>` | Exit 1 when the total is over `n` tokens, and say by how much. |
| `-h`, `--help` | Show help. |
| `-v`, `--version` | Show the version. |

---

## Configuration

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | API key for `--exact`. Never printed. |
| `ANTHROPIC_BASE_URL` | API base URL. Default `https://api.anthropic.com`. |
| `TOKEN_COUNT_RETRY_BASE_MS` | First retry delay for `--exact` in milliseconds. Default 500, doubled on each retry. |

`--exact` sends one request per file to `POST {base}/v1/messages/count_tokens`, 4 at a time. Responses with status 429 or 5xx, and network failures, are retried up to 3 times with backoff. Empty files count as 0 without a request. File contents are sent to the API, so use the offline estimate for anything you do not want to send.

---

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | Over budget, an API error, or a missing `ANTHROPIC_API_KEY` with `--exact`. |
| 2 | Usage error (unknown option, bad number, path not found). |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `--exact needs the ANTHROPIC_API_KEY environment variable` | Export the key in the same shell, then run again. |
| `API error 401` | The key is wrong or revoked. |
| `API error 429` after retries | You are rate limited. Wait and retry, or count a smaller set. |
| A file you expected is missing | Inside a git repo, ignored files are skipped. Binary files (a NUL byte in the first 8 KB) are always skipped, and are listed in the skipped count. |
| Lockfiles or `dist/` are missing outside git | The default excludes apply when not in a git repo. Pass the file path explicitly to count it. |
| Estimate differs from `--exact` | The estimate is a rough `chars / 4`. Code, non-English text and emoji can differ a lot. |

---

## Development

```bash
npm install
npm test
npm run typecheck
npm run coverage
```

Tests build temporary fixtures and use a local mock HTTP server for `--exact`. They never touch the network.
