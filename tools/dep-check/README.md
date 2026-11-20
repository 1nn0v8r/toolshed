# dep-check

A fast, zero-dependency CLI that scans JavaScript and TypeScript codebases for unused, missing, and misplaced dependencies.

- **Runs on:** Windows, macOS and Linux
- **Requires:** Node.js 20 or newer (git is optional, used to respect `.gitignore`)
- **License:** MIT

---

## Contents

- [Why](#why)
- [Install](#install)
- [Usage](#usage)
- [Options](#options)
- [Configuration](#configuration)
- [What it detects](#what-it-detects)
- [Exit codes](#exit-codes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Why

Dependencies drift over time. Packages get installed during development and left behind in `dependencies` when no longer used, bloating Docker images and install times. Conversely, packages get imported without being added to `package.json`, which works locally because of lockfile hoisting or global caches but breaks clean `npm ci` builds in CI or production.

`dep-check` scans your actual import and require statements, compares them against `package.json`, and highlights missing, unused, and misplaced packages instantly without needing network access or heavy toolchains.

---

## Install

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/dep-check
npm install
```

Run it directly with Node.js:

```bash
node /abs/path/to/toolshed/tools/dep-check/src/cli.js /abs/path/to/your/project
```

Or install the `dep-check` binary globally on your system:

```bash
npm install -g .
dep-check --help
```

---

## Usage

```bash
# Check current directory
dep-check

# Check a specific project directory
dep-check /abs/path/to/project

# Fail CI if missing or unused dependencies are found
dep-check --fail-on-unused --fail-on-missing

# Enforce strict policy (fails on missing, unused, and misplaced dependencies)
dep-check --strict

# Ignore specific packages or tools
dep-check --ignore typescript,@types/*

# Output JSON for CI reporting or scripts
dep-check --json
```

---

## Options

| Option | What it does | Default |
|---|---|---|
| `--path <dir>` | Directory to scan | Current working directory |
| `--package-json <file>` | Path to `package.json` | `<dir>/package.json` |
| `--ignore <pkg>` | Package name or glob pattern to ignore (repeatable) | `[]` |
| `--ignore-dev` | Skip checking `devDependencies` for unused packages | `false` |
| `--fail-on-unused` | Exit with code 1 if any unused dependencies are found | `false` |
| `--fail-on-missing` | Exit with code 1 if any missing dependencies are found | `true` |
| `--fail-on-misplaced` | Exit with code 1 if any misplaced dependencies are found | `false` |
| `--strict` | Enables `--fail-on-unused`, `--fail-on-missing`, and `--fail-on-misplaced` | `false` |
| `--json` | Output findings in JSON format | `false` |
| `-h, --help` | Show usage instructions | |
| `-v, --version` | Show tool version | |

---

## Configuration

You can place configuration in a `.depcheckrc.json` file in your project root, or under a `"dep-check"` key in `package.json`:

```json
{
  "ignore": [
    "typescript",
    "@types/*",
    "eslint"
  ],
  "ignoreDev": false,
  "failOnUnused": false,
  "failOnMissing": true,
  "failOnMisplaced": false,
  "paths": [
    "src",
    "test"
  ]
}
```

CLI flags override settings defined in configuration files.

---

## What it detects

`dep-check` categorizes issues into distinct groups:

1. **Missing dependencies:** Packages imported in source code that do not appear in `dependencies`, `devDependencies`, `peerDependencies`, or `optionalDependencies`.
2. **Unused dependencies:** Packages declared in `dependencies` that are never imported anywhere in the project.
3. **Unused devDependencies:** Packages declared in `devDependencies` that are never imported in any source, test, or configuration file (unless ignored).
4. **Misplaced devDependencies:** Packages declared in `devDependencies` that are imported in production files (`src/`, `lib/`), which causes runtime errors when deployed with `npm install --omit=dev`.
5. **Dependencies only used in dev:** Packages declared in `dependencies` that are only ever imported in test files or build scripts, which can be safely moved to `devDependencies`.

### Supported Import Syntax

- ES module imports: `import x from 'pkg'`, `import 'pkg'`, `import { a } from 'pkg/subpath'`
- Type imports: `import type { T } from 'pkg'`
- Re-exports: `export * from 'pkg'`, `export { x } from 'pkg'`
- CommonJS: `require('pkg')`, `require.resolve('pkg')`
- Dynamic imports: `import('pkg')`, `await import('pkg')`
- Test mocks: `jest.mock('pkg')`, `vi.mock('pkg')`

Single-line (`//`) and multi-line (`/* */`) comments are stripped before analysis, ensuring commented code does not count as usage.

---

## Exit codes

| Exit code | Meaning |
|---|---|
| `0` | Clean, or issues found did not violate any `--fail-*` or `--strict` thresholds. |
| `1` | One or more dependency violations occurred under active failure rules. |
| `2` | Usage error, missing `package.json`, or invalid configuration file. |

---

## Troubleshooting

### "package.json not found"

Make sure you run `dep-check` from the root of your Node.js project or pass `--path /abs/path/to/project`.

### Build tools flagged as unused

Tools like `typescript`, `eslint`, and `prettier` are typically executed via CLI commands rather than imported in source code. Add them to `--ignore` or list them in `.depcheckrc.json`.

---

## Development

Run tests and type checking:

```bash
npm test
npm run typecheck
```
