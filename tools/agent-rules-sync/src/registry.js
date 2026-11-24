// @ts-check
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {object} TargetSpec
 * @property {string} alias
 * @property {string} label
 * @property {string} defaultPath
 * @property {"markdown" | "mdc"} format
 * @property {boolean} supportsAtImport
 */

/** @type {readonly TargetSpec[]} */
export const KNOWN_TARGETS = [
  {
    alias: "agents",
    label: "AGENTS.md (OpenAI Codex, Zed, OpenCode, Antigravity)",
    defaultPath: "AGENTS.md",
    format: "markdown",
    supportsAtImport: false,
  },
  {
    alias: "claude",
    label: "Claude Code",
    defaultPath: "CLAUDE.md",
    format: "markdown",
    supportsAtImport: true,
  },
  {
    alias: "gemini",
    label: "Gemini CLI / Antigravity",
    defaultPath: "GEMINI.md",
    format: "markdown",
    supportsAtImport: true,
  },
  {
    alias: "copilot",
    label: "GitHub Copilot",
    defaultPath: ".github/copilot-instructions.md",
    format: "markdown",
    supportsAtImport: false,
  },
  {
    alias: "cursor",
    label: "Cursor MDC rules",
    defaultPath: ".cursor/rules/project.mdc",
    format: "mdc",
    supportsAtImport: false,
  },
  {
    alias: "cursorrules",
    label: "Cursor legacy rules",
    defaultPath: ".cursorrules",
    format: "markdown",
    supportsAtImport: false,
  },
  {
    alias: "windsurf",
    label: "Windsurf",
    defaultPath: ".windsurfrules",
    format: "markdown",
    supportsAtImport: false,
  },
  {
    alias: "cline",
    label: "Cline",
    defaultPath: ".clinerules",
    format: "markdown",
    supportsAtImport: false,
  },
  {
    alias: "roo",
    label: "Roo Code",
    defaultPath: ".roo/rules/project.md",
    format: "markdown",
    supportsAtImport: false,
  },
];

/** @type {Map<string, TargetSpec>} */
const ALIAS_MAP = new Map(KNOWN_TARGETS.map((spec) => [spec.alias, spec]));

/** @type {Map<string, TargetSpec>} */
const PATH_MAP = new Map(KNOWN_TARGETS.map((spec) => [spec.defaultPath, spec]));

/**
 * Normalize a relative path to forward slashes for cross-platform consistency.
 * @param {string} p
 * @returns {string}
 */
export function toPosix(p) {
  return p.split(path.sep).join("/").replace(/^\.\//, "");
}

/**
 * Resolve an alias or relative path into a normalized relative path.
 * @param {string} raw
 * @returns {string}
 */
export function resolveTargetPath(raw) {
  const trimmed = raw.trim();
  const byAlias = ALIAS_MAP.get(trimmed.toLowerCase());
  if (byAlias) {
    return byAlias.defaultPath;
  }
  return toPosix(trimmed);
}

/**
 * Look up metadata for a target file path.
 * @param {string} relPath
 * @returns {TargetSpec | null}
 */
export function getTargetSpec(relPath) {
  const norm = toPosix(relPath);
  const direct = PATH_MAP.get(norm);
  if (direct) return direct;
  if (norm.startsWith(".cursor/rules/") && norm.endsWith(".mdc")) {
    return {
      alias: "cursor",
      label: "Cursor MDC rules",
      defaultPath: norm,
      format: "mdc",
      supportsAtImport: false,
    };
  }
  return null;
}

/**
 * Check whether a file path uses Cursor .mdc frontmatter format.
 * @param {string} relPath
 * @returns {boolean}
 */
export function isMdcPath(relPath) {
  return toPosix(relPath).toLowerCase().endsWith(".mdc");
}

/**
 * Discover all existing AI instruction files in a project root.
 * @param {string} rootDir
 * @returns {string[]}
 */
export function discoverRuleFiles(rootDir) {
  /** @type {Set<string>} */
  const found = new Set();

  for (const spec of KNOWN_TARGETS) {
    const abs = path.join(rootDir, spec.defaultPath);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      found.add(spec.defaultPath);
    }
  }

  const cursorRulesDir = path.join(rootDir, ".cursor", "rules");
  if (fs.existsSync(cursorRulesDir) && fs.statSync(cursorRulesDir).isDirectory()) {
    for (const entry of fs.readdirSync(cursorRulesDir, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith(".mdc") || entry.name.endsWith(".md"))) {
        found.add(`.cursor/rules/${entry.name}`);
      }
    }
  }

  const rooRulesDir = path.join(rootDir, ".roo", "rules");
  if (fs.existsSync(rooRulesDir) && fs.statSync(rooRulesDir).isDirectory()) {
    for (const entry of fs.readdirSync(rooRulesDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        found.add(`.roo/rules/${entry.name}`);
      }
    }
  }

  return [...found].sort();
}
