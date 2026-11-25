// @ts-check
import { estimateTokens } from "./analyze.js";

/**
 * Format a single hunk compactly for text or markdown output.
 *
 * @param {import("./parser.js").DiffHunk} hunk
 * @param {number} maxLines
 * @returns {string}
 */
function formatCompactHunk(hunk, maxLines = 40) {
  const out = [hunk.rawHeader];
  let count = 0;
  for (const line of hunk.lines) {
    if (count >= maxLines) {
      out.push(`... (${hunk.lines.length - count} more lines clipped)`);
      break;
    }
    const prefix = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
    out.push(`${prefix}${line.text}`);
    count += 1;
  }
  return out.join("\n");
}

/**
 * Select key hunks within the configured token budget.
 *
 * @param {import("./analyze.js").FileBrief[]} files
 * @param {number} maxTokens
 * @param {boolean} includeNoise
 * @returns {{ chunks: { path: string, body: string }[], usedTokens: number, omittedFiles: number }}
 */
function selectHunksWithinBudget(files, maxTokens, includeNoise) {
  if (maxTokens <= 0) {
    return { chunks: [], usedTokens: 0, omittedFiles: 0 };
  }

  /** @type {{ path: string, body: string }[]} */
  const chunks = [];
  let usedTokens = 0;
  let omittedFiles = 0;

  for (const file of files) {
    if (!includeNoise && (file.category === "lockfile" || file.category === "generated")) {
      continue;
    }
    if (file.binary || file.hunks.length === 0) continue;

    /** @type {string[]} */
    const fileParts = [];
    for (const hunk of file.hunks) {
      const text = formatCompactHunk(hunk);
      const cost = estimateTokens(text);
      if (usedTokens + cost > maxTokens) {
        if (chunks.length === 0 && fileParts.length === 0) {
          // Always include at least one clipped preview if budget allows a minimal header
          const charLimit = Math.max(120, maxTokens * 4);
          const clipped = `${text.slice(0, charLimit)}\n... (clipped to token budget)`;
          fileParts.push(clipped);
          usedTokens += estimateTokens(clipped);
        }
        omittedFiles += 1;
        break;
      }
      fileParts.push(text);
      usedTokens += cost;
    }

    if (fileParts.length > 0) {
      chunks.push({ path: file.path, body: fileParts.join("\n") });
    }
    if (omittedFiles > 0) {
      // Count remaining eligible files not yet added
      const currentIndex = files.indexOf(file);
      for (let j = currentIndex + 1; j < files.length; j += 1) {
        const rem = files[j];
        if (!includeNoise && (rem.category === "lockfile" || rem.category === "generated")) continue;
        if (!rem.binary && rem.hunks.length > 0) omittedFiles += 1;
      }
      break;
    }
  }

  return { chunks, usedTokens, omittedFiles };
}

/**
 * Format a DiffBriefReport as compact plain text for terminal and AI agent consumption.
 *
 * @param {import("./analyze.js").DiffBriefReport} report
 * @param {{ maxTokens?: number, includeNoise?: boolean }} [opts]
 * @returns {string}
 */
