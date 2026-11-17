# Adding a tool

Follow these steps to add a new tool to toolshed. Open a `new-tool` issue first so the scope is agreed before you build.

## 1. Create the folder

Use a short, lowercase, hyphenated name that says what the tool does:

```
tools/<tool-name>/
├── README.md        required
├── CHANGELOG.md     required
├── .env.example     only if the tool reads settings from the environment
├── src/             source code
├── test/            tests (or a smoke-test script)
└── package.json     or pyproject.toml, Cargo.toml, go.mod: whatever the language uses
```

The tool must install and run from its own folder, with no imports from other tools.

## 2. Write the README

Copy this outline and fill in every section:

```markdown
# <tool-name>

One sentence on what it does and who it is for.

- **Runs on:** Windows, macOS, Linux
- **Requires:** runtime and version
- **License:** MIT

## Install
## Usage
## Configuration
## Troubleshooting
## Development
```

Rules:

- Show install commands that work on every supported OS. When they differ, give one block per OS.
- Use placeholders such as `/abs/path/to/...` for paths. Never a real user's path.
- Keep the README about using the tool. Design notes go in `docs/` if they are needed at all.

## 3. Start the changelog

```markdown
# Changelog

All notable changes to <tool-name>. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.0 - YYYY-MM-DD

First release.
```

Start at `0.1.0` while the tool is experimental and move to `1.0.0` once its interface is stable.

## 4. Add CI

Copy `.github/workflows/ci-dev-context-mcp.yml` to `.github/workflows/ci-<tool-name>.yml` and change:

- the `name`
- both `paths` filters to `tools/<tool-name>/**` and the workflow file itself
- `working-directory` to `tools/<tool-name>`
- the setup, install and test steps for the tool's language

Keep the operating system matrix (`ubuntu-latest`, `windows-latest`, `macos-latest`) unless the tool is single-platform.

## 5. List it in the root README

Add one row to the **Tools** table in the [root README](../README.md), in alphabetical order, with its type, platforms and status (`Experimental`, `Beta`, `Stable` or `Deprecated`).

## 6. Release

When the tool is ready, tag the release from `main` with the tool name and version:

```bash
git tag <tool-name>@0.1.0
git push origin <tool-name>@0.1.0
```

Then create a GitHub release from the tag and paste the changelog entry as its notes.

## Checklist

- [ ] Works on every platform the README claims
- [ ] No secrets, personal data or machine-specific paths (the secret scan in CI must pass)
- [ ] README has install, usage, configuration, troubleshooting and development sections
- [ ] CHANGELOG.md exists
- [ ] CI workflow added and passing
- [ ] Row added to the root README
