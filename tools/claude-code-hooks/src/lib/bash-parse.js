// @ts-check

/**
 * @typedef {{
 *   words: string[],
 *   raw: string,
 *   op: string,
 *   redirects: { op: string, target: string }[],
 * }} Segment
 */

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "nohup", "time", "nice", "exec", "builtin", "ionice", "stdbuf", "timeout"]);
const WRAPPER_ARG_FLAGS = new Set(["-u", "-g", "-h", "-p", "-C", "-r", "-t", "-U", "-n", "-s", "-k"]);
const MAX_DEPTH = 4;
const ESCAPABLE = [" ", "\t", "\n", "\\", '"', "'", "$", "`", ";", "&", "|", "<", ">", "(", ")", "#", "*", "?", "!", "{", "}", "[", "]", "~"];

/**
 * Lower-case command name without directory or .exe suffix.
 * @param {string} word
 */
export function cmdName(word) {
  const base = word.replace(/\\/g, "/").split("/").pop() || "";
  return base.replace(/\.exe$/i, "").toLowerCase();
}

/**
 * Split one level of a shell command into segments. Command substitutions
 * are returned separately in `subs`.
 * @param {string} cmd
 * @returns {{ segments: Segment[], subs: string[] }}
 */
export function splitLevel(cmd) {
  /** @type {Segment[]} */
  const segments = [];
  /** @type {string[]} */
  const subs = [];
  /** @type {string[]} */
  let words = [];
  /** @type {{ op: string, target: string }[]} */
  let redirects = [];
  let cur = "";
  let has = false;
  let start = 0;
  /** @type {string | null} */
  let pendingRedirect = null;

  const flushWord = () => {
    if (!has) return;
    if (pendingRedirect !== null) {
      redirects.push({ op: pendingRedirect, target: cur });
      pendingRedirect = null;
    } else {
      words.push(cur);
    }
    cur = "";
    has = false;
  };
  /** @param {string} op @param {number} end */
  const endSegment = (op, end) => {
    flushWord();
    if (words.length > 0 || redirects.length > 0) {
      segments.push({ words, raw: cmd.slice(start, end).trim(), op, redirects });
    } else if (segments.length > 0 && op && !segments[segments.length - 1].op) {
      segments[segments.length - 1].op = op;
    }
    words = [];
    redirects = [];
    pendingRedirect = null;
  };

  let i = 0;
  const n = cmd.length;
  while (i < n) {
    const c = cmd[i];
    if (c === "\\") {
      // Only escape characters the shell treats specially, so Windows paths
      // such as C:proj.env keep their backslashes.
      const nx = cmd[i + 1];
      if (nx !== undefined && ESCAPABLE.includes(nx)) {
        cur += nx;
        i += 2;
      } else {
        cur += c;
        i++;
      }
      has = true;
      continue;
    }
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      const stop = end === -1 ? n : end;
      cur += cmd.slice(i + 1, stop);
      has = true;
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      has = true;
      i++;
      while (i < n && cmd[i] !== '"') {
        if (cmd[i] === "\\" && i + 1 < n) {
          const nx = cmd[i + 1];
          cur += nx === '"' || nx === "\\" || nx === "$" || nx === "`" ? nx : "\\" + nx;
          i += 2;
          continue;
        }
        if (cmd[i] === "$" && cmd[i + 1] === "(") {
          const close = findClose(cmd, i + 1);
          subs.push(cmd.slice(i + 2, close));
          cur += cmd.slice(i, close + 1);
          i = close + 1;
          continue;
        }
        if (cmd[i] === "`") {
          const close = cmd.indexOf("`", i + 1);
          const stop = close === -1 ? n : close;
          subs.push(cmd.slice(i + 1, stop));
          cur += cmd.slice(i, stop + 1);
          i = stop + 1;
          continue;
        }
        cur += cmd[i];
        i++;
      }
      i++;
      continue;
    }
    if (c === "$" && cmd[i + 1] === "(") {
      const close = findClose(cmd, i + 1);
      subs.push(cmd.slice(i + 2, close));
      cur += cmd.slice(i, close + 1);
      has = true;
      i = close + 1;
      continue;
    }
    if (c === "`") {
      const close = cmd.indexOf("`", i + 1);
      const stop = close === -1 ? n : close;
      subs.push(cmd.slice(i + 1, stop));
      cur += cmd.slice(i, stop + 1);
      has = true;
      i = stop + 1;
      continue;
    }
    if (c === "<" && cmd[i + 1] === "(") {
      const close = findClose(cmd, i + 1);
      subs.push(cmd.slice(i + 2, close));
      cur += cmd.slice(i, close + 1);
      has = true;
      i = close + 1;
      continue;
    }
    if (c === " " || c === "\t") {
      flushWord();
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      const op = c === "\r" && cmd[i + 1] === "\n" ? "\r\n" : c;
      endSegment("\n", i);
      i += op.length;
      start = i;
      continue;
    }
    if (c === ";") {
      endSegment(";", i);
      i++;
      start = i;
      continue;
    }
    if (c === "&" || c === "|") {
      const prev = cmd[i - 1];
      if (c === "&" && cmd[i + 1] === ">") {
        flushWord();
        let op = "&>";
        i += 2;
        if (cmd[i] === ">") {
          op = "&>>";
          i++;
        }
        pendingRedirect = op;
        continue;
      }
      if (c === "&" && prev === ">") {
        i++;
        continue;
      }
      let op = c;
      if (cmd[i + 1] === c && c === "&") op = "&&";
      else if (cmd[i + 1] === c && c === "|") op = "||";
      else if (c === "|" && cmd[i + 1] === "&") op = "|&";
      endSegment(op, i);
      i += op.length;
      start = i;
      continue;
    }
    if (c === ">" || c === "<") {
      // a bare file-descriptor number before the operator is not a word
      if (has && /^\d+$/.test(cur) && pendingRedirect === null) {
        cur = "";
        has = false;
      } else {
        flushWord();
      }
      let op = c;
      i++;
      while (i < n && (cmd[i] === c || cmd[i] === "&" || cmd[i] === "|")) {
        op += cmd[i];
        i++;
      }
      pendingRedirect = op;
      continue;
    }
    cur += c;
    has = true;
    i++;
  }
  endSegment("", n);
  // drop redirect targets that are only file descriptors
  for (const s of segments) {
    s.redirects = s.redirects.filter((r) => !/^(?:\d+|-)$/.test(r.target) && r.target !== "");
  }
  return { segments, subs };
}

