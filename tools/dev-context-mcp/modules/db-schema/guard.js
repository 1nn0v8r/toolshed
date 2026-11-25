// @ts-check
// Static SQL guard for run_select. This is the first of three layers (the others
// are a READ ONLY transaction and the row cap). It tokenizes the statement so
// that keywords inside string literals, quoted identifiers, dollar-quoted
// strings and comments are ignored, then applies an allow-list for the first
// keyword and a deny-list for everything else.

/** @typedef {"postgres" | "mysql"} DbKind */
/** @typedef {{ type: "word" | "ident" | "string" | "punct" | "other", value: string, start: number, end: number }} Token */

const MAX_SQL_LENGTH = 100000;

const ALLOWED_FIRST = new Set(["SELECT", "WITH", "SHOW", "EXPLAIN"]);
const ALLOWED_FIRST_PG = new Set(["TABLE", "VALUES"]);

const FORBIDDEN_KEYWORDS = new Set([
  "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "DROP", "ALTER", "CREATE",
  "TRUNCATE", "GRANT", "REVOKE", "COPY", "CALL", "DO", "LOCK", "VACUUM", "SET",
  "RESET", "INTO", "LOAD", "HANDLER",
]);

const FORBIDDEN_FUNCTIONS = new Set([
  "pg_terminate_backend", "pg_cancel_backend", "set_config", "nextval", "setval",
  "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_stat_file",
  "pg_reload_conf", "pg_rotate_logfile", "pg_switch_wal", "pg_create_restore_point",
  "get_lock", "release_lock", "release_all_locks", "load_file",
]);

const FORBIDDEN_FUNCTION_PREFIXES = [
  "lo_", "dblink", "pg_advisory", "pg_try_advisory", "pg_logical_", "pg_replication_",
  "pg_ls_",
];

/**
 * @param {string} sql
 * @param {DbKind} kind
 * @returns {{ tokens: Token[] } | { error: string }}
 */
export function tokenize(sql, kind) {
  const pg = kind === "postgres";
  /** @type {Token[]} */
  const tokens = [];
  const n = sql.length;
  let i = 0;

  /** @param {Token["type"]} type @param {number} start @param {number} end */
  const push = (type, start, end) => {
    tokens.push({ type, value: sql.slice(start, end), start, end });
  };

  while (i < n) {
    const c = sql[i];

    if (/\s/.test(c)) {
      i++;
      continue;
    }

    // Line comments.
    if (c === "-" && sql[i + 1] === "-") {
      // MySQL only treats "--" as a comment when followed by whitespace or a control char.
      const after = sql[i + 2];
      if (pg || after === undefined || /[\s\x00-\x1f]/.test(after)) {
        const nl = sql.indexOf("\n", i);
        i = nl === -1 ? n : nl + 1;
        continue;
      }
    }
    if (c === "#" && !pg) {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }

    // Block comments.
    if (c === "/" && sql[i + 1] === "*") {
      if (!pg && (sql[i + 2] === "!" || (sql[i + 2] === "M" && sql[i + 3] === "!"))) {
        return { error: "MySQL executable comments (/*! ... */) are not allowed" };
      }
      if (pg) {
        let depth = 1;
        let j = i + 2;
        while (j < n && depth > 0) {
          if (sql[j] === "/" && sql[j + 1] === "*") {
            depth++;
            j += 2;
          } else if (sql[j] === "*" && sql[j + 1] === "/") {
            depth--;
            j += 2;
          } else {
            j++;
          }
        }
        if (depth > 0) return { error: "unterminated block comment" };
        i = j;
      } else {
        const close = sql.indexOf("*/", i + 2);
        if (close === -1) return { error: "unterminated block comment" };
        i = close + 2;
      }
      continue;
    }

    // Single-quoted strings.
    if (c === "'") {
      const prev = tokens[tokens.length - 1];
      const escapeString = !pg || (prev !== undefined && prev.type === "word" && prev.end === i && prev.value.toLowerCase() === "e");
      const end = scanQuoted(sql, i, "'", escapeString);
      if (end === -1) return { error: "unterminated string literal" };
      push("string", i, end);
      i = end;
      continue;
    }

    // Double quotes: identifier in PostgreSQL, string in MySQL.
    if (c === '"') {
      const end = scanQuoted(sql, i, '"', !pg);
      if (end === -1) return { error: pg ? "unterminated quoted identifier" : "unterminated string literal" };
      push(pg ? "ident" : "string", i, end);
      i = end;
      continue;
    }

    // Backticks: MySQL identifiers.
    if (c === "`" && !pg) {
      const end = scanQuoted(sql, i, "`", false);
      if (end === -1) return { error: "unterminated quoted identifier" };
      push("ident", i, end);
      i = end;
      continue;
    }

    // Dollar quoting (PostgreSQL only). "$1" parameters do not match the tag pattern.
    if (c === "$" && pg) {
      const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i, i + 200));
      if (m) {
        const delim = m[0];
        const close = sql.indexOf(delim, i + delim.length);
        if (close === -1) return { error: "unterminated dollar-quoted string" };
        push("string", i, close + delim.length);
        i = close + delim.length;
        continue;
      }
    }

    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j])) j++;
      push("word", i, j);
      i = j;
      continue;
    }

    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j])) j++;
      push("other", i, j);
      i = j;
      continue;
    }

    push("punct", i, i + 1);
    i++;
  }

  return { tokens };
}