export function formatText(report, opts = {}) {
  const maxTokens = opts.maxTokens ?? 1800;
  const includeNoise = opts.includeNoise ?? false;
  const lines = [];

  lines.push(`diff-brief: ${report.scope}`);
  lines.push(
    `Risk: ${report.riskLevel.toUpperCase()} | Files: ${report.stats.meaningfulFiles} meaningful` +
      (report.stats.noiseFiles > 0 ? ` (+${report.stats.noiseFiles} noise)` : "") +
      ` | Lines: +${report.stats.meaningfulAdditions}/-${report.stats.meaningfulDeletions}` +
      (report.stats.noiseFiles > 0
        ? ` (raw total +${report.stats.additions}/-${report.stats.deletions})`
        : "")
  );

  if (report.stats.totalFiles === 0) {
    lines.push("No changes found.");
    return `${lines.join("\n")}\n`;
  }

  if (report.commits.length > 0) {
    lines.push(`Commits (${report.commits.length}):`);
    for (const c of report.commits.slice(0, 10)) {
      lines.push(`  - ${c}`);
    }
    if (report.commits.length > 10) {
      lines.push(`  ... (${report.commits.length - 10} more)`);
    }
  }

  if (report.flags.length > 0) {
    lines.push("");
    lines.push(`Flags (${report.flags.length}):`);
    for (const flag of report.flags.slice(0, 25)) {
      const loc = flag.line !== null ? `${flag.file}:${flag.line}` : flag.file;
      lines.push(`  [${flag.severity.toUpperCase()}] ${flag.id} (${loc}) - ${flag.message}`);
      if (flag.snippet && flag.snippet !== flag.file) {
        lines.push(`      ${flag.snippet}`);
      }
    }
    if (report.flags.length > 25) {
      lines.push(`  ... (${report.flags.length - 25} more flags; use --format json for full list)`);
    }
  }

  const meaningful = report.files.filter(
    (f) => f.category !== "lockfile" && f.category !== "generated"
  );
  const noise = report.files.filter(
    (f) => f.category === "lockfile" || f.category === "generated"
  );

  if (meaningful.length > 0) {
    lines.push("");
    lines.push(`Changed Files (${meaningful.length}):`);
    for (const f of meaningful) {
      const rename = f.oldPath ? `${f.oldPath} -> ` : "";
      const sym = f.symbols.length > 0 ? ` | symbols: ${f.symbols.slice(0, 5).join(", ")}` : "";
      const ranges = f.hunkRanges.length > 0 ? ` [${f.hunkRanges.join(", ")}]` : "";
      lines.push(
        `  [${f.category}] ${rename}${f.path} (${f.status}, +${f.additions}/-${f.deletions})${ranges}${sym}`
      );
      if (f.packageDelta) {
        const d = f.packageDelta;
        const pkgNotes = [];
        if (d.addedDeps.length > 0) pkgNotes.push(`+deps: ${d.addedDeps.join(", ")}`);
        if (d.removedDeps.length > 0) pkgNotes.push(`-deps: ${d.removedDeps.join(", ")}`);
        if (d.updatedDeps.length > 0) pkgNotes.push(`~deps: ${d.updatedDeps.join(", ")}`);
        if (d.changedScripts.length > 0) pkgNotes.push(`scripts: ${d.changedScripts.join(", ")}`);
        if (pkgNotes.length > 0) {
          lines.push(`      package.json delta: ${pkgNotes.join(" | ")}`);
        }
      }
    }
  }

  if (noise.length > 0) {
    lines.push("");
    lines.push(`Noise / Lockfiles Summarized (${noise.length}):`);
    for (const f of noise) {
      lines.push(`  [${f.category}] ${f.path} (+${f.additions}/-${f.deletions})`);
    }
  }

  if (report.checklist.length > 0) {
    lines.push("");
    lines.push("Review Checklist:");
    for (const item of report.checklist) {
      lines.push(`  [ ] ${item}`);
    }
  }

  const hunkSelection = selectHunksWithinBudget(report.files, maxTokens, includeNoise);
  if (hunkSelection.chunks.length > 0) {
    lines.push("");
    lines.push(`Key Hunks (~${hunkSelection.usedTokens} tokens, budget ${maxTokens}):`);
    for (const chunk of hunkSelection.chunks) {
      lines.push(`--- ${chunk.path} ---`);
      lines.push(chunk.body);
    }
    if (hunkSelection.omittedFiles > 0) {
      lines.push(`... (${hunkSelection.omittedFiles} more file(s) omitted due to --max-tokens ${maxTokens})`);
    }
  }

  const body = `${lines.join("\n")}\n`;
  const briefTokens = estimateTokens(body);
  const footer =
    report.stats.rawDiffTokens > 0
      ? `Tokens: brief ~${briefTokens} vs raw diff ~${report.stats.rawDiffTokens}\n`
      : "";
  return `${body}${footer}`;
}

