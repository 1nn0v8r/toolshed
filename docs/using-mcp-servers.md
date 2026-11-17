# Using MCP servers

The [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is an open standard that lets AI assistants call external tools. An MCP server exposes tools, such as "search this repo" or "read these files", and the assistant decides when to call them.

This guide explains how to register any stdio MCP server, such as [dev-context-mcp](../tools/dev-context-mcp), with common assistants. Each tool's README gives its exact command.

## How a stdio server runs

Your assistant starts the server as a child process and talks to it over standard input and output. You only tell it **which command to run**, for example:

```
node /abs/path/to/server.js
```

Tips that apply to every client:

- **Use absolute paths.** The client may start the server from any directory.
- **On Windows, write paths with forward slashes** (`C:/code/toolshed/...`) or escaped backslashes (`C:\\code\\...`) inside JSON.
- **Prefer `node <file>` over global commands.** On Windows, global npm commands are `.cmd` shims that some clients cannot start directly. If you must use one, wrap it as `cmd /c <command>`.
- **Restart or reconnect** the server after changing its config or rebuilding it.

## Register a server

### Claude Code

```bash
claude mcp add <name> --scope user -- node /abs/path/to/server.js
claude mcp list
```

`--scope user` makes the server available in every project. Use `--scope project` to share it with a repo through a committed `.mcp.json`.

### Claude Desktop

Edit `claude_desktop_config.json` (**macOS:** `~/Library/Application Support/Claude/`, **Windows:** `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "<name>": {
      "command": "node",
      "args": ["/abs/path/to/server.js"],
      "env": {}
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` for all projects, or `.cursor/mcp.json` for one:

```json
{
  "mcpServers": {
    "<name>": { "command": "node", "args": ["/abs/path/to/server.js"] }
  }
}
```

### VS Code

`.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "<name>": { "type": "stdio", "command": "node", "args": ["/abs/path/to/server.js"] }
  }
}
```

### Other clients

Most clients accept the same shape: a name, a command, arguments and optional environment variables. Check the client's MCP documentation for where its config file lives.

## Remote (HTTP) servers

Some servers, including dev-context-mcp, can also run over HTTP for containers or shared machines. The client then needs a URL and usually an `Authorization: Bearer <token>` header instead of a command. Only expose such servers beyond localhost behind TLS.

## Troubleshooting

| Problem | Fix |
|---|---|
| Server shows as failed | Run the exact command in a terminal. It should start and wait silently, or log a startup line to stderr. Fix any error it prints. |
| Server works in a terminal but not in the client | The client may use a different `PATH`. Use the absolute path to `node` (find it with `which node` on macOS/Linux or `where node` on Windows). |
| Tools act on the wrong folder | The client started the server outside your project. Set the server's root option (for dev-context-mcp, `REPO_ROOT`). |
| Assistant ignores the server's tools | Add a short rule to your assistant's instructions telling it to prefer those tools. |
