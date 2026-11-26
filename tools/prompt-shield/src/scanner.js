// @ts-check
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_IGNORE_DIRS, makeGlobMatcher } from "./config.js";
import {
  scanHiddenComments,
  scanInjectionAndExfil,
  scanUnicode,
  stripInvisibleUnicode,
} from "./rules.js";

/**
 * @typedef {import("./rules.js").Finding} Finding
 * @typedef {import("./config.js").ShieldConfig} ShieldConfig
 */

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm",
  ".sqlite", ".sqlite3", ".db", ".mp3", ".mp4", ".wav", ".mov",
]);

const COMMENT_AWARE_EXTENSIONS = new Set([
  ".md", ".mdx", ".mdc", ".html", ".htm", ".xml", ".svg", ".txt",
]);

const AI_BASENAMES = new Set([
  "agents.md",
  "claude.md",
  "gemini.md",
  "copilot.md",
  "skill.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  ".mcp.json",
  "mcp.json",
  "claude_desktop_config.json",
]);

/**
 * Normalize path separators to forward slashes.
 * @param {string} p
 * @returns {string}
 */
export function toPosix(p) {
  return p.replace(/\\/g, "/");
}

/**
 * Check if a relative path is an AI instruction, skill, rule, or MCP config surface.
 * @param {string} relPath
 * @returns {boolean}
 */
export function isAiSurface(relPath) {
  const norm = toPosix(relPath).toLowerCase();
  const base = path.posix.basename(norm);
  if (AI_BASENAMES.has(base)) return true;
  if (base.startsWith(".aider")) return true;
  if (norm === ".github/copilot-instructions.md") return true;
  if (norm.startsWith(".github/instructions/")) return true;
  if (norm.startsWith(".cursor/rules/") || norm === ".cursor/mcp.json") return true;
  if (norm === ".vscode/mcp.json") return true;
  if (norm.startsWith(".claude/") || norm.startsWith(".codex/") || norm.startsWith(".gemini/") || norm.startsWith(".roo/")) {
    return true;
  }
  if (/(?:^|\/)skills\/[^/]+\/skill\.md$/i.test(norm)) return true;
  return false;
}

/**
 * Check if a buffer appears to contain binary NUL bytes.
 * @param {Buffer} buf
 * @returns {boolean}
 */
export function isBinaryBuffer(buf) {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Walk directory and collect scannable relative file paths.
 * @param {string} rootDir
 * @param {string[]} targets
 * @param {{ ignoreFiles?: string[], aiOnly?: boolean, maxFileSizeKB?: number }} [opts]
 * @returns {{ files: string[], skippedLarge: string[] }}
 */
export function collectTargetFiles(rootDir, targets, opts = {}) {
  const matchers = (opts.ignoreFiles ?? []).map(makeGlobMatcher);
  const maxBytes = (opts.maxFileSizeKB ?? 1024) * 1024;
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const skippedLarge = [];

  /** @param {string} absPath */
  const maybeAddFile = (absPath) => {
    const rel = toPosix(path.relative(rootDir, absPath));
    if (!rel || rel.startsWith("..")) {
      // Allow explicit targets outside rootDir via absolute path label
      if (targets.length > 0) {
        const label = toPosix(absPath);
        if (!seen.has(label)) {
          seen.add(label);
          if (opts.aiOnly && !isAiSurface(label)) return;
          const st = fs.statSync(absPath);
          if (st.size > maxBytes) {
            skippedLarge.push(label);
            return;
          }
          files.push(absPath);
        }
      }
      return;
    }
    if (seen.has(rel)) return;
    if (matchers.some((m) => m(rel))) return;
    if (opts.aiOnly && !isAiSurface(rel)) return;
    const ext = path.posix.extname(rel).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return;
    const st = fs.statSync(absPath);
    if (st.size > maxBytes) {
      skippedLarge.push(rel);
      return;
    }
    seen.add(rel);
    files.push(absPath);
  };

  /** @param {string} dir */
  const walkDir = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
        const relDir = toPosix(path.relative(rootDir, full));
        if (matchers.some((m) => m(relDir) || m(relDir + "/"))) continue;
        walkDir(full);
      } else if (entry.isFile()) {
        maybeAddFile(full);
      }
    }
  };

  const roots = targets.length > 0 ? targets : ["."];
  for (const t of roots) {
    const abs = path.resolve(rootDir, t);
    if (!fs.existsSync(abs)) {
      throw new Error(`Target path does not exist: ${t}`);
    }
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      walkDir(abs);
    } else if (st.isFile()) {
      maybeAddFile(abs);
    }
  }

  return { files, skippedLarge };
}

/**
 * Scan a text payload with file-context awareness.
 * @param {string} text
 * @param {string} fileLabel
 * @param {{ strictUnicode?: boolean, allText?: boolean, aiSurface?: boolean, baseLine?: number }} [opts]
 * @returns {Finding[]}
 */
export function scanText(text, fileLabel, opts = {}) {
  /** @type {Finding[]} */
  const findings = [];
  findings.push(
    ...scanUnicode(text, fileLabel, {
      strictUnicode: opts.strictUnicode,
      baseLine: opts.baseLine,
    }),
  );

  const aiSurface = opts.aiSurface ?? (opts.allText || isAiSurface(fileLabel));
  if (aiSurface) {
    findings.push(
      ...scanInjectionAndExfil(text, fileLabel, {
        baseLine: opts.baseLine,
      }),
    );
  } else {
    const ext = path.posix.extname(toPosix(fileLabel)).toLowerCase();
    if (COMMENT_AWARE_EXTENSIONS.has(ext)) {
      findings.push(
        ...scanHiddenComments(text, fileLabel, {
          baseLine: opts.baseLine,
        }),
      );
    }
  }

  return findings;
}