/**
 * Index of the ")" matching the "(" at `open`.
 * @param {string} s
 * @param {number} open
 */
function findClose(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return s.length;
}

/**
 * Remove leading env assignments and wrapper commands (sudo, env, ...).
 * @param {string[]} words
 * @returns {string[]}
 */
export function unwrap(words) {
  let w = words.slice();
  for (let guard = 0; guard < 8 && w.length > 0; guard++) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) {
      w = w.slice(1);
      continue;
    }
    const name = cmdName(w[0]);
    if (!WRAPPERS.has(name)) break;
    w = w.slice(1);
    while (w.length > 0 && w[0].startsWith("-")) {
      const takesArg = (name === "sudo" || name === "doas") && WRAPPER_ARG_FLAGS.has(w[0]);
      w = w.slice(takesArg ? 2 : 1);
    }
    if (name === "timeout" && w.length > 0 && /^\d/.test(w[0])) w = w.slice(1);
    if (name === "nice" && w.length > 0 && /^-?\d+$/.test(w[0])) w = w.slice(1);
  }
  return w;
}

/**
 * Strings passed to a shell via -c, or to eval.
 * @param {string[]} words unwrapped words
 * @returns {string[]}
 */
function inlineScripts(words) {
  if (words.length === 0) return [];
  const name = cmdName(words[0]);
  if (name === "eval") return [words.slice(1).join(" ")];
  if (!SHELLS.has(name)) return [];
  const out = [];
  for (let i = 1; i < words.length; i++) {
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(words[i]) && words[i + 1] !== undefined) {
      out.push(words[i + 1]);
      break;
    }
  }
  return out;
}

/**
 * Parse a command into a list of levels. Each level is a list of segments
 * whose `op` fields describe adjacency (for pipelines). Substitutions and
 * `bash -c` strings become further levels.
 * @param {string} cmd
 * @param {number} [depth]
 * @returns {Segment[][]}
 */
export function parseCommand(cmd, depth = 0) {
  /** @type {Segment[][]} */
  const levels = [];
  if (depth > MAX_DEPTH || typeof cmd !== "string") return levels;
  const { segments, subs } = splitLevel(cmd);
  levels.push(segments);
  for (const sub of subs) levels.push(...parseCommand(sub, depth + 1));
  for (const seg of segments) {
    for (const script of inlineScripts(unwrap(seg.words))) {
      levels.push(...parseCommand(script, depth + 1));
    }
  }
  return levels;
}
