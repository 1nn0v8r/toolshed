# Contributing

Thanks for helping improve toolshed. This guide covers how to report issues, make changes and add new tools.

## Reporting bugs and ideas

- **Bugs:** open an issue with the bug report template. Include your OS, runtime version and the exact steps to reproduce.
- **Ideas and new tools:** open an issue with the feature request template before writing a lot of code, so we can agree on scope first.
- **Security problems:** do not open a public issue. See [SECURITY.md](SECURITY.md).

## Making a change

`main` is protected: nobody, maintainers included, can push to it directly. Every change goes through an issue and a pull request. The full rules and the release process are in [docs/releasing.md](docs/releasing.md).

1. **Open an issue** (or comment on an existing one) describing the bug or change.
2. Fork the repo and create a branch from `main`, named after the change: `fix/dev-context-mcp-shell`, `feat/new-tool-name`, `docs/install-guide`. Install the repo's pre-commit hook once, so secrets, personal paths and typography characters are caught before they are committed: `node tools/commit-guard/src/cli.js install`.
3. Work inside the tool's folder and follow its README's **Development** section.
4. Run the tool's typecheck and tests before you push.
5. Update the tool's `CHANGELOG.md` under an **Unreleased** heading.
6. Open a pull request against `main`, put `Closes #<issue>` in the description and fill in the template. The required `linked-issue` and `changelog` checks fail without them.
7. Once all checks pass, the pull request is squash merged (or rebase merged when each commit stands on its own).

Keep each pull request focused on one tool and one change. Small pull requests get reviewed faster.

## Commit messages

Prefix the subject with the tool name, or leave it off for repo-wide changes:

```
dev-context-mcp: keep test summaries when clipping long output
Add issue templates
```

- Use the imperative mood ("Add", "Fix", "Remove"), with no trailing period.
- Keep the subject under about 72 characters.
- Explain *why* in the body when it is not obvious.

## Rules for every tool

- **Cross-platform.** Works on Windows, macOS and Linux, or its README states the supported platforms. Do not hardcode shells, path separators or home directories.
- **No secrets or personal data.** Never commit API keys, tokens, `.env` files, personal names, email addresses or machine-specific paths such as `C:\Users\...` or `/home/...`. Use placeholders like `/abs/path/to/...` in docs and `.env.example` for settings.
- **Self-contained.** A tool must not import from another tool's folder. Shared ideas go in `docs/`, not shared code.
- **Documented.** The README explains what the tool does, how to install it, how to configure it and how to troubleshoot it.
- **Plain punctuation.** Use commas, colons or parentheses instead of em dashes, and avoid ellipsis characters in docs and UI text.

## Adding a new tool

See [docs/adding-a-tool.md](docs/adding-a-tool.md) for the folder layout, README checklist, CI workflow and release tags.

## Code of conduct

Be respectful and constructive. Assume good intent, critique code rather than people, and help newcomers. Maintainers may remove comments or contributors that do not follow this.
