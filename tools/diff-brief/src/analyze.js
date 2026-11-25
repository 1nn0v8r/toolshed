// @ts-check
import path from "node:path";
import {
  categorizeFile,
  detectSensitiveReason,
  extractPackageJsonDelta
} from "./classify.js";
import { DEFAULT_CONFIG, matchesAnyGlob, normalizePath } from "./config.js";

/**
 * @typedef {"none"|"low"|"medium"|"high"} RiskLevel
 */

/**
 * @typedef {object} RiskFlag
 * @property {string} id
 * @property {"low"|"medium"|"high"} severity
 * @property {string} file
 * @property {number|null} line
 * @property {string} message
 * @property {string} snippet
 */

/**
 * @typedef {object} FileBrief
 * @property {string} path
 * @property {string|null} oldPath
 * @property {"added"|"deleted"|"modified"|"renamed"|"copied"} status
 * @property {import("./classify.js").FileCategory} category
 * @property {boolean} binary
 * @property {number} additions
 * @property {number} deletions
 * @property {string|null} sensitiveReason
 * @property {string[]} symbols
 * @property {string[]} hunkRanges
 * @property {import("./classify.js").PackageJsonDelta|null} packageDelta
 * @property {number} priorityScore
 * @property {import("./parser.js").DiffHunk[]} hunks
 */

/**
 * @typedef {object} DiffBriefReport
 * @property {string} scope
 * @property {string[]} commits
 * @property {RiskLevel} riskLevel
 * @property {{
 *   totalFiles: number,
 *   meaningfulFiles: number,
 *   noiseFiles: number,
 *   additions: number,
 *   deletions: number,
 *   meaningfulAdditions: number,
 *   meaningfulDeletions: number,
 *   rawDiffTokens: number,
 *   byCategory: Record<string, number>
 * }} stats
 * @property {RiskFlag[]} flags
 * @property {FileBrief[]} files
 * @property {string[]} checklist
 */