/**
 * Returns the index just past the closing quote, or -1 when unterminated.
 * @param {string} sql
 * @param {number} start index of the opening quote
 * @param {string} quote
 * @param {boolean} backslash whether backslash escapes the next character
 */
function scanQuoted(sql, start, quote, backslash) {
  const n = sql.length;
  let j = start + 1;
  while (j < n) {
    const ch = sql[j];
    if (backslash && ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === quote) {
      if (sql[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return -1;
}

/**
 * @param {string} name lower-cased function name
 */
function isForbiddenFunction(name) {
  if (FORBIDDEN_FUNCTIONS.has(name)) return true;
  return FORBIDDEN_FUNCTION_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Check that a statement is a single, read-only query.
 * @param {unknown} sql
 * @param {DbKind} kind
 * @returns {{ ok: true, sql: string } | { ok: false, reason: string }}
 */
export function checkSql(sql, kind) {
  if (typeof sql !== "string" || sql.trim() === "") return { ok: false, reason: "SQL is empty" };
  if (sql.length > MAX_SQL_LENGTH) return { ok: false, reason: `SQL is longer than ${MAX_SQL_LENGTH} characters` };
  if (sql.includes("\0")) return { ok: false, reason: "SQL contains a NUL character" };

  const tok = tokenize(sql, kind);
  if ("error" in tok) return { ok: false, reason: tok.error };
  const tokens = tok.tokens;

  // Drop trailing semicolons; any other semicolon means more than one statement.
  let end = tokens.length;
  while (end > 0 && tokens[end - 1].type === "punct" && tokens[end - 1].value === ";") end--;
  const body = tokens.slice(0, end);
  if (body.length === 0) return { ok: false, reason: "SQL has no statement (only comments or semicolons)" };
  if (body.some((t) => t.type === "punct" && t.value === ";")) {
    return { ok: false, reason: "exactly one statement is allowed (found a semicolon between statements)" };
  }

  let k = 0;
  while (k < body.length && body[k].type === "punct" && body[k].value === "(") k++;
  const first = body[k];
  if (!first || first.type !== "word") {
    return { ok: false, reason: "statement must start with SELECT, WITH, SHOW or EXPLAIN" };
  }
  const firstWord = first.value.toUpperCase();
  const allowed = ALLOWED_FIRST.has(firstWord) || (kind === "postgres" && ALLOWED_FIRST_PG.has(firstWord));
  if (!allowed) {
    const list = kind === "postgres" ? "SELECT, WITH, SHOW, EXPLAIN, TABLE or VALUES" : "SELECT, WITH, SHOW or EXPLAIN";
    return { ok: false, reason: `statement must start with ${list} (got ${firstWord})` };
  }

  for (let idx = 0; idx < body.length; idx++) {
    const t = body[idx];
    const prev = body[idx - 1];
    if (t.type === "word") {
      const upper = t.value.toUpperCase();
      const afterDot = prev !== undefined && prev.type === "punct" && prev.value === ".";
      if (!afterDot && FORBIDDEN_KEYWORDS.has(upper)) {
        // "SHOW CREATE TABLE ..." is read-only and useful.
        const showCreate = upper === "CREATE" && prev !== undefined && prev.type === "word" && prev.value.toUpperCase() === "SHOW";
        if (!showCreate) {
          return { ok: false, reason: `keyword ${upper} is not allowed in read-only queries` };
        }
      }
      if (firstWord === "EXPLAIN" && (upper === "ANALYZE" || upper === "ANALYSE")) {
        return { ok: false, reason: "EXPLAIN ANALYZE executes the statement and is not allowed" };
      }
      if (isForbiddenFunction(t.value.toLowerCase())) {
        return { ok: false, reason: `function ${t.value} is not allowed` };
      }
    } else if (t.type === "ident") {
      const name = t.value.slice(1, -1).toLowerCase();
      if (isForbiddenFunction(name)) return { ok: false, reason: `function ${name} is not allowed` };
    }
  }

  return { ok: true, sql: sql.slice(0, body[body.length - 1].end) };
}

/** Thrown when the guard rejects a statement. */
export class GuardError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(`Query rejected: ${reason}`);
    this.name = "GuardError";
  }
}

/**
 * @param {unknown} sql
 * @param {DbKind} kind
 * @returns {string} the statement without trailing semicolons
 */
export function assertReadOnlySql(sql, kind) {
  const r = checkSql(sql, kind);
  if (!r.ok) throw new GuardError(r.reason);
  return r.sql;
}
