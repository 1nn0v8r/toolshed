# diff-brief

Summarize sprawling git diffs and pull requests into token-compact review briefs with risk flags, lockfile deltas, and symbol changes.

- **Runs on:** Windows, macOS, Linux
- **Requires:** Node.js 20 or newer, `git` on `PATH` (optional when using `--diff-file` or `--stdin`)
- **License:** MIT

---

## Install

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/diff-brief
npm install
```

Optional global command:

```bash
npm install -g .
```

Or run directly without global install:

```bash
node /abs/path/to/tools/diff-brief/src/cli.js --help
```

---

## Usage

Run inside any git repository. By default, `diff-brief` inspects uncommitted working tree changes if present, or compares the current branch against `main`/`master` (or `HEAD~1`).

```bash
# Auto-detect working tree or branch diff
diff-brief

# Inspect staged changes before committing
diff-brief --staged

# Compare current branch against main (merge-base)
diff-brief --base main

# Inspect an explicit git range or single commit
diff-brief main..HEAD
diff-brief --commit HEAD

# Generate a PR-ready Markdown summary without raw hunks
diff-brief --base main --format md --no-hunks

# Pipe any unified diff from stdin or read a patch file
git diff main..HEAD | diff-brief --stdin
diff-brief --diff-file changes.patch --format json

# Enforce a CI gate on high-risk diffs or skipped tests
diff-brief --base main --fail-on high --fail-on-flag test-skip
```

### Options

| Flag | Description |
|---|---|
| `--path <dir>` | Repository directory to inspect (default: current directory) |
| `--staged` | Inspect staged changes (`git diff --cached`) |
| `--unstaged` | Inspect unstaged working tree changes |
| `--all` | Inspect all staged and unstaged changes against `HEAD` |
| `--base <ref>` | Compare `<ref>...HEAD` using merge-base |
| `--commit <sha>` | Inspect a single commit |
| `--diff-file <file>` | Read a unified diff from a file (`-` for stdin) |
| `--stdin` | Read a unified diff from standard input |
| `--format <type>` | Output format: `text` (default), `md`, or `json` |
| `--max-tokens <n>` | Token budget for included key hunks (default: `1800`, `0` for summary only) |
| `--no-hunks` | Omit diff hunks (alias for `--max-tokens 0`) |
| `--include-noise` | Include lockfile and generated file hunks instead of summarizing them |
| `--ignore <glob>` | Ignore matching file paths (repeatable) |
| `--fail-on <level>` | Exit with code `1` if risk is at least `low`, `medium`, or `high` |
| `--fail-on-flag <id>` | Exit with code `1` if a specific risk flag triggers (repeatable) |
| `-h, --help` | Show CLI help |
| `-v, --version` | Show version |

### What it detects

- **Noise separation:** Lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `uv.lock`, `go.sum`) and generated artifacts (`*.min.js`, `*.map`, `*.snap`, `dist/**`) are summarized instead of bloating output.
- **`package.json` deltas:** Added, removed, and updated dependencies plus modified `scripts`.
- **Risk flags:**
  - `test-skip` (`high`): Added `.skip`, `.only`, `xit`, `@pytest.mark.skip`, `#[ignore]`, or `t.Skip`.
  - `assertion-removed` (`medium`): Net reduction of test assertions in a test file.
  - `type-suppression` (`medium`): Added `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable`, `# type: ignore`, `noqa`, or TypeScript `any` annotations in source files.
  - `sensitive-surface` (`high` or `medium`): Changes to `.github/workflows/`, `.env*`, `Dockerfile`, migrations/SQL, security rules, auth/crypto/permissions files, or `package.json` deps/scripts.
  - `unpaired-source` (`medium`): Source files changed (`>= 15` added lines by default) without touching any test files.
  - `large-deletion` (`medium`): Single non-noise file losing `>= 80` lines with fewer than `10` added lines.
  - `debug-leftover` (`medium` or `low`): Added `debugger`, `breakpoint()`, `dbg!()`, or `console.log`/`console.debug` in source files.
  - `todo-added` (`low`): Added `TODO`, `FIXME`, `HACK`, or `XXX` comments.
  - `binary-added` (`low`): Binary file added or modified.

### Exit codes

- `0`: Brief generated and within configured `--fail-on` / `--fail-on-flag` thresholds.
- `1`: Risk threshold or flagged rule exceeded.
- `2`: Invalid CLI arguments, missing diff file, or git error.

---

## Configuration

Add `.diffbriefrc.json` at the repository root or a `"diff-brief"` block inside `package.json`:

```json
{
  "ignore": ["docs/generated/**", "**/*.fixture.js"],
  "ignoreFlags": ["todo-added"],
  "sensitivePatterns": ["src/billing/**"],
  "testPatterns": ["e2e/**/*.ts"],
  "maxTokens": 1200,
  "requireTests": true,
  "unpairedSourceMinLines": 20,
  "largeDeletionThreshold": 100,
  "failOn": "high",
  "failOnFlags": ["test-skip"]
}
```

CLI flags override configuration file values when both are specified.

---

## Troubleshooting

- **"Not inside a git repository":** Pass `--path /abs/path/to/repo`, or pipe a patch with `--stdin` / `--diff-file`.
- **"Could not detect a base branch":** The repo uses a default branch other than `main` or `master`. Pass `--base <branch>` explicitly.
- **No changes shown on a clean branch:** If you are already on `main` with a clean working tree, `diff-brief` falls back to `HEAD~1..HEAD`. Pass an explicit range like `HEAD~3..HEAD` or `--commit <sha>` to inspect earlier work.
- **Too many `unpaired-source` warnings in docs-only or prototype repos:** Set `"requireTests": false` or add `"unpaired-source"` to `ignoreFlags` in `.diffbriefrc.json`.

---

## Development

```bash
cd tools/diff-brief
npm install
npm run typecheck
npm test
```

All tests use Node's built-in `node:test` runner and temporary git repositories or synthetic unified diffs.
