// @ts-check

/**
 * @typedef {object} DiffLine
 * @property {"add"|"del"|"ctx"} type
 * @property {number|null} oldLine
 * @property {number|null} newLine
 * @property {string} text
 */

/**
 * @typedef {object} DiffHunk
 * @property {number} oldStart
 * @property {number} oldCount
 * @property {number} newStart
 * @property {number} newCount
 * @property {string} headerContext
 * @property {string} rawHeader
 * @property {DiffLine[]} lines
 */

/**
 * @typedef {object} ParsedFileDiff
 * @property {string} path
 * @property {string|null} oldPath
 * @property {"added"|"deleted"|"modified"|"renamed"|"copied"} status
 * @property {boolean} binary
 * @property {number} additions
 * @property {number} deletions
 * @property {DiffHunk[]} hunks
 * @property {string} rawChunk
 */

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Strip git diff a/ or b/ prefixes and surrounding quotes if present.
 *
 * @param {string} rawPath
 * @returns {string}
 */
function cleanGitPath(rawPath) {
  let p = rawPath.trim();
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (p.startsWith("a/") || p.startsWith("b/")) {
    return p.slice(2);
  }
  return p;
}

/**
 * Parse a `diff --git ...` header line to extract fallback a/b paths.
 *
 * @param {string} line
 * @returns {{ aPath: string, bPath: string }}
 */
function parseDiffGitHeader(line) {
  const rest = line.slice("diff --git ".length);
  const quotedMatch = rest.match(/^"a\/(.+?)"\s+"b\/(.+?)"$/);
  if (quotedMatch) {
    return { aPath: quotedMatch[1], bPath: quotedMatch[2] };
  }
  const simpleMatch = rest.match(/^a\/(.+?)\s+b\/(.+?)$/);
  if (simpleMatch) {
    return { aPath: simpleMatch[1], bPath: simpleMatch[2] };
  }
  const parts = rest.split(/\s+/);
  return {
    aPath: cleanGitPath(parts[0] ?? ""),
    bPath: cleanGitPath(parts[1] ?? parts[0] ?? "")
  };
}

/**
 * Parse unified diff text into structured file and hunk objects.
 * Supports standard `git diff` output as well as plain `---`/`+++` unified diffs.
 *
 * @param {string} diffText
 * @returns {ParsedFileDiff[]}
 */
export function parseUnifiedDiff(diffText) {
  if (!diffText || !diffText.trim()) return [];

  const lines = diffText.replace(/\r\n/g, "\n").split("\n");
  /** @type {ParsedFileDiff[]} */
  const files = [];
  /** @type {ParsedFileDiff|null} */
  let currentFile = null;
  /** @type {DiffHunk|null} */
  let currentHunk = null;
  /** @type {string[]} */
  let currentRawLines = [];
  let oldLineCursor = 0;
  let newLineCursor = 0;

  const flushFile = () => {
    if (!currentFile) return;
    currentFile.rawChunk = currentRawLines.join("\n");
    files.push(currentFile);
    currentFile = null;
    currentHunk = null;
    currentRawLines = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      flushFile();
      const { aPath, bPath } = parseDiffGitHeader(line);
      currentFile = {
        path: bPath,
        oldPath: aPath !== bPath ? aPath : null,
        status: "modified",
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
        rawChunk: ""
      };
      currentRawLines = [line];
      continue;
    }

    // Support plain unified diffs without a `diff --git` header
    if (!currentFile && line.startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
      const aPath = line.slice(4).trim() === "/dev/null" ? null : cleanGitPath(line.slice(4).split("\t")[0]);
      const nextLine = lines[i + 1];
      const bPath = nextLine.slice(4).trim() === "/dev/null" ? null : cleanGitPath(nextLine.slice(4).split("\t")[0]);
      currentFile = {
        path: bPath ?? aPath ?? "unknown",
        oldPath: aPath && bPath && aPath !== bPath ? aPath : null,
        status: aPath === null ? "added" : bPath === null ? "deleted" : "modified",
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
        rawChunk: ""
      };
      currentRawLines = [line];
      continue;
    }

    if (!currentFile) continue;
    currentRawLines.push(line);

    if (!currentHunk) {
      if (line.startsWith("new file mode ")) {
        currentFile.status = "added";
        continue;
      }
      if (line.startsWith("deleted file mode ")) {
        currentFile.status = "deleted";
        continue;
      }
      if (line.startsWith("rename from ")) {
        currentFile.status = "renamed";
        currentFile.oldPath = line.slice("rename from ".length).trim();
        continue;
      }
      if (line.startsWith("rename to ")) {
        currentFile.status = "renamed";
        currentFile.path = line.slice("rename to ".length).trim();
        continue;
      }
      if (line.startsWith("copy from ")) {
        currentFile.status = "copied";
        currentFile.oldPath = line.slice("copy from ".length).trim();
        continue;
      }
      if (line.startsWith("copy to ")) {
        currentFile.status = "copied";
        currentFile.path = line.slice("copy to ".length).trim();
        continue;
      }
      if (line === "GIT binary patch" || (line.startsWith("Binary files ") && line.endsWith(" differ"))) {
        currentFile.binary = true;
        continue;
      }
      if (line.startsWith("--- ")) {
        const rawOld = line.slice(4).split("\t")[0].trim();
        if (rawOld === "/dev/null") {
          currentFile.status = "added";
        }
        continue;
      }
      if (line.startsWith("+++ ")) {
        const rawNew = line.slice(4).split("\t")[0].trim();
        if (rawNew === "/dev/null") {
          currentFile.status = "deleted";
        } else {
          currentFile.path = cleanGitPath(rawNew);
        }
        continue;
      }
    }

    const hunkMatch = line.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      const oldStart = Number(hunkMatch[1]);
      const oldCount = hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1;
      const newStart = Number(hunkMatch[3]);
      const newCount = hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1;
      currentHunk = {
        oldStart,
        oldCount,
        newStart,
        newCount,
        headerContext: (hunkMatch[5] ?? "").trim(),
        rawHeader: line,
        lines: []
      };
      currentFile.hunks.push(currentHunk);
      oldLineCursor = oldStart;
      newLineCursor = newStart;
      continue;
    }

    if (currentHunk) {
      if (line.startsWith("+")) {
        currentHunk.lines.push({
          type: "add",
          oldLine: null,
          newLine: newLineCursor,
          text: line.slice(1)
        });
        currentFile.additions += 1;
        newLineCursor += 1;
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({
          type: "del",
          oldLine: oldLineCursor,
          newLine: null,
          text: line.slice(1)
        });
        currentFile.deletions += 1;
        oldLineCursor += 1;
      } else if (line.startsWith(" ")) {
        currentHunk.lines.push({
          type: "ctx",
          oldLine: oldLineCursor,
          newLine: newLineCursor,
          text: line.slice(1)
        });
        oldLineCursor += 1;
        newLineCursor += 1;
      } else if (line.startsWith("\\ No newline at end of file")) {
        // Ignore git's no-newline marker without breaking the hunk
      } else {
        // Non-diff trailing lines outside hunk
        currentHunk = null;
      }
    }
  }

  flushFile();
  return files;
}
