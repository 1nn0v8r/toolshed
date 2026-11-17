// @ts-check
import fs from "node:fs";

export const FIX_HEADER = "# Added by env-check";

/**
 * Build the new text of an example file with the given keys appended (empty values).
 * Existing content and its line ending style are preserved.
 * @param {string} existing current file content ("" for a new file)
 * @param {string[]} keys
 * @returns {string}
 */
export function appendKeys(existing, keys) {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  let out = existing;
  if (out.length > 0 && !out.endsWith("\n")) out += eol;
  if (out.length > 0) out += eol;
  out += FIX_HEADER + eol;
  for (const k of keys) out += `${k}=${eol}`;
  return out;
}

/**
 * Append missing keys to the example file on disk. Does nothing when `keys` is empty.
 * @param {string} file
 * @param {string[]} keys
 * @returns {boolean} true when the file was written
 */
export function fixExampleFile(file, keys) {
  if (keys.length === 0) return false;
  /** @type {string} */
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") throw err;
  }
  fs.writeFileSync(file, appendKeys(existing, keys));
  return true;
}
