# test-report-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that runs your project's tests and returns only what an AI assistant needs to fix the failures: test names, `file:line`, the assertion message and a trimmed stack.

- **Runs on:** Windows, macOS and Linux
- **Requires:** Node.js 20 or newer, plus the test runner of the project you point it at
- **Runners:** vitest, jest, node:test (`node --test`), mocha, pytest, go test
- **License:** MIT

---

## Contents

- [Why](#why)
- [Install](#install)
- [Connect your assistant](#connect-your-assistant)
- [Usage](#usage)
- [Tools](#tools)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Why

A full test log can run to tens of thousands of tokens, and almost all of it is passing tests, progress bars and framework noise. This server asks the runner for a machine-readable report (JUnit XML, JSON, TAP or `go test -json`), parses it, and returns a short summary plus one compact block per failure.

| Technique | Effect |
|---|---|
| **Structured reports** | No scraping of colored console output. |
| **Stack trimming** | Frames from `node_modules`, `node:internal`, `site-packages` and the Go runtime are dropped, 8 frames at most. |
| **Message cap** | 20 lines per failure, long lines clipped. |
| **Total cap** | About 12000 characters, with a count of omitted failures. |
| **No ANSI codes** | Color escapes are stripped. |
| **Crash fallback** | If the runner dies before writing a report, you get the last 60 lines of output instead of nothing. |
| **Root-relative paths** | The absolute repo path is removed from output. |

---

## Install

You need **Node.js 20+**.

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/test-report-mcp
npm install
```

The entry point you register with a client is:

```
<where you cloned>/toolshed/tools/test-report-mcp/src/server.js
```

Print the exact absolute path for your machine:

```bash
node -e "console.log(require('path').resolve('src/server.js'))"
```

### Optional: install as a global command

```bash
npm install -g .
```

This puts `test-report-mcp` on your `PATH`. Registering with `node` and the absolute path works the same on every OS, so prefer that unless you need the short command.

---

## Connect your assistant

Replace `/abs/path/to/src/server.js` with the path printed above. On Windows use either forward slashes or escaped backslashes inside JSON.

> **Which repo does it work on?** By default the server walks up from the directory it was launched in to the nearest git root. Terminal clients like Claude Code launch it inside your project, so this just works. Desktop apps usually launch it from their own directory, so set `REPO_ROOT` in the config.

### Claude Code

```bash
claude mcp add test-report --scope user -- node /abs/path/to/src/server.js
```

Check it with `claude mcp list`.

### Claude Desktop

Edit `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "test-report": {
      "command": "node",
      "args": ["/abs/path/to/src/server.js"],
      "env": { "REPO_ROOT": "/abs/path/to/your/project" }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "test-report": {
      "command": "node",
      "args": ["/abs/path/to/src/server.js"]
    }
  }
}
```

### VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "test-report": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/src/server.js"],
      "env": { "REPO_ROOT": "${workspaceFolder}" }
    }
  }
}
```

### Any other MCP client

Run `node /abs/path/to/src/server.js` as a stdio server.

---

## Usage

Ask your assistant to run the tests, or call the tools directly.

Detect what the project uses:

```
detect_test_runner {}
```

```
Detected in .:
1. node:test (high, package.json test script) [default]
   command: node --test-reporter=junit --test-reporter-destination=<report> --test
```

Run everything, or narrow it down:

```
run_tests {}
run_tests { "runner": "vitest", "filter": "cart total" }
run_tests { "files": ["test/cart.test.js"], "timeoutMs": 60000 }
run_tests { "cwd": "packages/api" }
```

A failing run looks like this:

```
Runner: node:test
Command: node --test-reporter=junit --test-reporter-destination=<report> --test
Summary: 3 tests, 1 passed, 1 failed, 1 skipped (1ms)

Failures (1):

1) math > subtracts wrongly
   at test/sample.test.js:5
   Expected values to be strictly equal:

   2 !== 5
   stack:
     at TestContext.<anonymous> (test/sample.test.js:5:44)
```

Parse a report you already have (the file must be inside the repo root):

```
parse_report { "path": "reports/junit.xml" }
parse_report { "path": "out/go.jsonl", "format": "go-json" }
```

Re-read the last result without re-running:

```
list_failures_from_last_run {}
```

---

## Tools

Every tool accepts an optional `cwd`: a directory relative to the repo root. Paths that escape the root (including through symlinks) are rejected.

| Tool | Arguments | What it does |
|---|---|---|
| `detect_test_runner` | `cwd?` | Reports the runner(s) found and the command that would run. Looks at `package.json` dependencies and scripts, runner config files, `pyproject.toml`, `pytest.ini`, `conftest.py` and `go.mod`. |
| `run_tests` | `runner?`, `filter?`, `files?`, `timeoutMs?`, `cwd?` | Runs the tests with a machine-readable reporter and returns the summary plus each failure. `runner` defaults to the first detected one. `filter` is a test name pattern (it may not start with `-`). `files` are paths inside the root. `timeoutMs` defaults to 300000 and is capped at 900000. |
| `parse_report` | `path`, `format?`, `cwd?` | Parses an existing report: `junit`, `jest-json`, `tap`, `go-json` or `mocha-json`. The format is auto-detected when omitted. |
| `list_failures_from_last_run` | `cwd?` | Returns the cached result of the last `run_tests` in this session. |

### How each runner is invoked

| Runner | Report | Notes |
|---|---|---|
| vitest | `run --reporter=junit --outputFile=<tmp>` | Filter becomes `--testNamePattern`. |
| jest | `--json --outputFile=<tmp>` | Filter becomes `--testNamePattern`. |
| node:test | `--test-reporter=junit --test-reporter-destination=<tmp>` | Falls back to `--test-reporter=tap` on a Node without the junit reporter. Filter becomes `--test-name-pattern`. |
| mocha | `--reporter json --reporter-option output=<tmp>` | Falls back to JSON on stdout for older mocha. Filter becomes `--grep`. |
| pytest | `python -m pytest --junitxml=<tmp> -o junit_family=xunit1 --tb=short` | Filter becomes `-k`. |
| go | `go test -json` | `files` are mapped to their packages. Filter becomes `-run`. |

JavaScript runners are started as `node <package bin>` from the project's `node_modules`, so no shell and no `.cmd` shim is involved, and arguments are never shell-quoted. If the runner is not in `node_modules`, the tool tells you to run `npm install`.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `REPO_ROOT` | nearest git root above the launch directory, else the launch directory | Root that every `cwd` and path is confined to. |
| `TEST_REPORT_PYTHON` | `python` and `py` on Windows, `python3` and `python` elsewhere | Python executable used for pytest. |
| `TEST_REPORT_NODE_REPORTER` | auto | Set to `tap` or `junit` to force the node:test reporter. |

Test processes run with `NO_COLOR=1` and `CI=1`, and without `FORCE_COLOR`.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `X not found in node_modules` | Run `npm install` in the project (or in the folder you pass as `cwd`). |
| `No test runner detected` | Pass `runner` explicitly, or set `cwd` to the package that holds the tests. |
| `Could not start python` | Install Python or set `TEST_REPORT_PYTHON`. |
| `Invalid path: outside repo root` | `cwd`, `files` and `path` must stay inside `REPO_ROOT`. Set `REPO_ROOT` to a parent folder if you need a wider scope. |
| `before producing a report` | The runner crashed (config error, syntax error, missing dependency). The last 60 lines of output are shown. |
| `Timed out after N ms` | Raise `timeoutMs` (max 900000) or narrow the run with `files` or `filter`. |
| pytest reports nothing for a file | Check `pytest.ini` or `pyproject.toml` for `testpaths` and naming rules. |
| `Runner exited with code N but the report lists no failures` | The run failed outside any test, for example a coverage threshold. Run the command from the `Command:` line to see it. |

---

## Development

```bash
npm install
npm test
npm run typecheck
npm run coverage
```

Parsers are tested against fixture files in `test/fixtures/`. End-to-end tests start the real server over stdio with the MCP SDK client and call every tool, including a real `node --test` run against a temporary project. Live pytest and `go test` tests run only when those tools are installed. vitest, jest and mocha are exercised through fixtures and small simulated binaries, not the real packages.