const SKIP_TEST_RE =
  /\b(?:it|test|describe|context|suite)\.(?:skip|only|todo)\s*\(|\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(|@pytest\.mark\.skip\b|\bpytest\.skip\s*\(|#\[ignore\]|\bt\.Skip\s*\(/;

const ASSERTION_RE =
  /\b(?:expect|assert|assertEqual|assertStrictEqual|assertDeepEqual|assertThrows|assertRejects|assert_eq!|assert_ne!)\s*\(|\bassert\b\s+|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/;

const TYPE_SUPPRESSION_RE =
  /@ts-ignore\b|@ts-expect-error\b|@ts-nocheck\b|#\s*type:\s*ignore\b|\beslint-disable(?:-next-line|-line)?\b|\bbiome-ignore\b|#\s*noqa\b|#\[allow\(|\/\/\s*nolint\b/;

const TS_ANY_RE = /(?::\s*any\b|\bas\s+any\b|<any>)/;

const DEBUG_HARD_RE = /\bdebugger\b|\bpdb\.set_trace\s*\(|\bbreakpoint\s*\(|\bdbg!\s*\(/;
const DEBUG_SOFT_RE = /\bconsole\.(?:log|debug)\s*\(/;
const TODO_RE = /(?:\/\/|#|\/\*)\s*(?:TODO|FIXME|HACK|XXX)\b/;

const SYMBOL_PATTERNS = [
  /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/,
  /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)\s*\(/,
  /^\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/,
  /^\s*(?:pub(?:\([^)]+\))?\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_][\w]*)/,
  /^(#{1,3}\s+.{2,60})$/
];

/**
 * Estimate token count using ~4 characters per token.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Clip a single line for display inside flags.
 *
 * @param {string} line
 * @returns {string}
 */
function clipSnippet(line) {
  const trimmed = line.trim();
  if (trimmed.length <= 100) return trimmed;
  return `${trimmed.slice(0, 97)}...`;
}

/**
 * Extract changed symbol names from hunk headers and added/removed lines.
 *
 * @param {import("./parser.js").DiffHunk[]} hunks
 * @returns {string[]}
 */
export function extractChangedSymbols(hunks) {
  /** @type {Set<string>} */
  const symbols = new Set();

  for (const hunk of hunks) {
    if (hunk.headerContext) {
      for (const re of SYMBOL_PATTERNS) {
        const m = hunk.headerContext.match(re);
        if (m && m[1]) {
          symbols.add(m[1].trim());
          break;
        }
      }
    }
    for (const line of hunk.lines) {
      if (line.type === "ctx") continue;
      for (const re of SYMBOL_PATTERNS) {
        const m = line.text.match(re);
        if (m && m[1]) {
          symbols.add(m[1].trim());
          break;
        }
      }
      if (symbols.size >= 8) break;
    }
    if (symbols.size >= 8) break;
  }

  return Array.from(symbols);
}

/**
 * Format hunk line ranges like L12-L34.
 *
 * @param {import("./parser.js").DiffHunk[]} hunks
 * @returns {string[]}
 */
function formatHunkRanges(hunks) {
  return hunks.slice(0, 6).map((h) => {
    const start = h.newStart;
    const end = Math.max(start, start + Math.max(0, h.newCount - 1));
    return start === end ? `L${start}` : `L${start}-L${end}`;
  });
}

/**
 * Rank risk levels numerically for comparisons.
 *
 * @param {RiskLevel} level
 * @returns {number}
 */
export function riskRank(level) {
  switch (level) {
    case "none":
      return 0;
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
  }
}

/**
 * Analyze parsed file diffs against configuration to produce a structured DiffBriefReport.
 *
 * @param {import("./parser.js").ParsedFileDiff[]} parsedFiles
 * @param {{
 *   scope?: string,
 *   commits?: string[],
 *   rawDiffText?: string,
 *   config?: Partial<import("./config.js").DiffBriefConfig>
 * }} [options]
 * @returns {DiffBriefReport}
 */
export function analyzeDiff(parsedFiles, options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
  const ignoredFlagSet = new Set(cfg.ignoreFlags);

  /** @type {RiskFlag[]} */
  const flags = [];
  /** @type {FileBrief[]} */
  const fileBriefs = [];
  /** @type {Record<string, number>} */
  const byCategory = {
    source: 0,
    test: 0,
    config: 0,
    docs: 0,
    lockfile: 0,
    generated: 0
  };

  let additions = 0;
  let deletions = 0;
  let meaningfulAdditions = 0;
  let meaningfulDeletions = 0;
  let noiseFiles = 0;
  let sourceAdditions = 0;
  let sourceFilesTouched = 0;
  let testFilesTouched = 0;

  const pushFlag = (/** @type {RiskFlag} */ flag) => {
    if (ignoredFlagSet.has(flag.id)) return;
    flags.push(flag);
  };

  for (const file of parsedFiles) {
    const normPath = normalizePath(file.path);
    if (matchesAnyGlob(normPath, cfg.ignore)) continue;

    const category = categorizeFile(normPath, cfg.testPatterns);
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    additions += file.additions;
    deletions += file.deletions;

    const isNoise = category === "lockfile" || category === "generated";
    if (isNoise) {
      noiseFiles += 1;
    } else {
      meaningfulAdditions += file.additions;
      meaningfulDeletions += file.deletions;
    }

    if (category === "source") {
      sourceFilesTouched += 1;
      sourceAdditions += file.additions;
    } else if (category === "test") {
      testFilesTouched += 1;
    }

    const baseName = path.posix.basename(normPath).toLowerCase();
    const ext = path.posix.extname(baseName);
    const isTsOrJs = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(ext);

    let sensitiveReason = isNoise ? null : detectSensitiveReason(normPath, cfg.sensitivePatterns);
    /** @type {import("./classify.js").PackageJsonDelta|null} */
    let packageDelta = null;

    if (baseName === "package.json") {
      packageDelta = extractPackageJsonDelta(file);
      if (
        packageDelta.addedDeps.length > 0 ||
        packageDelta.removedDeps.length > 0 ||
        packageDelta.changedScripts.length > 0
      ) {
        const parts = [];
        if (packageDelta.addedDeps.length > 0) {
          parts.push(`added deps: ${packageDelta.addedDeps.join(", ")}`);
        }
        if (packageDelta.removedDeps.length > 0) {
          parts.push(`removed deps: ${packageDelta.removedDeps.join(", ")}`);
        }
        if (packageDelta.changedScripts.length > 0) {
          parts.push(`scripts changed: ${packageDelta.changedScripts.join(", ")}`);
        }
        sensitiveReason = `package.json (${parts.join("; ")})`;
      }
    }

    if (sensitiveReason) {
      pushFlag({
        id: "sensitive-surface",
        severity: normPath.includes(".github/workflows/") || baseName.startsWith(".env") ? "high" : "medium",
        file: normPath,
        line: file.hunks[0]?.newStart ?? null,
        message: sensitiveReason,
        snippet: file.status
      });
    }

    if (file.binary && !isNoise) {
      pushFlag({
        id: "binary-added",
        severity: "low",
        file: normPath,
        line: null,
        message: `Binary file ${file.status}`,
        snippet: normPath
      });
    }

    if (!isNoise && file.deletions >= cfg.largeDeletionThreshold && file.additions < 10 && file.status !== "deleted") {
      pushFlag({
        id: "large-deletion",
        severity: "medium",
        file: normPath,
        line: file.hunks[0]?.newStart ?? null,
        message: `Large deletion (+${file.additions}/-${file.deletions}) without replacement`,
        snippet: `+${file.additions}/-${file.deletions}`
      });
    }

    let assertionsAdded = 0;
    let assertionsRemoved = 0;
    let firstRemovedAssertLine = null;
    let firstRemovedAssertText = "";

    if (!isNoise && !file.binary && category !== "docs") {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.type === "del" && category === "test") {
            if (ASSERTION_RE.test(line.text)) {
              assertionsRemoved += 1;
              if (firstRemovedAssertLine === null) {
                firstRemovedAssertLine = line.oldLine;
                firstRemovedAssertText = line.text;
              }
            }
            continue;
          }
          if (line.type !== "add") continue;

          if (category === "test" && ASSERTION_RE.test(line.text)) {
            assertionsAdded += 1;
          }

          if (SKIP_TEST_RE.test(line.text)) {
            pushFlag({
              id: "test-skip",
              severity: "high",
              file: normPath,
              line: line.newLine,
              message: "Test skip or focus marker added",
              snippet: clipSnippet(line.text)
            });
          }

          if (TYPE_SUPPRESSION_RE.test(line.text) || (isTsOrJs && category !== "test" && TS_ANY_RE.test(line.text))) {
            pushFlag({
              id: "type-suppression",
              severity: "medium",
              file: normPath,
              line: line.newLine,
              message: "Type or lint suppression added",
              snippet: clipSnippet(line.text)
            });
          }

          if (DEBUG_HARD_RE.test(line.text)) {
            pushFlag({
              id: "debug-leftover",
              severity: "medium",
              file: normPath,
              line: line.newLine,
              message: "Debugger or breakpoint call added",
              snippet: clipSnippet(line.text)
            });
          } else if (category === "source" && DEBUG_SOFT_RE.test(line.text)) {
            pushFlag({
              id: "debug-leftover",
              severity: "low",
              file: normPath,
              line: line.newLine,
              message: "Console debug logging added in source file",
              snippet: clipSnippet(line.text)
            });
          }

          if (TODO_RE.test(line.text)) {
            pushFlag({
              id: "todo-added",
              severity: "low",
              file: normPath,
              line: line.newLine,
              message: "TODO/FIXME/HACK marker added",
              snippet: clipSnippet(line.text)
            });
          }
        }
      }
    }

    if (category === "test" && assertionsRemoved > assertionsAdded && assertionsRemoved > 0) {
      pushFlag({
        id: "assertion-removed",
        severity: "medium",
        file: normPath,
        line: firstRemovedAssertLine,
        message: `Net assertions reduced (-${assertionsRemoved}/+${assertionsAdded})`,
        snippet: clipSnippet(firstRemovedAssertText)
      });
    }

    const fileFlags = flags.filter((f) => f.file === normPath);
    const hasHigh = fileFlags.some((f) => f.severity === "high");
    const hasMed = fileFlags.some((f) => f.severity === "medium");
    const categoryWeight =
      category === "source" ? 30 : category === "config" ? 20 : category === "test" ? 15 : category === "docs" ? 5 : 0;
    const priorityScore =
      (hasHigh ? 1000 : 0) +
      (hasMed ? 300 : 0) +
      (sensitiveReason ? 200 : 0) +
      categoryWeight +
      Math.min(100, file.additions + file.deletions);

    fileBriefs.push({
      path: normPath,
      oldPath: file.oldPath ? normalizePath(file.oldPath) : null,
      status: file.status,
      category,
      binary: file.binary,
      additions: file.additions,
      deletions: file.deletions,
      sensitiveReason,
      symbols: isNoise ? [] : extractChangedSymbols(file.hunks),
      hunkRanges: isNoise ? [] : formatHunkRanges(file.hunks),
      packageDelta,
      priorityScore,
      hunks: file.hunks
    });
  }

  if (cfg.requireTests && sourceFilesTouched > 0 && testFilesTouched === 0 && sourceAdditions >= cfg.unpairedSourceMinLines) {
    pushFlag({
      id: "unpaired-source",
      severity: "medium",
      file: "(diff)",
      line: null,
      message: `${sourceFilesTouched} source file(s) modified (+${sourceAdditions} lines) with no test files touched`,
      snippet: "no test changes"
    });
  }

  fileBriefs.sort((a, b) => b.priorityScore - a.priorityScore || a.path.localeCompare(b.path));

  const highCount = flags.filter((f) => f.severity === "high").length;
  const medCount = flags.filter((f) => f.severity === "medium").length;
  const lowCount = flags.filter((f) => f.severity === "low").length;

  /** @type {RiskLevel} */
  let riskLevel = "none";
  if (highCount > 0 || medCount >= 3) {
    riskLevel = "high";
  } else if (medCount > 0 || lowCount >= 3 || meaningfulAdditions + meaningfulDeletions > 400) {
    riskLevel = "medium";
  } else if (lowCount > 0 || fileBriefs.length > 0) {
    riskLevel = "low";
  }

  const checklist = buildChecklist(fileBriefs, flags, byCategory);
  const rawDiffText = options.rawDiffText ?? parsedFiles.map((f) => f.rawChunk).join("\n");

  return {
    scope: options.scope ?? "diff",
    commits: options.commits ?? [],
    riskLevel,
    stats: {
      totalFiles: fileBriefs.length,
      meaningfulFiles: fileBriefs.length - noiseFiles,
      noiseFiles,
      additions,
      deletions,
      meaningfulAdditions,
      meaningfulDeletions,
      rawDiffTokens: estimateTokens(rawDiffText),
      byCategory
    },
    flags,
    files: fileBriefs,
    checklist
  };
}

/**
 * Build a concise, context-aware review checklist from findings.
 *
 * @param {FileBrief[]} files
 * @param {RiskFlag[]} flags
 * @param {Record<string, number>} byCategory
 * @returns {string[]}
 */
function buildChecklist(files, flags, byCategory) {
  /** @type {string[]} */
  const items = [];
  const flagIds = new Set(flags.map((f) => f.id));

  if (flagIds.has("test-skip")) {
    items.push("Confirm no skipped or focused tests (.skip / .only / #[ignore]) are left behind.");
  }
  if (flagIds.has("assertion-removed")) {
    items.push("Verify removed test assertions were intentionally replaced and coverage did not drop.");
  }
  if (flagIds.has("unpaired-source")) {
    items.push("Verify whether new tests are needed for the modified source files.");
  }
  if (flagIds.has("type-suppression")) {
    items.push("Inspect added type or lint suppressions (@ts-ignore, any, eslint-disable, noqa).");
  }
  if (flagIds.has("sensitive-surface")) {
    items.push("Review sensitive changes (workflows, auth/security, migrations, env, or package scripts).");
  }
  if (flagIds.has("large-deletion")) {
    items.push("Double-check large deletions to ensure no needed logic was accidentally dropped.");
  }
  if ((byCategory.lockfile ?? 0) > 0) {
    items.push("Lockfile changes were summarized out of hunks; verify dependency diff matches intent.");
  }
  if (items.length === 0 && files.length > 0) {
    items.push("No automated risk flags triggered; review changed symbols and edge cases.");
  }
  return items;
}
