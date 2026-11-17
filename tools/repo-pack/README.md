# repo-pack

A command line tool that bundles chosen files of a project into one prompt-ready file, so you can paste a whole codebase (or the useful part of it) into an AI assistant without blowing its context window.

- **Runs on:** Windows, macOS and Linux
- **Requires:** Node.js 20 or newer (git is optional, used when available)
- **License:** MIT

---

## Contents

- [Why](#why)
- [Install](#install)
- [Usage](#usage)
- [Options](#options)
- [How files are chosen](#how-files-are-chosen)
- [Token estimates and the budget](#token-estimates-and-the-budget)
- [Output formats](#output-formats)
- [Configuration](#configuration)
- [Exit codes](#exit-codes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Why

Pasting files one by one is slow, and pasting everything overflows the context window. `repo-pack` respects `.gitignore`, never packs secrets, skips binaries and huge files, orders what remains so the most useful files come first, and stops at a token budget you choose. The result is a single file (or stdout stream) with a file tree and every file in a fenced block.

---

## Install

You need **Node.js 20+**. git is optional.

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/repo-pack
npm install
```

Run it in place:

```bash
node /abs/path/to/toolshed/tools/repo-pack/src/cli.js --help
```

Or install the `repo-pack` command globally from the tool folder (optional):

```bash
npm install -g .
repo-pack --help
```

---

## Usage

```bash
# Pack the current directory to stdout
repo-pack

# Pack a folder to a file, within roughly 30,000 tokens
repo-pack ./my-project --max-tokens 30000 --out context.md

# Only TypeScript sources, no tests
repo-pack --include "src/**/*.ts" --exclude "**/*.test.ts"

# Several paths and globs (root is the current folder)
repo-pack README.md src "docs/**/*.md"

# XML output with line numbers, piped to the clipboard (macOS example)
repo-pack --format xml --line-numbers | pbcopy

# Keep plain path order instead of priority order
repo-pack --order path
```

The summary (files packed, estimated tokens, skipped files, files left out) is printed to **stderr**, so stdout stays clean for piping.

Quote globs so your shell does not expand them first. If the shell does expand them, repo-pack receives the file list and still works.

---

## Options

| Option | Meaning |
|---|---|
| `[paths or globs...]` | Files, folders or globs to pack. Default: the current directory. A single folder argument becomes the root. With several arguments the root is the current folder and every path must be inside it. |
| `--include <glob>` | Keep only files matching the glob. Repeatable. |
| `--exclude <glob>` | Drop files matching the glob. Repeatable. Wins over `--include`. |
| `--max-tokens <n>` | Estimated token budget. Files are added in priority order until it is used. Files that do not fit are listed as left out. |
| `--order <priority\|path>` | `priority` (default) or plain `path` order. See [How files are chosen](#how-files-are-chosen). |
| `--format <md\|xml>` | Output format. Default `md`. |
| `--out <file>` | Write to a file instead of stdout. A file inside the root is never packed into itself. |
| `--line-numbers` | Prefix each line with its number (`  7 \| code`). |
| `--max-file-size <size>` | Skip files larger than this. Default `256k`. Accepts bytes, `k`, `m` (powers of 1024). |
| `--allow-env` | Also pack `.env*` files. Without it they are always skipped, with a warning. |
| `--no-default-excludes` | Do not skip lockfiles, `*.map`, `*.log` or (outside git) `node_modules`, `dist`, `build`, `coverage`, `.git`. |
| `-h`, `--help` | Show help. |
| `-v`, `--version` | Show the version. |

Glob rules: matching is done on forward-slash paths relative to the root, and dotfiles match. A pattern without a slash (`*.js`, `test`) matches a file or folder name at any depth. A pattern with a slash (`src/*.js`) is anchored to the root. A pattern that matches a folder covers everything below it. Globs use [picomatch](https://github.com/micromatch/picomatch) syntax (`**`, `{a,b}`, `[abc]`).

When positional paths and `--include` are both given, a file must satisfy both.

---

## How files are chosen

1. **Discovery.**
   - Inside a git work tree: `git ls-files --cached --others --exclude-standard`, so tracked and untracked files are packed and `.gitignore` is respected. Lockfiles, `*.map` and `*.log` are still skipped by default.
   - Outside git (or when git is not installed): the folder is walked. Skipped by default: `node_modules`, `.git`, `dist`, `build`, `coverage`, lockfiles, `*.map`, `*.log`. `.gitignore` is not read in this mode. Symlinks are ignored.
2. **Secrets.** Any file whose name starts with `.env` (`.env`, `.env.local`, `.envrc`, even `.env.example`) is skipped and a warning is printed, unless you pass `--allow-env`. This is a name check only; repo-pack does not scan file contents for secrets.
3. **Skips, reported with the reason.** Binary files (a NUL byte in the first 8 KB), files over `--max-file-size`, files that are not valid UTF-8, symlinks, and files listed by git but missing on disk.
4. **Order.** With `--order priority` (default) files are sorted by tier, then by path depth (fewer folders first), then by plain path order, so the result is identical on every run and every OS:

   | Tier | What |
   |---|---|
   | 1 | Docs: `README*` at any depth, plus `.md`, `.mdx`, `.rst`, `.adoc` at the root or inside `docs/`, `doc/`, `documentation/` |
   | 2 | Config: `package.json`, `tsconfig*.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Dockerfile*`, `docker-compose*`, `*.config.js`/`ts`, and dotfiles or `json`/`yaml`/`toml`/`ini` files at the root |
   | 3 | Source: everything else |
   | 4 | Tests: files in `test/`, `tests/`, `__tests__/`, `spec/`, `specs/`, `e2e/`, or named `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.*` |

   `--order path` uses plain path order only. Packed files appear in the chosen order.

---

## Token estimates and the budget

Token counts are an **estimate**: `Math.ceil(characters / 4)` per file, using the packed text (after CRLF normalization and line numbers). This is a rough rule of thumb, not the output of any tokenizer. Real counts depend on the model and the content (code, non-English text and emoji usually cost more). Leave headroom.

The budget counts file contents only. The header, tree and fences add a small overhead that is not counted.

With `--max-tokens`, files are taken in order. A file that does not fit is left out, and later smaller files can still fit, so the budget is filled as far as possible. Left out files are listed on stderr and in the output itself (so the assistant knows what is missing).

---

## Output formats

**Markdown** (`--format md`, default): a header with totals, a file tree, a "left out" list if any, then each file under its path in a fenced block tagged with a language inferred from the extension. The fence is always one backtick longer than the longest backtick run in the file, so content containing triple backticks cannot break out.

**XML** (`--format xml`): a `<repo-pack>` root with a `<tree>`, optional `<omitted/>` entries, and one `<file path="..." language="..." estimated-tokens="...">` per file with the content in CDATA. A literal `]]>` in a file is split across two CDATA sections, so the document stays well formed.

In both formats paths use forward slashes and are relative to the root on every OS, and CRLF line endings are converted to LF.

---

## Configuration

There are no config files or environment variables. Everything is a command line option. git is found on `PATH`.

---

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Packed successfully |
| 1 | Nothing matched, every match was skipped, the budget was too small for any file, or the `--out` file could not be written |
| 2 | Usage error (unknown option, bad value, path not found) |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `no files matched` | Check `--include`, `--exclude` and your paths. In git mode, gitignored files are never listed. |
| A file you expected is missing | Look at the stderr summary for skip reasons (binary, too large, not UTF-8, `.env`). Raise `--max-file-size` if needed. |
| `.env` files are skipped | By design. Pass `--allow-env` only if you are sure the content is safe to share. |
| Lockfile or `dist` is missing | They are skipped by default. Use `--no-default-excludes` to keep them. |
| `the --max-tokens budget of N is too small for any file` | Raise the budget or exclude large files. The stderr list shows the size of each file. |
| Packed output is larger than the budget in your assistant | The estimate is `characters / 4`. Lower `--max-tokens` for headroom. |
| `.gitignore` seems ignored | Outside a git work tree repo-pack walks the folder and does not read `.gitignore`. Run it inside the repo and make sure `git` is on `PATH`. |
| Glob matches nothing on Windows | Quote the glob. Backslashes in patterns are treated as slashes on Windows. |

---

## Development

```bash
npm install
npm test
npm run typecheck
npm run coverage
```

Tests build their own temp folders and temp git repos and spawn the real CLI. Symlink tests are skipped automatically on systems where symlinks cannot be created.
