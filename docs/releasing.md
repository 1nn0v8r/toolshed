# Branching and releases

How changes reach `main` and how tools are released. The rules below are enforced by GitHub rulesets and CI, not just convention.

## The short version

1. **Issue first.** Every change starts with an issue.
2. **Branch and pull request.** Nothing is pushed to `main` directly, by anyone.
3. **Checks pass, then squash merge.** One commit per pull request lands on `main`.
4. **Release by tag.** Each tool is released on its own with a tag like `repo-pack@0.2.0`.

## Branching: trunk-based

`main` is the only long-lived branch and is always releasable. There is no `dev` or `release` branch.

Work happens on short-lived branches cut from `main`:

| Prefix | Use for |
|---|---|
| `feat/` | New tools or features |
| `fix/` | Bug fixes |
| `docs/` | Documentation only |
| `chore/` | CI, dependencies, repo maintenance |
| `release/` | Version bump pull requests |

Keep branches small and merge them within days, not weeks.

## What protects `main`

The `main` ruleset applies to everyone, including the repo owner:

- **No direct pushes:** every change goes through a pull request.
- **No force pushes or deletion** of `main`.
- **Required checks** must pass before merging:
  - `linked-issue`: the pull request links an issue (`Closes #12` or `Refs #12` in the description).
  - `changelog`: tools whose `src/` or `package.json` changed also update their `CHANGELOG.md` (label `skip-changelog` for invisible changes).
  - `commit-guard`: no secrets, personal paths, `.env` files or typography characters anywhere in the repo.
  - `gitleaks`: no secrets in git history.
- **Branch must be up to date** with `main` before merging.
- **Conversations resolved:** all review comments must be resolved.
- **Squash merge only,** so `main` reads as one commit per pull request.

Each tool's own CI (typecheck and tests on Windows, macOS and Linux) runs whenever its folder changes. Do not merge with a red tool CI run, even though path-filtered checks cannot be marked as required.

## Pull request titles

The pull request title becomes the squash commit subject on `main`, and [changelog-gen](../tools/changelog-gen) reads those subjects. Use the same style as commits:

```
repo-pack: add --line-numbers option
Add issue templates
```

## Versioning

Each tool has its own [Semantic Versioning](https://semver.org) version in its `package.json`.

| Change | Before 1.0.0 | From 1.0.0 |
|---|---|---|
| Breaking change (removed option, changed output format, new required setting) | minor (`0.3.0` to `0.4.0`) | major (`1.4.0` to `2.0.0`) |
| New feature, backwards compatible | minor or patch | minor (`1.4.0` to `1.5.0`) |
| Bug fix | patch (`0.3.0` to `0.3.1`) | patch (`1.4.0` to `1.4.1`) |

A tool moves to `1.0.0` once its options and output are stable and it has been used for real for a while. Mark it **Stable** in the root README at that point.

## Changelogs

Every user-visible change adds a line to the tool's `CHANGELOG.md` under `## Unreleased` in the same pull request:

```markdown
## Unreleased

### Fixed
- Exit code is now 2 for unknown options.
```

Sections: `Added`, `Changed`, `Fixed`, `Removed`, `Documentation`, `Breaking`. [changelog-gen](../tools/changelog-gen) can draft entries from commits.

## Releasing a tool

1. **Open an issue** titled `Release <tool> <version>`.
2. **Open a release pull request** from a `release/<tool>-<version>` branch that:
   - sets `"version"` in `tools/<tool>/package.json` (and runs `npm install` so the lockfile matches),
   - renames `## Unreleased` in its `CHANGELOG.md` to `## <version> - YYYY-MM-DD`.
3. **Squash merge** it once checks pass.
4. **Tag `main`** at the merge commit and push the tag:

   ```bash
   git switch main && git pull
   git tag <tool>@<version>
   git push origin <tool>@<version>
   ```

5. The [release workflow](../.github/workflows/release.yml) checks that the tag, `package.json` and `CHANGELOG.md` agree, then creates the GitHub release with the changelog section as notes. If it fails, fix the mismatch in a new pull request and tag again with a new version (release tags cannot be moved or deleted).

## Hotfixes

There are no release branches to patch. Fix the bug on `main` through a normal pull request, then release a patch version. Only the latest version of each tool is supported.

## When to release

Release when there is something worth shipping. Security fixes are released as soon as they are merged. There is no fixed schedule.

## Adding collaborators later

The ruleset needs 0 approving reviews today because a solo maintainer cannot approve their own pull requests. When other maintainers join, raise **Required approvals** to 1 in the `main` ruleset and consider a `CODEOWNERS` file so each tool has a named reviewer.