/**
 * Format a DiffBriefReport as GitHub-flavored Markdown (for PR descriptions or agent prompts).
 *
 * @param {import("./analyze.js").DiffBriefReport} report
 * @param {{ maxTokens?: number, includeNoise?: boolean }} [opts]
 * @returns {string}
 */
export function formatMarkdown(report, opts = {}) {
  const maxTokens = opts.maxTokens ?? 1800;
  const includeNoise = opts.includeNoise ?? false;
  const lines = [];

  lines.push(`## Diff Brief: \`${report.scope}\``);
  lines.push("");
  lines.push(
    `**Risk:** \`${report.riskLevel.toUpperCase()}\` | ` +
      `**Files:** ${report.stats.meaningfulFiles} meaningful` +
      (report.stats.noiseFiles > 0 ? ` (+${report.stats.noiseFiles} noise)` : "") +
      ` | **Lines:** \`+${report.stats.meaningfulAdditions}/-${report.stats.meaningfulDeletions}\``
  );

  if (report.stats.totalFiles === 0) {
    lines.push("", "No changes found.");
    return `${lines.join("\n")}\n`;
  }

  if (report.flags.length > 0) {
    lines.push("", `### Risk Flags (${report.flags.length})`, "");
    lines.push("| Severity | Flag | Location | Detail |");
    lines.push("|---|---|---|---|");
    for (const flag of report.flags.slice(0, 25)) {
      const loc = flag.line !== null ? `\`${flag.file}:${flag.line}\`` : `\`${flag.file}\``;
      lines.push(`| ${flag.severity.toUpperCase()} | \`${flag.id}\` | ${loc} | ${flag.message} |`);
    }
  }

  const meaningful = report.files.filter(
    (f) => f.category !== "lockfile" && f.category !== "generated"
  );
  if (meaningful.length > 0) {
    lines.push("", `### Changed Files (${meaningful.length})`, "");
    lines.push("| Category | File | Delta | Symbols |");
    lines.push("|---|---|---|---|");
    for (const f of meaningful) {
      const sym = f.symbols.length > 0 ? f.symbols.slice(0, 4).join(", ") : "-";
      lines.push(
        `| ${f.category} | \`${f.path}\` | \`+${f.additions}/-${f.deletions}\` | ${sym} |`
      );
    }
  }

  const noise = report.files.filter(
    (f) => f.category === "lockfile" || f.category === "generated"
  );
  if (noise.length > 0) {
    lines.push("", `### Summarized Noise (${noise.length})`, "");
    for (const f of noise) {
      lines.push(`- \`${f.path}\` (${f.category}, \`+${f.additions}/-${f.deletions}\`)`);
    }
  }

  if (report.checklist.length > 0) {
    lines.push("", "### Review Checklist", "");
    for (const item of report.checklist) {
      lines.push(`- [ ] ${item}`);
    }
  }

  const hunkSelection = selectHunksWithinBudget(report.files, maxTokens, includeNoise);
  if (hunkSelection.chunks.length > 0) {
    lines.push("", `### Key Hunks (~${hunkSelection.usedTokens} / ${maxTokens} tokens)`, "");
    for (const chunk of hunkSelection.chunks) {
      lines.push(`#### \`${chunk.path}\``, "", "```diff", chunk.body, "```", "");
    }
    if (hunkSelection.omittedFiles > 0) {
      lines.push(`_${hunkSelection.omittedFiles} more file(s) omitted due to token budget._`);
    }
  }

  const body = `${lines.join("\n")}\n`;
  if (report.stats.rawDiffTokens > 0) {
    return `${body}\n_Estimated tokens: ~${estimateTokens(body)} vs raw diff ~${report.stats.rawDiffTokens}._\n`;
  }
  return body;
}

/**
 * Format a DiffBriefReport as JSON (omitting raw hunk arrays to keep payloads lean).
 *
 * @param {import("./analyze.js").DiffBriefReport} report
 * @returns {string}
 */
export function formatJson(report) {
  const serializable = {
    ...report,
    files: report.files.map(({ hunks, ...rest }) => ({
      ...rest,
      hunkCount: hunks.length
    }))
  };
  return `${JSON.stringify(serializable, null, 2)}\n`;
}