/**
 * Scan a list of files on disk.
 * @param {string} rootDir
 * @param {string[]} absFiles
 * @param {{ strictUnicode?: boolean, allText?: boolean }} [opts]
 * @returns {{ scannedCount: number, findings: Finding[] }}
 */
export function scanFiles(rootDir, absFiles, opts = {}) {
  /** @type {Finding[]} */
  const findings = [];
  let scannedCount = 0;

  for (const absPath of absFiles) {
    let buf;
    try {
      buf = fs.readFileSync(absPath);
    } catch {
      continue;
    }
    if (isBinaryBuffer(buf)) continue;
    scannedCount += 1;
    const rel = toPosix(path.relative(rootDir, absPath));
    const label = rel && !rel.startsWith("..") ? rel : toPosix(absPath);
    const text = buf.toString("utf8");
    findings.push(...scanText(text, label, opts));
  }

  return { scannedCount, findings };
}

/**
 * Parse unified diff output (e.g. from `git diff --cached -U0`) and scan added lines.
 * @param {string} diffText
 * @param {{ strictUnicode?: boolean, allText?: boolean }} [opts]
 * @returns {{ scannedFiles: number, findings: Finding[] }}
 */
export function scanUnifiedDiff(diffText, opts = {}) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {Set<string>} */
  const files = new Set();
  /** @type {Map<string, Array<{ line: number, text: string }>>} */
  const addedByFile = new Map();

  let currentFile = "";
  let nextLine = 1;

  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith("+++ ")) {
      const target = rawLine.slice(4).trim();
      if (target === "/dev/null") {
        currentFile = "";
      } else {
        currentFile = target.startsWith("b/") ? target.slice(2) : target;
        files.add(currentFile);
      }
      continue;
    }
    if (rawLine.startsWith("@@ ")) {
      const m = rawLine.match(/\+(\d+)(?:,\d+)?/);
      if (m) nextLine = Number.parseInt(m[1], 10);
      continue;
    }
    if (!currentFile) continue;
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      const content = rawLine.slice(1);
      let list = addedByFile.get(currentFile);
      if (!list) {
        list = [];
        addedByFile.set(currentFile, list);
      }
      list.push({ line: nextLine, text: content });
      nextLine += 1;
    }
  }

  for (const [fileLabel, lines] of addedByFile.entries()) {
    for (const item of lines) {
      findings.push(
        ...scanText(item.text, fileLabel, {
          strictUnicode: opts.strictUnicode,
          allText: opts.allText,
          baseLine: item.line,
        }),
      );
    }
  }

  return { scannedFiles: files.size, findings };
}

/**
 * Run `git diff --cached -U0` in `cwd` and scan staged additions.
 * @param {string} cwd
 * @param {{ strictUnicode?: boolean, allText?: boolean, aiOnly?: boolean }} [opts]
 * @returns {{ scannedFiles: number, findings: Finding[] }}
 */
export function scanStagedGitDiff(cwd, opts = {}) {
  const res = spawnSync("git", ["diff", "--cached", "-U0", "--no-color", "--diff-filter=ACMR"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(`Failed to run git: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const detail = (res.stderr || "").trim() || `git exited with status ${res.status}`;
    throw new Error(detail);
  }
  const diffRes = scanUnifiedDiff(res.stdout || "", opts);
  if (opts.aiOnly) {
    diffRes.findings = diffRes.findings.filter((f) => isAiSurface(f.file));
  }
  return diffRes;
}

/**
 * Strip invisible Unicode from target files on disk.
 * @param {string} rootDir
 * @param {string[]} absFiles
 * @param {{ dryRun?: boolean, backup?: boolean, strictUnicode?: boolean }} [opts]
 * @returns {{
 *   scannedCount: number,
 *   modifiedFiles: Array<{ file: string, removedCount: number, countsByRule: Record<string, number> }>,
 *   totalRemoved: number,
 * }}
 */
export function stripFiles(rootDir, absFiles, opts = {}) {
  /** @type {Array<{ file: string, removedCount: number, countsByRule: Record<string, number> }>} */
  const modifiedFiles = [];
  let scannedCount = 0;
  let totalRemoved = 0;

  for (const absPath of absFiles) {
    let buf;
    try {
      buf = fs.readFileSync(absPath);
    } catch {
      continue;
    }
    if (isBinaryBuffer(buf)) continue;
    scannedCount += 1;

    const text = buf.toString("utf8");
    const res = stripInvisibleUnicode(text, { strictUnicode: opts.strictUnicode });
    if (res.removedCount === 0) continue;

    const rel = toPosix(path.relative(rootDir, absPath));
    const label = rel && !rel.startsWith("..") ? rel : toPosix(absPath);
    totalRemoved += res.removedCount;
    modifiedFiles.push({
      file: label,
      removedCount: res.removedCount,
      countsByRule: res.countsByRule,
    });

    if (!opts.dryRun) {
      if (opts.backup) {
        fs.writeFileSync(absPath + ".bak", buf);
      }
      fs.writeFileSync(absPath, res.cleaned, "utf8");
    }
  }

  return { scannedCount, modifiedFiles, totalRemoved };
}

/**
 * Filter findings by ignored rule IDs.
 * @param {Finding[]} findings
 * @param {ShieldConfig} config
 * @returns {Finding[]}
 */
export function filterFindings(findings, config) {
  if (config.ignoreRules.size === 0) return findings;
  return findings.filter((f) => !config.ignoreRules.has(f.ruleId));
}
