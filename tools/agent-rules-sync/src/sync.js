// @ts-check
import fs from "node:fs";
import path from "node:path";
import { getTargetSpec, isMdcPath, toPosix } from "./registry.js";
import { safeResolveInside } from "./config.js";

const START_MARKER_RE = /^<!--\s*agent-rules-sync:start(?:\s+[^>]*)?\s*-->/m;
const END_MARKER = "<!-- agent-rules-sync:end -->";
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * @typedef {import("./config.js").AgentRulesConfig} AgentRulesConfig
 * @typedef {import("./config.js").TargetConfig} TargetConfig
 * @typedef {import("./config.js").SyncMode} SyncMode
 */

/**
 * @typedef {object} TargetPlan
 * @property {string} path
 * @property {SyncMode} mode
 * @property {"create" | "update" | "unchanged"} action
 * @property {string} currentContent
 * @property {string} nextContent
 * @property {boolean} hasManagedMarkers
 */

/**
 * Normalize line endings to LF for internal processing.
 * @param {string} text
 * @returns {string}
 */
function toLf(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Detect whether a file uses CRLF line endings.
 * @param {string} text
 * @returns {"\r\n" | "\n"}
 */
function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Apply target EOL and ensure trailing newline.
 * @param {string} lfText
 * @param {"\r\n" | "\n"} eol
 * @returns {string}
 */
function applyEol(lfText, eol) {
  const trimmed = lfText.replace(/\n+$/, "") + "\n";
  return eol === "\r\n" ? trimmed.replace(/\n/g, "\r\n") : trimmed;
}

/**
 * Build default YAML frontmatter for Cursor .mdc files.
 * @param {TargetConfig} target
 * @param {string} sourcePath
 * @returns {string}
 */
function buildMdcFrontmatter(target, sourcePath) {
  const description = (target.description ?? `Project rules synced from ${sourcePath}`).replace(/\r?\n/g, " ");
  const globs = target.globs ?? "";
  const alwaysApply = target.alwaysApply ?? true;
  return [
    "---",
    `description: ${description}`,
    `globs: ${globs}`,
    `alwaysApply: ${alwaysApply}`,
    "---",
  ].join("\n");
}

/**
 * Build the inner body (without markers) for a target.
 * @param {string} sourceContentLf
 * @param {string} sourcePath
 * @param {TargetConfig} target
 * @param {SyncMode} mode
 * @returns {string}
 */
function renderInnerBody(sourceContentLf, sourcePath, target, mode) {
  if (mode === "pointer") {
    const targetDir = path.posix.dirname(toPosix(target.path));
    const relSource = toPosix(path.posix.relative(targetDir === "." ? "" : targetDir, toPosix(sourcePath)));
    const spec = getTargetSpec(target.path);
    if (spec?.supportsAtImport) {
      return [
        `@${relSource}`,
        "",
        `Read \`${relSource}\` for the canonical project instructions, architecture notes, and commands.`,
      ].join("\n");
    }
    return `Follow the canonical project instructions in [${sourcePath}](${relSource}).`;
  }

  // Copy mode: strip YAML frontmatter if source is an .mdc file
  let body = sourceContentLf.replace(FRONTMATTER_RE, "").trim();
  // Avoid nested markers if source somehow contained them
  body = body
    .replace(/^<!--\s*agent-rules-sync:start(?:\s+[^>]*)?\s*-->\n?/gm, "")
    .replace(/^<!--\s*agent-rules-sync:end\s*-->\n?/gm, "")
    .trim();
  return body;
}

/**
 * Wrap body with managed start/end markers.
 * @param {string} innerBodyLf
 * @param {string} sourcePath
 * @returns {string}
 */
function wrapManagedBlock(innerBodyLf, sourcePath) {
  const startMarker = `<!-- agent-rules-sync:start source="${toPosix(sourcePath)}" -->`;
  if (!innerBodyLf) {
    return `${startMarker}\n${END_MARKER}`;
  }
  return `${startMarker}\n${innerBodyLf}\n${END_MARKER}`;
}

/**
 * Compute the rendered target file content, preserving frontmatter and any
 * user-authored sections outside the managed markers.
 * @param {object} params
 * @param {string} params.sourceContent
 * @param {string} params.sourcePath
 * @param {TargetConfig} params.target
 * @param {SyncMode} params.defaultMode
 * @param {string | null} params.existingContent
 * @returns {{ content: string, hasManagedMarkers: boolean }}
 */
export function renderTargetContent({
  sourceContent,
  sourcePath,
  target,
  defaultMode,
  existingContent,
}) {
  const mode = target.mode ?? defaultMode;
  const eol = existingContent !== null ? detectEol(existingContent) : "\n";
  const existingLf = existingContent !== null ? toLf(existingContent) : "";
  const sourceLf = toLf(sourceContent);

  const innerBody = renderInnerBody(sourceLf, sourcePath, target, mode);
  const block = wrapManagedBlock(innerBody, sourcePath);

  if (existingContent !== null) {
    const startMatch = START_MARKER_RE.exec(existingLf);
    if (startMatch) {
      const endIndex = existingLf.indexOf(END_MARKER, startMatch.index + startMatch[0].length);
      if (endIndex !== -1) {
        const before = existingLf.slice(0, startMatch.index);
        const after = existingLf.slice(endIndex + END_MARKER.length);
        const combined = `${before}${block}${after}`;
        return {
          content: applyEol(combined, eol),
          hasManagedMarkers: true,
        };
      }
    }
  }

  // No existing managed markers
  if (isMdcPath(target.path)) {
    const fmMatch = FRONTMATTER_RE.exec(existingLf);
    if (fmMatch) {
      const frontmatter = fmMatch[0].replace(/\n+$/, "");
      const remainder = existingLf.slice(fmMatch[0].length).trim();
      const parts = [frontmatter, "", block];
      if (remainder) {
        parts.push("", remainder);
      }
      return {
        content: applyEol(parts.join("\n"), eol),
        hasManagedMarkers: existingContent !== null ? false : true,
      };
    }

    const frontmatter = buildMdcFrontmatter(target, sourcePath);
    const remainder = existingLf.trim();
    const parts = [frontmatter, "", block];
    if (remainder) {
      parts.push("", remainder);
    }
    return {
      content: applyEol(parts.join("\n"), eol),
      hasManagedMarkers: existingContent !== null ? false : true,
    };
  }

  const remainder = existingLf.trim();
  const combined = remainder ? `${block}\n\n${remainder}` : block;
  return {
    content: applyEol(combined, eol),
    hasManagedMarkers: existingContent !== null ? false : true,
  };
}

/**
 * Build a sync plan for all configured targets.
 * @param {string} rootDir
 * @param {AgentRulesConfig} config
 * @param {TargetConfig[]} targets
 * @returns {TargetPlan[]}
 */
export function buildSyncPlan(rootDir, config, targets) {
  const sourceAbs = safeResolveInside(rootDir, config.source);
  if (!fs.existsSync(sourceAbs)) {
    throw new Error(`Canonical source file not found: ${config.source}`);
  }
  const sourceContent = fs.readFileSync(sourceAbs, "utf8");

  /** @type {TargetPlan[]} */
  const plans = [];

  for (const target of targets) {
    const targetAbs = safeResolveInside(rootDir, target.path);
    const exists = fs.existsSync(targetAbs);
    const existingContent = exists ? fs.readFileSync(targetAbs, "utf8") : null;

    const rendered = renderTargetContent({
      sourceContent,
      sourcePath: config.source,
      target,
      defaultMode: config.mode,
      existingContent,
    });

    const currentNormalized = existingContent !== null ? toLf(existingContent) : "";
    const nextNormalized = toLf(rendered.content);

    /** @type {"create" | "update" | "unchanged"} */
    const action = existingContent === null
      ? "create"
      : currentNormalized === nextNormalized
        ? "unchanged"
        : "update";

    plans.push({
      path: target.path,
      mode: target.mode ?? config.mode,
      action,
      currentContent: existingContent ?? "",
      nextContent: rendered.content,
      hasManagedMarkers: rendered.hasManagedMarkers,
    });
  }

  return plans;
}

/**
 * Execute a sync plan onto disk (unless dryRun is true).
 * @param {string} rootDir
 * @param {TargetPlan[]} plans
 * @param {boolean} dryRun
 * @returns {TargetPlan[]}
 */
export function applySyncPlan(rootDir, plans, dryRun) {
  if (dryRun) return plans;
  for (const plan of plans) {
    if (plan.action === "unchanged") continue;
    const abs = safeResolveInside(rootDir, plan.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, plan.nextContent, "utf8");
  }
  return plans;
}

/**
 * Check whether text contains an agent-rules-sync managed block.
 * @param {string} content
 * @returns {boolean}
 */
export function hasManagedBlock(content) {
  const lf = toLf(content);
  const startMatch = START_MARKER_RE.exec(lf);
  if (!startMatch) return false;
  return lf.indexOf(END_MARKER, startMatch.index + startMatch[0].length) !== -1;
}
