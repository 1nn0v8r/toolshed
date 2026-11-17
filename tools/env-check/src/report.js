// @ts-check

const MAX_LOCATIONS = 5;

/**
 * @typedef {import("./check.js").UsedVar} UsedVar
 * @typedef {import("./check.js").Location} Location
 * @typedef {{
 *   dir: string,
 *   example: { file: string, found: boolean },
 *   envFile: { file: string, found: boolean } | null,
 *   scannedFiles: number,
 *   skippedLargeFiles: number,
 *   mode: "git" | "walk",
 *   strict: boolean,
 *   missing: UsedVar[],
 *   unused: string[],
 *   missingInEnv: string[],
 *   dynamic: Location[],
 *   fixed: string[],
 *   ok: boolean,
 * }} Result
 */

/** @param {Location[]} locs */
function formatLocations(locs) {
  const shown = locs.slice(0, MAX_LOCATIONS).map((l) => `${l.file}:${l.line}`);
  const extra = locs.length - shown.length;
  return shown.join(", ") + (extra > 0 ? ` (+${extra} more)` : "");
}

/**
 * Human-readable report. Only key names and file locations appear, never values.
 * @param {Result} r
 * @returns {string}
 */
export function formatText(r) {
  /** @type {string[]} */
  const out = [];
  out.push(`env-check: scanned ${r.scannedFiles} file${r.scannedFiles === 1 ? "" : "s"} (${r.mode === "git" ? "git" : "directory walk"})`);
  if (!r.example.found && r.fixed.length === 0) out.push(`Note: ${r.example.file} was not found, so nothing is documented yet.`);

  if (r.missing.length > 0) {
    out.push("", `Used in code but missing from ${r.example.file} (${r.missing.length}):`);
    for (const m of r.missing) out.push(`  ${m.name}  ${formatLocations(m.locations)}`);
  }
  if (r.fixed.length > 0) {
    out.push("", `Added to ${r.example.file} (${r.fixed.length}): ${r.fixed.join(", ")}`);
  }
  if (r.unused.length > 0) {
    out.push("", `In ${r.example.file} but never used in code (${r.unused.length}${r.strict ? ", error in strict mode" : ""}):`);
    for (const k of r.unused) out.push(`  ${k}`);
  }
  if (r.envFile && r.missingInEnv.length > 0) {
    out.push("", `In ${r.example.file} but missing from ${r.envFile.file} (${r.missingInEnv.length}):`);
    for (const k of r.missingInEnv) out.push(`  ${k}`);
  }
  if (r.dynamic.length > 0) {
    out.push("", `${r.dynamic.length} dynamic read${r.dynamic.length === 1 ? "" : "s"} that could not be checked: ${formatLocations(r.dynamic)}`);
  }
  if (r.skippedLargeFiles > 0) {
    out.push("", `Skipped ${r.skippedLargeFiles} file${r.skippedLargeFiles === 1 ? "" : "s"} larger than 2 MB.`);
  }
  out.push("", r.ok ? "OK" : "Problems found.");
  return out.join("\n") + "\n";
}

/**
 * @param {Result} r
 * @returns {string}
 */
export function formatJson(r) {
  const { dynamic, ...rest } = r;
  return JSON.stringify({ ...rest, dynamic: { count: dynamic.length, locations: dynamic } }, null, 2) + "\n";
}
