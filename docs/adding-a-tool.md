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

## 4. CI testing

The repository uses a unified CI matrix in `.github/workflows/ci.yml`. Any new tool placed under `tools/<tool-name>/` is automatically detected when files in its folder change.

For a Node.js tool:
- Your `package.json` must define `typecheck` and `test` scripts.
- CI runs `npm ci`, `npm run typecheck` and `npm test` across Windows, macOS and Linux with Node 20 and 22.
- If your tool requires background services (such as a database), add a dedicated integration job to `.github/workflows/ci.yml` (see the `db-schema-mcp` integration job for an example).

For other languages, add a corresponding test job to `.github/workflows/ci.yml` following the same path-detection and OS matrix structure.

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
- [ ] Tests and typechecks pass (npm run typecheck and npm test)
- [ ] Row added to the root README
