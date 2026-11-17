# db-schema-mcp

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI assistant inspect a PostgreSQL or MySQL schema and run safe SELECT queries, with compact output.

- **Runs on:** Windows, macOS and Linux (Node.js 20 or newer)
- **Requires:** a PostgreSQL 12+ or MySQL 8+ database you can reach with a connection URL
- **License:** MIT

---

## Contents

- [Why](#why)
- [Install](#install)
- [Connect your assistant](#connect-your-assistant)
- [Usage](#usage)
- [Tools](#tools)
- [Configuration](#configuration)
- [How read-only is enforced](#how-read-only-is-enforced)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Why

Assistants guess column names and join keys when they cannot see the schema, and a raw database shell is too much power. This server gives them just enough:

- **Schema first.** Tables, columns, keys, foreign keys in both directions and indexes, in a few lines each.
- **Compact output.** Aligned text tables (TSV when wide), hard row caps, values truncated at 200 characters.
- **Safe by construction.** Only one read-only statement at a time, run inside a read-only transaction that is always rolled back, with a timeout.
- **No leaked secrets.** Credentials are redacted from every error, and secret-looking columns are masked in `sample_rows`.

---

## Install

You need **Node.js 20+**.

```bash
git clone https://github.com/1nn0v8r/toolshed.git
cd toolshed/tools/db-schema-mcp
npm install
```

The entry point you register with a client is:

```
node /abs/path/to/toolshed/tools/db-schema-mcp/src/server.js
```

Optionally install a global command (puts `db-schema-mcp` on your `PATH`):

```bash
npm install -g .
```

There is no build step.

---

## Connect your assistant

Replace `/abs/path/to/src/server.js` with the real path and the URL with your own. **Use a database user that only has SELECT rights**; see [How read-only is enforced](#how-read-only-is-enforced).

### Claude Code

```bash
claude mcp add db-schema --scope user --env DATABASE_URL=postgres://readonly_user:password@localhost:5432/mydb -- node /abs/path/to/src/server.js
```

Check it with `claude mcp list`.

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "db-schema": {
      "command": "node",
      "args": ["/abs/path/to/src/server.js"],
      "env": { "DATABASE_URL": "postgres://readonly_user:password@localhost:5432/mydb" }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "db-schema": {
      "command": "node",
      "args": ["/abs/path/to/src/server.js"],
      "env": { "DATABASE_URL": "mysql://readonly_user:password@localhost:3306/mydb" }
    }
  }
}
```

### VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "db-schema": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/src/server.js"],
      "env": { "DATABASE_URL": "postgres://readonly_user:password@localhost:5432/mydb" }
    }
  }
}
```

### Any other MCP client

Run `node /abs/path/to/src/server.js` as a stdio server with `DATABASE_URL` set.

---

## Usage

Once connected, ask things like:

- "List the tables and tell me which ones look like they hold orders."
- "Describe the `orders` table and what references it."
- "Show how all tables relate."
- "Show 5 sample rows from `users`." (password and token columns come back as `[redacted]`)
- "How many orders per customer in the last 30 days?" (the assistant calls `run_select`)

Example `run_select` output:

```
name   n
-----  --
alice  60
bob    60
(2 rows)
```

When the cap is hit the footer says so: `(10 rows, truncated at maxRows=10; more rows exist)`.

---

## Tools

| Tool | Arguments | What it returns |
|---|---|---|
| `list_tables` | none | Tables and views with estimated row counts and comments. |
| `describe_table` | `table` | Columns (name, type, nullable, default, comment), primary key, foreign keys (outgoing and incoming), unique constraints, indexes. Name matching is case-insensitive when unambiguous. |
| `list_relationships` | none | Every foreign key as `orders.customer_id -> customers.id`, with `on delete` and `on update` actions when they are not the default. |
| `sample_rows` | `table`, `limit` (default 5, max 20) | Sample rows. Values of columns whose names match `password`, `passwd`, `secret`, `token`, `api_key`, `apikey`, `hash`, `salt`, `ssn`, `card`, `cvv`, `iban`, `otp` or `private` are shown as `[redacted]` (NULL stays NULL). Values longer than 200 characters are truncated. |
| `run_select` | `sql`, `maxRows` (default `DB_MAX_ROWS`, max 500) | Result as an aligned table (TSV when wide) with the row count and a truncation notice. |
| `connection_info` | none | Database kind, server version, database, schema and whether queries run read-only. Never includes credentials. |

---

## Configuration

All configuration is through environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | `postgres://` or `postgresql://` or `mysql://` URL. Query-string options such as `sslmode=require` are passed to the driver. |
| `DB_SCHEMA` | `public` | PostgreSQL schema to inspect. Unqualified names in `run_select` resolve in this schema. MySQL ignores it and uses the database in the URL. |
| `DB_MAX_ROWS` | `50` | Default row cap for `run_select`. Values above 500 are lowered to the hard maximum of 500. |
| `DB_STATEMENT_TIMEOUT_MS` | `10000` | Statement timeout in milliseconds. |

If `DATABASE_URL` is missing or invalid the server prints a message (without the URL) and exits with code 2. The database is contacted lazily on the first tool call, so the tool list is available even when the database is down.

---

## How read-only is enforced

`run_select` has three layers, all required:

1. **Static guard.** A small tokenizer skips string literals, quoted identifiers, dollar-quoted strings (PostgreSQL) and comments, with the quoting and comment rules of the target database. Then it requires exactly one statement starting with `SELECT`, `WITH`, `SHOW`, `EXPLAIN` (without `ANALYZE`) or, on PostgreSQL, `TABLE` or `VALUES`. Any `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `UPSERT`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `GRANT`, `REVOKE`, `COPY`, `CALL`, `DO`, `LOCK`, `VACUUM`, `SET`, `RESET`, `INTO`, `LOAD` or `HANDLER` keyword outside strings and comments is rejected (`SHOW CREATE TABLE` is allowed). So are functions such as `pg_terminate_backend`, `pg_cancel_backend`, `lo_*`, `dblink*`, `set_config`, `pg_advisory_*`, `pg_read_file`, `nextval`, `load_file` and `get_lock`, and MySQL executable comments (`/*! ... */`). Keywords are matched as whole words, so a column called `update` must be quoted or qualified (`t.update`).
2. **Read-only transaction.** PostgreSQL: `BEGIN READ ONLY` plus `SET LOCAL statement_timeout`. MySQL: `SET SESSION MAX_EXECUTION_TIME`, `SET SESSION transaction_read_only = 1` and `START TRANSACTION READ ONLY`. The transaction is always rolled back. The MySQL session flag matters: without it DDL such as `CREATE TABLE` implicitly commits and escapes the read-only transaction (verified against MySQL 8.4 while building this tool).
3. **Row cap.** At most `maxRows + 1` rows are fetched, via a cursor on PostgreSQL and a stream on MySQL, so a huge table cannot flood the assistant.

The catalog queries behind `list_tables`, `describe_table` and the other tools use layers 2 and 3 as well.

These layers are defense in depth, not a replacement for permissions. **Connect with a database user that has only SELECT rights**, ideally on a replica. The guard is conservative and may reject some harmless queries (for example the MySQL string function `INSERT(...)`); rewrite them or use a different tool.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Server exits immediately with code 2 | `DATABASE_URL` missing, not a `postgres://`, `postgresql://` or `mysql://` URL, or `DB_MAX_ROWS` / `DB_STATEMENT_TIMEOUT_MS` is not a positive integer. The message on stderr names the problem. |
| Every tool returns `ECONNREFUSED` or a timeout | The database is not reachable from the machine running the server. Check host, port, firewall and VPN. |
| `password authentication failed` | Wrong credentials. Special characters in the password must be percent-encoded in the URL (for example `@` as `%40`). |
| `table not found` | The table is not in `DB_SCHEMA` (PostgreSQL) or the database from the URL (MySQL). The error lists available names. |
| `Query rejected: keyword X is not allowed` | The guard found a write keyword. If it is a column or alias name, quote it. |
| `canceling statement due to statement timeout` | Raise `DB_STATEMENT_TIMEOUT_MS` or make the query cheaper. |
| `sample_rows` shows `[redacted]` | The column name looks secret-like. This is intentional. |
| TLS errors | Add the driver option to the URL, for example `?sslmode=require` (PostgreSQL) or `?ssl={"rejectUnauthorized":true}` (MySQL, URL-encoded). |

---

## Development

```bash
npm install
npm test            # unit tests, plus integration tests when the URLs below are set
npm run typecheck   # tsc with checkJs
npm run coverage    # node --test with line coverage
```

### Integration tests with Docker

The integration tests create their own fixture (`customers`, `orders` with a foreign key, `users` with a `password_hash` column, a view), call every tool through a real MCP `Client` over stdio, prove that a write which bypasses the guard still fails inside the read-only transaction, and clean up after themselves. They run only when the matching variable is set; otherwise each suite is skipped with a message naming the variable.

Start throwaway containers (change the host ports if they are taken; on Windows some ports are reserved by the OS and Docker will refuse to bind them):

```bash
docker run -d --rm --name dbschema-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:17
docker run -d --rm --name dbschema-mysql -e MYSQL_ROOT_PASSWORD=test -e MYSQL_DATABASE=test -p 127.0.0.1:53306:3306 mysql:8.4
```

Wait until both accept connections:

```bash
until docker exec dbschema-pg pg_isready -U postgres; do sleep 1; done
until docker exec dbschema-mysql mysqladmin ping -ptest --silent; do sleep 1; done
```

MySQL restarts once during its first initialization, so if the second command succeeds immediately, wait a few more seconds and run it again. Then run the suite:

```bash
TEST_PG_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
TEST_MYSQL_URL=mysql://root:test@127.0.0.1:53306/test \
npm test
```

On PowerShell set the variables first with `$env:TEST_PG_URL = "..."` and `$env:TEST_MYSQL_URL = "..."`. Either variable can be set alone to run just one database. Clean up:

```bash
docker stop dbschema-pg dbschema-mysql
```

The PostgreSQL suite works in its own schema (`dbschema_it`) and drops it afterwards. The MySQL suite creates `customers`, `orders`, `users` and a view in the database from the URL and drops them afterwards, so use a throwaway database.
