# claude-code-hooks

A pack of safety and quality hooks for [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), plus an installer that wires them into Claude Code's `settings.json`.

- **Runs on:** Windows, macOS and Linux
- **Requires:** Node.js 20 or newer (no runtime dependencies)
- **License:** MIT

---

## Contents

- [Why](#why)
- [Install](#install)
- [Usage](#usage)
- [The hooks](#the-hooks)
- [Options](#options)
- [Configuration](#configuration)
- [Exit codes](#exit-codes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Why

Claude Code can read files, edit code and run shell commands. Hooks let you put deterministic checks in front of those actions, so a mistake or a prompt injection cannot quietly read your `.env`, write a token into source, or run `git push --force` to main.

- Every hook is a small standalone Node script that reads the hook JSON on stdin and answers with the documented decision output.
- Hooks never crash the session: bad input or an internal error allows the call and prints a note to stderr.
- The installer merges into your existing settings, backs the file up first, and removes only what it added.

---

## Install

You need **Node.js 20+** and **git**.

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/claude-code-hooks
npm install
```

The tool has no runtime dependencies. `npm install` only fetches the TypeScript checker used by `npm run typecheck`.

Optional: put the `claude-code-hooks` command on your PATH.

```bash
npm install -g .
```

Without a global install, run the CLI by path:

```bash
node /abs/path/to/toolshed/tools/claude-code-hooks/src/cli.js install
```

The hook commands written into `settings.json` always use the absolute path of the scripts in this folder, so keep the folder where it is after installing. If you move it, run `install` again and the paths are updated in place.

---

## Usage

Install all four hooks for the current project (writes `.claude/settings.json`):

```bash
claude-code-hooks install
```

Install for your user account, or only some hooks, or into the git-ignored local file:

```bash
claude-code-hooks install --scope user
claude-code-hooks install --hooks protect-files,block-secrets
claude-code-hooks install --scope local --project-dir /abs/path/to/project
```

See what is installed in each scope:

```bash
claude-code-hooks status
claude-code-hooks status --scope user --json
```

Remove only the entries this tool added:

```bash
claude-code-hooks uninstall --scope project
```

Try a hook with a sample payload (exit code 0 for allow, 1 for deny or ask):

```bash
cat > sample.json <<'EOF'
{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}
EOF
claude-code-hooks test guard-bash --input sample.json
```

Output:

```
hook: guard-bash
decision: deny
reason: [claude-code-hooks:guard-bash] Blocked destructive command: force push to main or master rewrites shared history.
```

This is the entry the installer adds (shown for one hook):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node \"/abs/path/to/claude-code-hooks/src/hooks/guard-bash.js\"" }]
      }
    ]
  }
}
```

---

## The hooks

| Hook | Event and matcher | What it does |
|---|---|---|
| `protect-files` | PreToolUse, `Read\|Edit\|Write\|MultiEdit\|Bash` | Denies reading or writing `.env` and `.env.*` (not `.env.example`, `.env.sample`, `.env.template`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*` (not `.pub`), `credentials.json`, `.aws/credentials` and anything under `.ssh/`. `.npmrc` and `.pypirc` can be read but not written. For Bash it inspects commands such as `cat`, `cp`, `mv`, `rm`, `sed -i`, `source` and redirections (`> .env`), including chained commands and `bash -c` strings. |
| `block-secrets` | PreToolUse, `Edit\|Write\|MultiEdit` | Denies edits whose new content contains AWS keys, GitHub tokens, private key blocks, Slack tokens, live Stripe keys, Anthropic and OpenAI keys, Google API keys, JWTs, or `api_key`, `secret`, `token` and `password` assignments with real-looking values. Placeholders and variable references are ignored. The reason shows masked values only. |
| `guard-bash` | PreToolUse, `Bash` | Denies `rm -rf` of root, home or system directories, `mkfs`, `dd of=/dev/...`, fork bombs, `chmod -R 777 /`, and force pushes to main or master. Asks before `git reset --hard`, `git clean -f`, other force pushes (including `--force-with-lease`), `curl ... \| sh`, `npm publish`, `docker push`, `rm -rf *`, and SQL `DROP DATABASE` or `DROP TABLE` in database clients. |
| `auto-format` | PostToolUse, `Edit\|Write\|MultiEdit` | Formats the edited file with the project's own tools: local prettier (js, ts, json, css, md, yaml) when the project declares it, `ruff format` or `black` for Python, `gofmt -w`, `rustfmt`. Never installs anything, never blocks, 20 second timeout. |

`guard-bash` splits chained commands (`&&`, `||`, `;`, pipes, newlines), respects quotes, and also checks `$(...)`, backticks, `bash -c "..."` and `eval` strings. The most severe finding wins: deny over ask over allow.

---

## Options

### `claude-code-hooks install | uninstall | status | test`

| Option | Applies to | Meaning |
|---|---|---|
| `--scope user\|project\|local` | install, uninstall, status | Settings file to use. `user` is `~/.claude/settings.json`, `project` is `<project>/.claude/settings.json` (default), `local` is `<project>/.claude/settings.local.json`. `status` shows all scopes when omitted. |
| `--hooks a,b,c` | install, uninstall | Comma separated hook names. Default: all four. |
| `--project-dir <dir>` | install, uninstall, status | Project folder for `project` and `local` scope. Default: the current folder. |
| `--json` | status | Machine readable output. |
| `--input <file>` | test | JSON payload file to feed the hook on stdin. |
| `-h`, `--help` / `-v`, `--version` | all | Help and version. |

Install is idempotent: running it twice adds nothing and does not touch the file. When it does change an existing file it first copies it to `settings.json.bak-<timestamp>` next to it. Other settings and other hooks are preserved.

---

## Configuration

Hook options live in `.claude/hooks.config.json` in the project, and optionally in `~/.claude/hooks.config.json`. Arrays from both files are combined; other values from the project file win.

```json
{
  "protect-files": {
    "extra": ["secrets/**", "*.kdbx"],
    "allow": ["test/fixtures/**", ".env.test"]
  },
  "block-secrets": {
    "allow": ["test/fixtures/**"],
    "extraPatterns": [{ "name": "Internal token", "pattern": "int_[0-9a-f]{32}" }]
  },
  "guard-bash": {
    "allow": ["^npm publish --access public$"],
    "extraAsk": ["terraform apply"],
    "extraDeny": ["kubectl delete namespace prod"]
  },
  "auto-format": {
    "disable": false,
    "ignore": ["vendor/**", "*.min.js"],
    "timeoutMs": 20000
  }
}
```

| Key | Meaning |
|---|---|
| `protect-files.extra` | Extra globs to deny for read and write. |
| `protect-files.allow` | Globs that are never protected. Checked first. |
| `block-secrets.allow` | File globs that are never scanned. |
| `block-secrets.extraPatterns` | Extra regular expressions, each `{ "name", "pattern" }`. |
| `guard-bash.allow` | Regular expressions (case insensitive). A matching command no longer triggers an `ask`. It never overrides a `deny`. |
| `guard-bash.extraAsk`, `extraDeny` | Regular expressions tested against the whole command. |
| `auto-format.disable`, `ignore`, `timeoutMs` | Turn the formatter off, skip file globs, lower the timeout (maximum 20000). |

Globs are case insensitive and accept `*`, `**`, `?`, `[abc]` and `{a,b}`. A glob without `/` matches the file name; one with `/` matches any trailing run of path segments; a leading `/` or drive letter anchors it. Windows and POSIX separators both work.

To silence a single false positive from `block-secrets`, put `claude-hooks:allow` in a comment on that line.

Environment variable `CLAUDE_CODE_HOOKS_HOME` replaces the home folder for `--scope user` and the user config file. It exists mainly for tests.

### Protocol notes

The hooks follow the Claude Code hook contract: JSON on stdin with `tool_name` and `tool_input`; a decision is printed as `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"|"ask","permissionDecisionReason":"..."}}` with exit code 0; no output means allow. Verified against the public documentation at `https://code.claude.com/docs/en/hooks` for the settings layout, matcher semantics, stdin fields, decision output and exit codes. The documentation page does not describe `MultiEdit` or Write and Edit `tool_input` shapes in the part that was read, so those follow the common `file_path`, `content`, `old_string`, `new_string` and `edits` fields.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. For `test`: the hook allowed the call. |
| `1` | A failure you must act on: unreadable or invalid settings file, or (for `test`) the hook denied or asked. |
| `2` | Usage error: unknown command, option, hook or scope. |

The hook scripts themselves always exit 0 and express decisions as JSON, so a crash never blocks Claude Code.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `... is not valid JSON; fix it and try again` | The settings file has a syntax error. The installer never overwrites a file it cannot parse. Fix it, then re-run. |
| A hook seems to do nothing | Run `claude-code-hooks status`, then restart Claude Code (hooks are read at session start). Use `claude-code-hooks test <hook> --input <file>` to check the decision. |
| A legitimate command is denied by `protect-files` | Add an `allow` glob in `.claude/hooks.config.json`, or run the command yourself. |
| A test fixture is flagged by `block-secrets` | Add its path to `block-secrets.allow`, or build the value at runtime from pieces. |
| `guard-bash` asks too often | Add a regular expression to `guard-bash.allow`. Destructive denies cannot be allowed. |
| Hooks stopped working after moving the folder | Run `claude-code-hooks install` again from the new location; it updates the paths. |
| `auto-format` does nothing for a JS file | The project needs a local `node_modules/prettier` and either a prettier config or a `prettier` entry in `package.json`. Nothing is ever installed for you. |
| Paths on Windows | Commands in `settings.json` use forward slashes and are quoted, which works in both Command Prompt and Git Bash. |

Limits to know about: the Bash checks are heuristics on the command text. They do not see paths built dynamically (for example `cat $(echo .env)`), and they are a safety net, not a sandbox.

---

## Development

```bash
npm install
npm test
npm run typecheck
npm run coverage
```

Tests build their own temp folders and never touch the real `~/.claude`. Secret-looking test values are assembled at runtime so no source file contains one.
