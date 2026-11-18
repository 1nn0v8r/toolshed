# diagnostics-trim-mcp

Runs project typecheckers and linters, returning token-compact, deduplicated diagnostics without cascading errors.

- **Runs on:** Windows, macOS, Linux
- **Requires:** Node.js 20 or newer
- **License:** MIT

---

## Contents

- [Why](#why)
- [Install](#install)
- [Usage](#usage)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Why

Compilers and linters such as `tsc`, `eslint`, `pyright` and `cargo check` often emit hundreds of lines of noise for a single underlying issue. A single missing export can trigger dozens of cascading type errors across importing files.

`diagnostics-trim-mcp` captures this output, strips redundant secondary messages, deduplicates identical warnings, attaches code context snippets, and caps the result to a strict token budget.

---

## Install

Clone the repository and install dependencies:

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/diagnostics-trim-mcp
npm install
```

Register the MCP server with your AI assistant (Claude Code, Cursor, Windsurf, or Antigravity):

```json
{
  "mcpServers": {
    "diagnostics-trim": {
      "command": "node",
      "args": ["/abs/path/to/toolshed/tools/diagnostics-trim-mcp/src/cli.js", "--server"]
    }
  }
}
```

---

## Usage

### As an MCP Server

The server registers two tools:

1. `check_diagnostics`:
   - `command`: Command to execute (for example `npm run typecheck`, `npx tsc --noEmit`, `cargo check`).
   - `preset`: `auto`, `tsc`, `eslint`, `python`, `cargo` (default: `auto`).
   - `maxErrors`: Maximum number of diagnostics to return (default: 15).
   - `includeSnippets`: Include a 2-line code snippet showing the error site (default: true).

2. `trim_diagnostics`:
   - `text`: Raw compiler or linter output text from a terminal run.
   - `preset`: `auto`, `tsc`, `eslint`, `python`, `cargo` (default: `auto`).
   - `maxErrors`: Maximum number of diagnostics to return (default: 15).
   - `includeSnippets`: Include a 2-line code snippet showing the error site (default: true).

### As a CLI Tool

Run a command and receive trimmed output:

```bash
node src/cli.js -- npm run typecheck
```

Or pipe compiler output from stdin:

```bash
npx tsc --noEmit | node src/cli.js
```

---

## Configuration

Options can be passed as CLI arguments:

| Option | Meaning |
|---|---|
| `--preset <auto\|tsc\|eslint\|python\|cargo>` | Parser preset to use (default: auto) |
| `--max <n>` | Maximum number of diagnostics to display (default: 15) |
| `--no-snippets` | Do not include source code context snippets |
| `--server` | Start the MCP server on stdio |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

---

## Troubleshooting

- **No errors parsed:** Ensure the compiler is not outputting in an unsupported custom format. You can pass `--preset` explicitly if auto-detection misses the format.
- **Command timed out:** Long-running builds or tests will time out after 30 seconds by default. Use narrow typecheck commands (such as `tsc --noEmit`) rather than full monorepo build pipelines.

---

## Development

Run tests and type checking:

```bash
npm test
npm run typecheck
```
