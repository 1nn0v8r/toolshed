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

For a Node.js tool, copy `.github/workflows/ci-repo-pack.yml` to `.github/workflows/ci-<tool-name>.yml` and replace `repo-pack` with your tool's folder name (in `name`, both `paths` filters and `tool:`). It calls the shared [`node-tool.yml`](../.github/workflows/node-tool.yml) workflow, which runs `npm ci`, `npm run typecheck` and `npm test` on Windows, macOS and Linux with Node 20 and 22. Your `package.json` must define the `typecheck` and `test` scripts.

Pass `os` or `node-versions` to narrow the matrix for a single-platform tool. A tool that needs services (a database, for example) can add its own job next to the shared one; see `ci-db-schema-mcp.yml`.

For another language, write a full workflow in the same shape: the same path filters, an OS matrix and the language's install, check and test steps.

## 5. List it in the root README

Add one row to the **Tools** table in the [root README](../README.md), in alphabetical order, with its type, platforms and status (`Experimental`, `Beta`, `Stable` or `Deprecated`).

## 6. Release

When the tool is ready, tag the release from `main` with the tool name and version:

```bash
git tag <tool-name>@0.1.0
git push origin <tool-name>@0.1.0
```

The [release workflow](../.github/workflows/release.yml) then checks that `package.json` has the same version and that `CHANGELOG.md` has a `## 0.1.0` section, and creates the GitHub release with that section as its notes. [changelog-gen](../tools/changelog-gen) can draft the section from your commits:

```bash
node tools/changelog-gen/src/cli.js --path tools/<tool-name> --tag-prefix "<tool-name>@" --version-label 0.1.0
```

## Checklist

- [ ] Works on every platform the README claims
- [ ] No secrets, personal data or machine-specific paths (the secret scan in CI must pass)
- [ ] README has install, usage, configuration, troubleshooting and development sections
- [ ] CHANGELOG.md exists
- [ ] CI workflow added and passing
- [ ] Row added to the root README
