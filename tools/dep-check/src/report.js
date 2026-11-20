// @ts-check

/**
 * @typedef {import("./compare.js").ComparisonResult} ComparisonResult
 */

/**
 * Formats comparison result as human-readable text.
 *
 * @param {ComparisonResult} result
 * @returns {string}
 */
export function formatText(result) {
  const lines = [];

  const hasMissing = result.missingDependencies.length > 0;
  const hasUnusedProd = result.unusedDependencies.length > 0;
  const hasUnusedDev = result.unusedDevDependencies.length > 0;
  const hasMisplaced = result.misplacedDependencies.length > 0;

  const totalIssues =
    result.missingDependencies.length +
    result.unusedDependencies.length +
    result.unusedDevDependencies.length +
    result.misplacedDependencies.length;

  if (totalIssues === 0) {
    return `dep-check: all dependencies look clean (${result.scannedFilesCount} files scanned, ${result.totalImportsCount} imports checked).`;
  }

  lines.push("dep-check found dependency issues:");
  lines.push("");

  // 1. Missing
  if (hasMissing) {
    lines.push(`Missing dependencies (${result.missingDependencies.length}):`);
    lines.push("  These packages are imported in code but not listed in package.json:");
    for (const item of result.missingDependencies) {
      lines.push(`  - ${item.name}`);
      for (const occ of item.occurrences) {
        lines.push(`      ${occ.file}:${occ.line}`);
      }
    }
    lines.push("");
  }

  // 2. Misplaced
  if (hasMisplaced) {
    const devInProd = result.misplacedDependencies.filter((m) => m.reason === "dev-in-prod");
    const prodInDev = result.misplacedDependencies.filter((m) => m.reason === "prod-in-dev-only");

    if (devInProd.length > 0) {
      lines.push(`Misplaced devDependencies (${devInProd.length}):`);
      lines.push("  These packages are listed in devDependencies but imported in production code:");
      for (const item of devInProd) {
        lines.push(`  - ${item.name}`);
        for (const occ of item.occurrences) {
          lines.push(`      ${occ.file}:${occ.line}`);
        }
      }
      lines.push("");
    }

    if (prodInDev.length > 0) {
      lines.push(`Dependencies only used in dev (${prodInDev.length}):`);
      lines.push("  These packages are in dependencies but only imported in test/script files:");
      for (const item of prodInDev) {
        lines.push(`  - ${item.name}`);
        for (const occ of item.occurrences) {
          lines.push(`      ${occ.file}:${occ.line}`);
        }
      }
      lines.push("");
    }
  }

  // 3. Unused Production
  if (hasUnusedProd) {
    lines.push(`Unused dependencies (${result.unusedDependencies.length}):`);
    lines.push("  These packages are in dependencies but never imported anywhere:");
    for (const pkg of result.unusedDependencies) {
      lines.push(`  - ${pkg}`);
    }
    lines.push("");
  }

  // 4. Unused Dev
  if (hasUnusedDev) {
    lines.push(`Unused devDependencies (${result.unusedDevDependencies.length}):`);
    lines.push("  These packages are in devDependencies but never imported in code:");
    for (const pkg of result.unusedDevDependencies) {
      lines.push(`  - ${pkg}`);
    }
    lines.push("");
  }

  lines.push(
    `Summary: ${result.scannedFilesCount} files scanned, ${totalIssues} issue${totalIssues === 1 ? "" : "s"} found.`
  );

  return lines.join("\n");
}

/**
 * Formats comparison result as JSON string.
 *
 * @param {ComparisonResult} result
 * @returns {string}
 */
export function formatJson(result) {
  return JSON.stringify(result, null, 2);
}
