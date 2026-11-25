// @ts-check
// Pure parsers and formatters for git output. No I/O here.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * Replace anything that looks like an email address.
 * @param {string} text
 * @returns {string}
 */
export function redactEmails(text) {
  return text.replace(EMAIL_RE, "[email hidden]");
}

/**
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
export function clipText(s, max) {
  return s.length > max ? s.slice(0, Math.max(0, max - 3)) + "..." : s;
}

/**
 * Keep at most `max` lines; report how many were dropped.
 * @param {string[]} lines
 * @param {number} max
 * @returns {{ lines: string[], dropped: number }}
 */
export function clipLines(lines, max) {
  if (lines.length <= max) return { lines, dropped: 0 };
  return { lines: lines.slice(0, max), dropped: lines.length - max };
}

/**
 * Split text into lines accepting both LF and CRLF.
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  return text.split(/\r?\n/);
}

/**
 * Unix seconds to YYYY-MM-DD (UTC).
 * @param {number} secs
 * @returns {string}
 */
export function isoDate(secs) {
  return new Date(secs * 1000).toISOString().slice(0, 10);
}

/**
 * @typedef {{ added: number, deleted: number, binary: boolean, path: string }} NumstatEntry
 */

/**
 * Parse `git ... --numstat` lines (tab separated).
 * @param {string[]} lines
 * @returns {NumstatEntry[]}
 */
export function parseNumstatLines(lines) {
  /** @type {NumstatEntry[]} */
  const out = [];
  for (const line of lines) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const binary = m[1] === "-" || m[2] === "-";
    out.push({
      added: binary ? 0 : Number(m[1]),
      deleted: binary ? 0 : Number(m[2]),
      binary,
      path: m[3],
    });
  }
  return out;
}

/**
 * @typedef {{ sha: string, date: string, author: string, subject: string, added: number, deleted: number }} FileCommit
 */

/**
 * Parse `git log --numstat --format=%x00%H%x01%ad%x01%an%x01%s`.
 * @param {string} stdout
 * @returns {FileCommit[]}
 */
export function parseFileHistory(stdout) {
  /** @type {FileCommit[]} */
  const commits = [];
  for (const block of stdout.split("\0")) {
    if (!block.trim()) continue;
    const lines = splitLines(block);
    const [sha, date, author, ...subj] = lines[0].split("\x01");
    if (!sha) continue;
    const stats = parseNumstatLines(lines.slice(1));
    commits.push({
      sha: sha.trim().slice(0, 7),
      date: date ?? "",
      author: author ?? "",
      subject: subj.join("\x01"),
      added: stats.reduce((n, s) => n + s.added, 0),
      deleted: stats.reduce((n, s) => n + s.deleted, 0),
    });
  }
  return commits;
}

/**
 * @typedef {{ sha: string, author: string, date: string, subject: string, uncommitted: boolean }} BlameInfo
 * @typedef {{ start: number, end: number, info: BlameInfo, code: string[] }} BlameGroup
 */

/**
 * Parse `git blame --porcelain` and group consecutive lines by commit.
 * @param {string} stdout
 * @returns {BlameGroup[]}
 */
export function parseBlamePorcelain(stdout) {
  /** @type {Map<string, BlameInfo>} */
  const infos = new Map();
  /** @type {BlameGroup[]} */
  const groups = [];
  /** @type {BlameInfo | null} */
  let current = null;
  let finalLine = 0;
  const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;
  for (const raw of splitLines(stdout)) {
    const line = raw;
    if (line.startsWith("\t")) {
      if (!current) continue;
      const last = groups[groups.length - 1];
      if (last && last.info === current && last.end === finalLine - 1) {
        last.end = finalLine;
        last.code.push(line.slice(1));
      } else {
        groups.push({ start: finalLine, end: finalLine, info: current, code: [line.slice(1)] });
      }
      continue;
    }
    const h = header.exec(line);
    if (h) {
      let info = infos.get(h[1]);
      if (!info) {
        info = {
          sha: h[1].slice(0, 7),
          author: "",
          date: "",
          subject: "",
          uncommitted: /^0+$/.test(h[1]),
        };
        infos.set(h[1], info);
      }
      current = info;
      finalLine = Number(h[2]);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("author ")) current.author = line.slice(7);
    else if (line.startsWith("author-time ")) current.date = isoDate(Number(line.slice(12)));
    else if (line.startsWith("summary ")) current.subject = line.slice(8);
  }
  return groups;
}

/**
 * @typedef {{ header: string, patch: string[] }} LineLogEntry
 */

/**
 * Parse `git log -L` output formatted with a leading NUL and a header line.
 * Diff metadata lines are dropped; hunks are kept.
 * @param {string} stdout
 * @returns {LineLogEntry[]}
 */
export function parseLineLog(stdout) {
  /** @type {LineLogEntry[]} */
  const out = [];
  for (const block of stdout.split("\0")) {
    if (!block.trim()) continue;
    const lines = splitLines(block);
    const header = lines[0];
    const patch = lines
      .slice(1)
      .filter((l) => !/^(diff --git |index [0-9a-f]|--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(l))
      .filter((l, i, arr) => !(l === "" && (i === 0 || i === arr.length - 1)));
    while (patch.length && patch[patch.length - 1] === "") patch.pop();
    out.push({ header, patch });
  }
  return out;
}

/**
 * @typedef {{ path: string, commits: number, lines: number }} ChurnRow
 */

/**
 * Parse `git log --numstat --no-renames --format=%x00`.
 * @param {string} stdout
 * @returns {ChurnRow[]} sorted by commits, then lines, then path
 */
export function parseChurn(stdout) {
  /** @type {Map<string, ChurnRow>} */
  const map = new Map();
  for (const block of stdout.split("\0")) {
    if (!block.trim()) continue;
    const seen = new Set();
    for (const e of parseNumstatLines(splitLines(block))) {
      let row = map.get(e.path);
      if (!row) {
        row = { path: e.path, commits: 0, lines: 0 };
        map.set(e.path, row);
      }
      if (!seen.has(e.path)) {
        row.commits += 1;
        seen.add(e.path);
      }
      row.lines += e.added + e.deleted;
    }
  }
  return [...map.values()].sort(
    (a, b) => b.commits - a.commits || b.lines - a.lines || a.path.localeCompare(b.path)
  );
}

/**
 * Count authors from NUL separated names.
 * @param {string} stdout
 * @returns {{ name: string, commits: number }[]}
 */
export function parseContributors(stdout) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const raw of stdout.split("\0")) {
    const name = raw.replace(/[\r\n]/g, "").trim();
    if (!name) continue;
    map.set(name, (map.get(name) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([name, commits]) => ({ name, commits }))
    .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
}

/**
 * Parse `git log -1 --format=%H%x00%an%x00%ad%x00%P%x00%B`.
 * @param {string} stdout
 * @returns {{ sha: string, author: string, date: string, parents: string[], message: string }}
 */
export function parseCommitHeader(stdout) {
  const [sha = "", author = "", date = "", parents = "", ...rest] = stdout.split("\0");
  return {
    sha: sha.trim(),
    author,
    date,
    parents: parents.trim() ? parents.trim().split(/\s+/) : [],
    message: rest.join("\0").replace(/\r\n/g, "\n").trim(),
  };
}
