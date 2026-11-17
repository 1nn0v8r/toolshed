<p align="center">
  <img src="docs/images/toolshed-hero.jpg" alt="A weathered wooden tool shed with a TOOL SHED sign, garden tools leaning against it and a cat by the door, in a flowering garden with city towers behind" width="100%">
</p>

# toolshed

Open source developer tools for faster, leaner, AI-assisted coding.

Each tool lives in its own folder under [`tools/`](tools), with its own install guide, changelog and version. Use one tool or all of them.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Tools

| Tool | What it does | Type | Platforms | Status |
|---|---|---|---|---|
| [changelog-gen](tools/changelog-gen) | Turns commit messages into Keep a Changelog entries, with per-tool tags and paths for monorepos. | CLI | Windows, macOS, Linux | Beta (0.1.0) |
| [claude-code-hooks](tools/claude-code-hooks) | Claude Code hooks that block reading secret files, writing secrets and destructive shell commands, and auto-format edits. Includes an installer. | Hooks | Windows, macOS, Linux | Beta (0.1.0) |
| [commit-guard](tools/commit-guard) | Pre-commit hook and CLI that blocks secrets, personal paths, `.env` files and oversized files. | CLI, git hook | Windows, macOS, Linux | Beta (0.1.0) |
| [db-schema-mcp](tools/db-schema-mcp) | Read-only schema inspection and guarded SELECT queries for PostgreSQL and MySQL. | MCP server | Windows, macOS, Linux | Beta (0.1.0) |
| [dev-context-mcp](tools/dev-context-mcp) | Gives AI coding assistants a token-capped toolset for searching, reading and editing code, git, quality checks and the web. | MCP server | Windows, macOS, Linux | Stable (3.1.0) |
| [env-check](tools/env-check) | Finds env vars your code reads that `.env.example` does not document, and stale ones it does. | CLI | Windows, macOS, Linux | Beta (0.1.0) |
| [git-history-mcp](tools/git-history-mcp) | Answers "why is this code like this?" from git history: file history, grouped blame, line origin, churn. | MCP server | Windows, macOS, Linux | Beta (0.1.0) |
| [repo-pack](tools/repo-pack) | Bundles chosen project files into one prompt-ready Markdown or XML file within a token budget. | CLI | Windows, macOS, Linux | Beta (0.1.0) |
| [test-report-mcp](tools/test-report-mcp) | Runs your tests and returns only the failures: names, file:line, message and a trimmed stack. | MCP server | Windows, macOS, Linux | Beta (0.1.0) |
| [token-count](tools/token-count) | Estimates the token cost of files and folders, or counts exactly with the Anthropic API. | CLI | Windows, macOS, Linux | Beta (0.1.0) |

<!--
Add new tools above this comment, one row each, in alphabetical order.
Status values: Experimental, Beta, Stable, Deprecated.
-->

---

## Quick start

Every tool installs on its own. Clone the repo once, then follow the README of the tool you want:

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/<tool-name>
```

For example, [dev-context-mcp](tools/dev-context-mcp#install) is `npm install` and one command to register it with your assistant.

---

## What belongs here

Tools that make developers faster, especially when working with AI assistants:

- **MCP servers** that give assistants better context for fewer tokens
- **CLIs** for repetitive developer chores
- **Automation** such as CI helpers, hooks and scripts
- **Configs and templates** that are worth sharing

Every tool follows the same rules:

- **Works on Windows, macOS and Linux**, or clearly says which platforms it supports.
- **Installs in a few commands**, documented in its own README.
- **Stands alone.** No tool depends on another tool's folder.
- **Contains no secrets, personal data or machine-specific paths.**

---

## Repository layout

```
toolshed/
├── tools/                  one folder per tool
│   └── dev-context-mcp/
│       ├── README.md       install, usage, configuration
│       ├── CHANGELOG.md    version history
│       └── ...             source, tests, package manifest
├── docs/                   guides shared across tools
├── .github/                CI workflows and issue templates
├── CONTRIBUTING.md
├── SECURITY.md
└── LICENSE
```

---

## Guides

| Guide | Covers |
|---|---|
| [Adding a tool](docs/adding-a-tool.md) | Folder layout, README template, CI workflow and release tags for a new tool. |
| [Using MCP servers](docs/using-mcp-servers.md) | What MCP is and how to register a server with common AI coding assistants. |
| [Branching and releases](docs/releasing.md) | Protected `main`, issue-first pull requests, versioning, changelogs and how to release a tool. |

---

## Releases

Tools are versioned independently with [Semantic Versioning](https://semver.org). Releases are tagged per tool:

```
dev-context-mcp@3.1.0
```

Each tool's `CHANGELOG.md` lists what changed in every version, and every tag gets a GitHub release with those notes. `main` is protected and always releasable; see [Branching and releases](docs/releasing.md) for the full process.

---

## Roadmap

Ideas under consideration. Open an issue to suggest one or to vote with a reaction.

- [ ] Publish the tools to npm for one-line `npx` installs
- [ ] First tagged releases (`<tool>@0.1.0`) once CI is green on every OS
- [ ] More tools: open a feature request with the "New tool" option

---

## Contributing

Bug reports, ideas and pull requests are welcome. Read the [contributing guide](CONTRIBUTING.md) first; it covers setup, commit style and how to add a tool.

To report a security problem, follow the [security policy](SECURITY.md) instead of opening a public issue.

---

## License

[MIT](LICENSE). Use, modify and share these tools freely.
