// @ts-check
import fs from "node:fs";

/**
 * @typedef {{kind: "ok", content: string} | {kind: "skip", code: string, reason: string} | {kind: "ignore"}} ReadResult
 */

const BINARY_SNIFF_BYTES = 8192;

/**
 * Read a file for packing. Skips (with a reason) symlinks, files over
 * maxSize bytes, binary files (NUL byte in the first 8 KB) and files that are
 * not valid UTF-8. Strips a BOM and normalizes CRLF to LF.
 * @param {string} abs
 * @param {number} maxSize
 * @returns {Promise<ReadResult>}
 */
export async function readForPack(abs, maxSize) {
  let st;
  try {
    st = await fs.promises.lstat(abs);
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    if (code === "ENOENT") return { kind: "skip", code: "missing", reason: "missing on disk" };
    return { kind: "skip", code: "unreadable", reason: "unreadable" };
  }
  if (st.isSymbolicLink()) return { kind: "skip", code: "symlink", reason: "symlink" };
  if (st.isDirectory()) return { kind: "ignore" };
  if (!st.isFile()) return { kind: "skip", code: "special", reason: "not a regular file" };
  if (st.size > maxSize) {
    return {
      kind: "skip",
      code: "too-large",
      reason: `too large (${st.size} bytes, limit ${maxSize})`,
    };
  }
  let buf;
  try {
    buf = await fs.promises.readFile(abs);
  } catch {
    return { kind: "skip", code: "unreadable", reason: "unreadable" };
  }
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { kind: "skip", code: "binary", reason: "binary" };
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return { kind: "skip", code: "not-utf8", reason: "not valid UTF-8" };
  }
  return { kind: "ok", content: text.replace(/\r\n/g, "\n") };
}

/**
 * Prefix each line with its number. A trailing newline does not create an
 * extra numbered line.
 * @param {string} text
 * @returns {string}
 */
export function addLineNumbers(text) {
  if (text === "") return text;
  const endsWithNewline = text.endsWith("\n");
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split("\n");
  const width = String(lines.length).length;
  const numbered = lines.map((l, i) => `${String(i + 1).padStart(width, " ")} | ${l}`);
  return numbered.join("\n") + (endsWithNewline ? "\n" : "");
}
