# changelog-gen

A command line tool that turns git commit messages into Keep a Changelog entries, and works in monorepos where each tool has its own tags and `CHANGELOG.md`.

- **Runs on:** Windows, macOS and Linux
- **Requires:** Node.js 20 or newer, and git on your PATH
- **License:** AGPL-3.0-only

## Contents

- [Why](#why)
- [Install](#install)
- [Usage](#usage)
- [Options](#options)
- [How commits are classified](#how-commits-are-classified)
- [Configuration](#configuration)
- [Exit codes](#exit-codes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Why

Writing release notes by hand is slow, and most generators assume one tag stream per repository. `changelog-gen` reads the commits since the latest tag that matches a prefix (for example `repo-pack@`), optionally limited to one folder, and prints or writes a ready to paste section. It understands both Conventional Commits and the `tool-name: Subject` style, and it has no dependencies.

## Install

You need Node.js 20+ and git.

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/changelog-gen
npm install
```

Optionally put `changelog-gen` on your PATH:

```bash
npm install -g .
```

Or run it directly without installing globally:

```bash
node /abs/path/to/toolshed/tools/changelog-gen/src/cli.js --help
```

## Usage

Run it inside the git repository you want a changelog for.

```bash
# Everything since the latest v* tag, printed to stdout
changelog-gen

# One tool in a monorepo, tags like repo-pack@0.1.0
changelog-gen --tag-prefix "repo-pack@" --path tools/repo-pack --version-label 0.2.0

# Insert the section into the tool's changelog (replaces an Unreleased section)
changelog-gen --tag-prefix "repo-pack@" --path tools/repo-pack --version-label 0.2.0 \
  --write tools/repo-pack/CHANGELOG.md

# Explicit range, without hashes, as JSON
changelog-gen --from v1.0.0 --to HEAD --no-hash --json
```

Example output:

```markdown
## 0.2.0 - 2026-03-04

### Added

- Add shiny option (a1b2c3d)

### Fixed

- Fix crash on empty input (d4e5f6a)

### Breaking

- Drop the old API: config key renamed (0a1b2c3)
```

## Options

| Option | Default | Description |
|---|---|---|
| `--tag-prefix <p>` | `v` | Start after the latest tag starting with `<p>` that is reachable from the end of the range. With no such tag, the whole history is used. |
| `--from <ref>` | | Start after this ref. Overrides the tag lookup. |
| `--to <ref>` | `HEAD` | End at this ref. |
| `--path <dir>` | | Only commits touching `<dir>`. Its folder name is also used to strip a `name:` subject prefix. |
| `--scope <name>` | | Also strip a `name:` subject prefix or a `(name)` Conventional Commits scope. |
| `--include-merges` | off | Keep merge commits (skipped by default). |
| `--all` | off | Also list `chore`, `test`, `ci`, `build` and `style` commits (under Changed). |
| `--version-label <v>` | `Unreleased` | Label in the `## <label> - <date>` heading. |
| `--date <YYYY-MM-DD>` | today, UTC | Date in the heading. |
| `--no-hash` | | Omit short commit hashes. |
| `--write <file>` | | Insert the section into a changelog file instead of printing it. A missing file is created. |
| `--json` | | Print machine readable JSON (includes the rendered markdown). |
| `-h`, `--help` | | Show help. |
| `-V`, `--cli-version` | | Print the version of changelog-gen itself (`--version-label` is the release label, so `--version` is not used). |

Both `--option value` and `--option=value` work.

## How commits are classified

Conventional Commits (`type(scope)!: subject`, type is case-insensitive):

| Type | Section |
|---|---|
| `feat` | Added |
| `fix` | Fixed |
| `perf`, `refactor` | Changed |
| `docs` | Documentation |
| `revert` | Removed |
| `chore`, `test`, `ci`, `build`, `style` | hidden unless `--all` |

A `!` after the type or a `BREAKING CHANGE:` (or `BREAKING-CHANGE:`) footer also lists the commit under `### Breaking`, with the footer text when there is one. A breaking commit is never hidden, even for `chore`. A scope is shown in bold before the subject, unless it equals the `--path` folder name or `--scope`.

The `tool-name: Subject` style: the prefix is stripped when it matches the `--path` folder name or `--scope`. The first word then decides the section: Add, Create, Introduce (Added); Fix, Correct, Repair (Fixed); Remove, Drop, Delete (Removed); anything else is Changed. The same rule applies to plain subjects without a prefix. Common inflections (Adds, Added, Fixed, and so on) are recognised.

Trailers such as `Co-Authored-By:` and `Signed-off-by:` are removed from commit bodies and never appear in the output.

Sections are printed in a fixed order (Added, Changed, Fixed, Removed, Documentation, Breaking) and empty ones are left out. Within a section, newest commits come first.

### Writing to a file

With `--write`, the new section goes after the title and intro and before the first `## ` heading. If the new label is `Unreleased` and the file has an `## Unreleased` section (also `## [Unreleased]`), that section is replaced instead, so the command is safe to re-run. The rest of the file is preserved byte for byte, and CRLF files stay CRLF.

## Configuration

There are no config files or environment variables. Everything is set with the options above. `git` is resolved from your PATH.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | No commits in the range (or only hidden ones). A message on stderr says which. Nothing is written. |
| 2 | Usage error, unknown ref, not a git repository, git missing, or the file could not be written |

## Troubleshooting

| Problem | Fix |
|---|---|
| `no commits in range v1.0.0..HEAD` | Nothing new since the tag. Check `--tag-prefix`, or pass `--from`. |
| Output lists the whole history | No tag matches the prefix. Tags must start with the prefix, for example `repo-pack@0.1.0` for `--tag-prefix "repo-pack@"`. |
| `no changelog entries ... use --all` | The commits in range are all `chore`, `test`, `ci`, `build` or `style`. Add `--all`. |
| Subjects still show `tool-name:` | Pass `--path` with the tool folder, or `--scope tool-name`. |
| Commits from other tools appear | Add `--path <dir>`. |
| `not a git repository` | Run it from inside the repository. |
| `git was not found on PATH` | Install git or fix your PATH. |
| A tag on `HEAD` gives exit 1 | The range is empty. Use `--from` with the previous tag to regenerate notes for a release. |

## Development

```bash
npm install
npm test
npm run typecheck
npm run coverage
```
