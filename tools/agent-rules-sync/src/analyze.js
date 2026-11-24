// @ts-check
import fs from "node:fs";
import path from "node:path";
import { safeResolveInside } from "./config.js";
import { toPosix } from "./registry.js";

/**
 * @typedef {object} BrokenRef
 * @property {string} file
 * @property {number} line
 * @property {string} ref
 * @property {"at-import" | "markdown-link"} kind
 */

/**
 * @typedef {object} FileMetrics
 * @property {string} file
 * @property {number} bytes
 * @property {number} lines
 * @property {number} estimatedTokens
 * @property {boolean} overBudget
 */

/**
 * @typedef {object} Contradiction
 * @property {string} topic
 * @property {string} message
 * @property {Array<{ file: string, line: number, value: string }>} occurrences
 */

/**
 * Estimate token count using a lightweight character/word heuristic (~4 chars/token).
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Strip fenced code blocks (``` or ~~~) while preserving line numbers.
 * @param {string} content
 * @returns {string[]}
 */
function linesOutsideCodeFences(content) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  /** @type {string[]} */
  const out = [];
  /** @type {string | null} */
  let activeFence = null;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const fenceMatch = /^(```+|~~~+)/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!activeFence) {
        activeFence = marker;
        out.push("");
        continue;
      }
      if (activeFence === marker) {
        activeFence = null;
        out.push("");
        continue;
      }
    }
    out.push(activeFence ? "" : line);
  }

  return out;
}

/**
 * Remove inline backtick code spans from a single line.
 * @param {string} line
 * @returns {string}
 */
function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, "");
}

/**
 * Check if a link target is external or an in-page anchor.
 * @param {string} target
 * @returns {boolean}
 */
function isExternalOrAnchor(target) {
  const t = target.trim();
  if (!t || t.startsWith("#")) return true;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t);
}

/**
 * Inspect broken `@path` imports and local Markdown links across rule files.
 * @param {string} rootDir
 * @param {string[]} relFiles
 * @returns {BrokenRef[]}
 */
export function findBrokenReferences(rootDir, relFiles) {
  /** @type {BrokenRef[]} */
  const broken = [];

  for (const relFile of relFiles) {
    const absFile = safeResolveInside(rootDir, relFile);
    if (!fs.existsSync(absFile)) continue;
    const content = fs.readFileSync(absFile, "utf8");
    const lines = linesOutsideCodeFences(content);
    const fileDir = path.dirname(absFile);

    for (let idx = 0; idx < lines.length; idx++) {
      const lineNumber = idx + 1;
      const line = lines[idx];

      // 1. Line-start `@path` imports (e.g., `@AGENTS.md`, `@docs/arch.md`, `@./rules/foo.md`)
      const atMatch = /^\s*@([^\s]+)\s*$/.exec(line);
      if (atMatch) {
        const rawRef = atMatch[1].replace(/[),.;:]+$/, "");
        // Distinguish file imports from npm scopes or decorators:
        // require either a file extension or leading ./ or ../
        const looksLikeFileRef =
          rawRef.startsWith("./") ||
          rawRef.startsWith("../") ||
          /\.[a-zA-Z0-9]{1,8}$/.test(rawRef);
        if (looksLikeFileRef && !rawRef.includes("@")) {
          const resolved = resolveRefPath(rootDir, fileDir, rawRef);
          if (!resolved || !fs.existsSync(resolved)) {
            broken.push({
              file: toPosix(relFile),
              line: lineNumber,
              ref: rawRef,
              kind: "at-import",
            });
          }
        }
      }

      // 2. Markdown links [label](path) outside inline code
      const cleanLine = stripInlineCode(line);
      const linkRe = /!?\[[^\]]*\]\(([^)]+)\)/g;
      let match;
      while ((match = linkRe.exec(cleanLine)) !== null) {
        const rawTarget = match[1].trim().replace(/^<|>$/g, "");
        if (isExternalOrAnchor(rawTarget)) continue;
        // Strip optional title and #fragment / ?query
        const pathOnly = rawTarget.split(/\s+/)[0].split("#")[0].split("?")[0];
        if (!pathOnly) continue;
        const resolved = resolveRefPath(rootDir, fileDir, pathOnly);
        if (!resolved || !fs.existsSync(resolved)) {
          broken.push({
            file: toPosix(relFile),
            line: lineNumber,
            ref: pathOnly,
            kind: "markdown-link",
          });
        }
      }
    }
  }

  return broken;
}

/**
 * Resolve a reference relative to fileDir (or project root if rooted with `/`),
 * returning null if it escapes rootDir.
 * @param {string} rootDir
 * @param {string} fileDir
 * @param {string} ref
 * @returns {string | null}
 */
function resolveRefPath(rootDir, fileDir, ref) {
  const resolvedRoot = path.resolve(rootDir);
  const candidate = ref.startsWith("/")
    ? path.resolve(resolvedRoot, ref.slice(1))
    : path.resolve(fileDir, ref);
  const rel = path.relative(resolvedRoot, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return candidate;
}

/**
 * Compute size & estimated token metrics for rule files.
 * @param {string} rootDir
 * @param {string[]} relFiles
 * @param {number | null} maxTokens
 * @returns {FileMetrics[]}
 */
export function measureRuleFiles(rootDir, relFiles, maxTokens) {
  /** @type {FileMetrics[]} */
  const metrics = [];
  for (const relFile of relFiles) {
    const abs = safeResolveInside(rootDir, relFile);
    if (!fs.existsSync(abs)) continue;
    const content = fs.readFileSync(abs, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    const lines = content.length === 0 ? 0 : content.replace(/\r\n/g, "\n").split("\n").length;
    const estimatedTokens = estimateTokens(content);
    metrics.push({
      file: toPosix(relFile),
      bytes,
      lines,
      estimatedTokens,
      overBudget: maxTokens !== null && estimatedTokens > maxTokens,
    });
  }
  return metrics;
}

const NEGATION_RE = /\b(?:do not|don't|never|avoid|instead of|not|ban|forbid|prohibit)\b/i;

/**
 * Detect conflicting package manager directives across separate rule files.
 * @param {string} rootDir
 * @param {string[]} relFiles
 * @returns {Contradiction[]}
 */
export function findContradictions(rootDir, relFiles) {
  /** @type {Map<string, Array<{ file: string, line: number, value: string }>>} */
  const pmByManager = new Map();

  const pmPattern = /\b(npm|pnpm|yarn|bun)\s+(?:install|ci|add|run|test|exec|dlx)\b/g;

  for (const relFile of relFiles) {
    const abs = safeResolveInside(rootDir, relFile);
    if (!fs.existsSync(abs)) continue;
    const content = fs.readFileSync(abs, "utf8");
    const lines = content.replace(/\r\n/g, "\n").split("\n");

    /** @type {Set<string>} */
    const seenInFile = new Set();

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      // Skip negated instructions ("never use npm install")
      if (NEGATION_RE.test(line)) continue;
      let match;
      pmPattern.lastIndex = 0;
      while ((match = pmPattern.exec(line)) !== null) {
        const pm = match[1].toLowerCase();
        if (seenInFile.has(pm)) continue;
        seenInFile.add(pm);
        const list = pmByManager.get(pm) ?? [];
        list.push({ file: toPosix(relFile), line: idx + 1, value: pm });
        pmByManager.set(pm, list);
      }
    }
  }

  /** @type {Contradiction[]} */
  const contradictions = [];
  if (pmByManager.size > 1) {
    // Only report if different files prescribe different primary package managers
    /** @type {Array<{ file: string, line: number, value: string }>} */
    const allOccurrences = [];
    for (const entries of pmByManager.values()) {
      allOccurrences.push(...entries);
    }
    const distinctFiles = new Set(allOccurrences.map((o) => o.file));
    if (distinctFiles.size > 1) {
      const managers = [...pmByManager.keys()].sort().join(", ");
      contradictions.push({
        topic: "package-manager",
        message: `Conflicting package managers referenced across instruction files (${managers}).`,
        occurrences: allOccurrences,
      });
    }
  }

  return contradictions;
}
