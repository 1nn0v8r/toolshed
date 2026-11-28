# flake-check

Zero-dependency CLI that scans tests for non-deterministic anti-patterns and stress-runs test commands to catch flaky tests and timing outliers before CI does.

- **Runs on:** Windows, macOS, Linux
- **Requires:** Node.js >= 20
- **License:** AGPL-3.0-only

---

## Contents

- [Why](#why)
- [Install](#install)
- [Usage](#usage)
- [Configuration](#configuration)
- [Rules](#rules)
- [Exit codes](#exit-codes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Why

AI coding agents generate tests fast, but speed amplifies two kinds of verification friction:

1. **Non-deterministic test anti-patterns:** Agents routinely leave `.only()` / `.skip()`, bind hardcoded ports like `.listen(3000)` instead of ephemeral port `0`, add arbitrary `setTimeout` / `sleep` waits, assert against unmocked `Date.now()` or `Math.random()`, call live external URLs, or write to fixed `/tmp/...` paths that collide in parallel CI.
2. **Intermittent failures that waste CI cycles:** When a test fails 1 out of 5 runs, developers burn minutes re-running whole pipelines to figure out whether a failure is real or flaky and which specific test case flaked.

`flake-check` solves both with one zero-dependency CLI:

- **`flake-check scan`** performs fast static analysis across JS, TS, Python, Go, and Ruby test files.
- **`flake-check run`** executes any test command repeatedly (sequentially or in parallel), tracks pass/fail rates, computes timing variance (`min`, `median`, `p95`, `max`, `CV%`), and pinpoints individual flaky test cases from TAP (`node --test`), Jest/Vitest, `pytest -v`, and `go test -v` output.

---

## Install

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/flake-check
npm install
```

Run directly with Node.js:

```bash
node /abs/path/to/toolshed/tools/flake-check/src/cli.js --help
```

Or install globally (or run via the root `toolshed flake-check` command):

```bash
npm install -g .
flake-check --help
```

---

## Usage

### Static flakiness scan

```bash
# Scan all test files in the current repository
flake-check

# Scan specific files or folders
flake-check scan test/ packages/api/test

# Scan only staged or changed test files (ideal for pre-commit hooks)
flake-check scan --staged
flake-check scan --changed
flake-check scan --diff main

# Treat warnings as blocking errors
flake-check scan --strict

# Output JSON, Markdown (for PR comments), or SARIF 2.1.0 (for GitHub Code Scanning)
flake-check scan --json
flake-check scan --md
flake-check scan --sarif > flake-check.sarif
```

Sample static scan output:

```text
flake-check: scanned 12 test file(s) (repo scan)

Findings (2):
  [ERROR] flake.focused-test (test/auth.test.js:14:1): Focused test "it.only" skips other tests in CI
          it.only("refreshes expired tokens", async () => {
          Fix: Remove .only / fit / fdescribe so the full test suite runs in CI.
  [WARN]  flake.hardcoded-port (test/server.test.js:9:8): Hardcoded port 3000 in .listen() can fail with EADDRINUSE in parallel runs
          server.listen(3000);
          Fix: Bind to ephemeral port 0 (e.g. server.listen(0, '127.0.0.1')) and read server.address().port.

Summary: 1 error(s), 1 warning(s)
Status: FAILED
```

### Stress-run a test command

```bash
# Run a test suite 5 times sequentially
flake-check run --runs 5 -- npm test

# Run 10 repetitions across 4 parallel workers and stop as soon as a flake appears
flake-check run --runs 10 --jobs 4 --stop-on-flake -- node --test

# Set a per-run timeout (ms) and output JSON or Markdown
flake-check run --runs 5 --timeout 15000 --md -- pytest -v
```

Sample stress-run output:

```text
flake-check run: node --test
Completed 5/5 run(s): 4 passed, 1 failed
Timing: min=82ms median=94ms p95=148ms max=148ms (CV 22.4%)

Flaky test cases (1):
  [FLAKY] handles concurrent webhook delivery (4/5 passed, 1/5 failed)

Sample failure output:
  Run #3 (exit 1, 148ms):
    not ok 4 - handles concurrent webhook delivery
    AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: 202 !== 503

Verdict: FLAKY
```

---

## Configuration

Generate a starter `.flake-check.json` with `flake-check init`, or create one manually at your repository root (or pass `--config /abs/path/to/.flake-check.json`):

```json
{
  "ignoreRules": [],
  "ignoreFiles": ["test/fixtures/**"],
  "maxFileSizeKB": 1024,
  "strict": false,
  "runs": 5,
  "jobs": 1,
  "timeoutMs": 60000
}
```

| Field | Type | Description | Default |
|---|---|---|---|
| `ignoreRules` | `string[]` | Static rule IDs to disable | `[]` |
| `ignoreFiles` | `string[]` | Glob patterns of test files/folders to skip | `[]` |
| `maxFileSizeKB` | `number` | Skip files larger than this size | `1024` |
| `strict` | `boolean` | Treat warnings as blocking errors | `false` |
| `runs` | `number` | Default repetition count for `run` | `5` |
| `jobs` | `number` | Default concurrent workers for `run` | `1` |
| `timeoutMs` | `number` | Default per-run timeout in milliseconds | `60000` |

### Inline suppressions

Suppress a deliberate pattern on the same line or the immediately preceding line:

```js
server.listen(3000); // flake-check-ignore flake.hardcoded-port

// flake-check-ignore
const sample = Math.random();
```

---

## Rules

Run `flake-check rules` to list all built-in rules and their enabled status:

| Rule ID | Severity | Description |
|---|---|---|
| `flake.focused-test` | `error` | Detects `.only()`, `fit()`, `fdescribe()`, or `@pytest.mark.only` left in tests |
| `flake.skipped-test` | `warn` | Detects `.skip()`, `xit()`, `xdescribe()`, `@pytest.mark.skip`, or `t.Skip()` |
| `flake.hardcoded-port` | `warn` | Detects fixed ports in `.listen()`, `port: 3000`, or `net.Listen()` |
| `flake.arbitrary-sleep` | `warn` | Detects `setTimeout(..., >=25)`, `time.sleep()`, `page.waitForTimeout()`, `cy.wait(ms)`, `time.Sleep()` |
| `flake.wall-clock` | `warn` | Detects `Date.now()`, `new Date()`, `time.time()`, `datetime.now()`, `time.Now()` without fake timers |
| `flake.unseeded-random` | `warn` | Detects `Math.random()`, `random.*`, or Go `rand.*` without an explicit seed or spy |
| `flake.external-network` | `warn` | Detects HTTP requests to non-local hosts (allows `localhost`, `127.0.0.1`, `*.example`, `*.test`) |
| `flake.shared-tmp-path` | `warn` | Detects hardcoded `/tmp/<name>` or unrandomized `os.tmpdir()` paths |

---

## Exit codes

- `0`: Scan clean (or warnings only without `--strict`), or all stress runs passed (`PASS`)
- `1`: Blocking static findings detected, or stress runs were `FLAKY` or `FAIL`
- `2`: Invalid CLI usage, config error, missing path, or `init` target already exists

---

## Troubleshooting

- **Windows command not found in `flake-check run`:** Pass commands after `--`, for example `flake-check run -- npm test` or `flake-check run -- node --test`.
- **Fake timers or seeded random still flagged:** Ensure the file calls `useFakeTimers`, `mock.timers`, `setSystemTime`, `freeze_time`, `random.seed`, or `seedrandom`, or add `// flake-check-ignore <rule-id>` on the line.
- **Per-test names missing in `run` summary:** Use a line-oriented reporter (such as `node --test`, `pytest -v`, `go test -v`, or Jest/Vitest verbose mode) instead of a compact dot reporter.

---

## Development

```bash
cd tools/flake-check
npm install
npm run typecheck
npm test
```
