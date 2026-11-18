// @ts-check
import { parseCargo } from "./parsers/cargo.js";
import { parseEslint } from "./parsers/eslint.js";
import { parsePython } from "./parsers/python.js";
import { parseTsc } from "./parsers/tsc.js";

/**
 * @typedef {import('./parsers/tsc.js').Diagnostic} Diagnostic
 */

/**
 * Parse diagnostics using a specified preset or auto-detection.
 * @param {string} text
 * @param {'auto' | 'tsc' | 'eslint' | 'python' | 'cargo'} [preset='auto']
 * @returns {Diagnostic[]}
 */
export function parseWithPreset(text, preset = "auto") {
  if (preset === "tsc") return parseTsc(text);
  if (preset === "eslint") return parseEslint(text);
  if (preset === "python") return parsePython(text);
  if (preset === "cargo") return parseCargo(text);

  // Auto-detect based on text signatures
  if (/TS[0-9]+:/.test(text)) return parseTsc(text);
  if (/-->\s*.*\.rs:[0-9]+:[0-9]+/.test(text)) return parseCargo(text);
  if (/report[A-Z][A-Za-z]+|\.py:[0-9]+:/.test(text)) return parsePython(text);
  if (text.trim().startsWith("[") || /line\s*[0-9]+,\s*col\s*[0-9]+/i.test(text)) {
    return parseEslint(text);
  }

  // Fallback: try tsc, then python, then eslint
  const tscResult = parseTsc(text);
  if (tscResult.length > 0) return tscResult;

  const pyResult = parsePython(text);
  if (pyResult.length > 0) return pyResult;

  return parseEslint(text);
}
