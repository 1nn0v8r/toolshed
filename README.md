# toolshed

Open source developer tools for faster, leaner, AI-assisted coding.

Each tool lives in its own folder under [`tools/`](tools), with its own install guide, changelog and version. Use one tool or all of them.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Tools

| Tool | What it does | Type | Platforms | Status |
|---|---|---|---|---|
| [dev-context-mcp](tools/dev-context-mcp) | Gives AI coding assistants a token-capped toolset for searching, reading and editing code, git, quality checks and the web. | MCP server | Windows, macOS, Linux | Stable (3.1.0) |

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

---

## Releases

Tools are versioned independently with [Semantic Versioning](https://semver.org). Releases are tagged per tool:

```
dev-context-mcp@3.1.0
```

Each tool's `CHANGELOG.md` lists what changed in every version.

---

## Roadmap

Ideas under consideration. Open an issue to suggest one or to vote with a reaction.

- [ ] Publish dev-context-mcp to npm for one-line `npx` installs
- [ ] More tools (see [issues labelled `new-tool`](https://github.com/1nn0v8r/toolshed/issues?q=label%3Anew-tool))

---

## Contributing

Bug reports, ideas and pull requests are welcome. Read the [contributing guide](CONTRIBUTING.md) first; it covers setup, commit style and how to add a tool.

To report a security problem, follow the [security policy](SECURITY.md) instead of opening a public issue.

---

## License

[MIT](LICENSE). Use, modify and share these tools freely.
