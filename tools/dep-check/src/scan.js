// @ts-check
import { builtinModules } from "node:module";

/**
 * Set of built-in Node.js module names.
 */
export const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...(builtinModules.map((m) => `node:${m}`)),
  "node:test",
  "test"
]);

/**
 * Extracts the base package name from an import/require specifier.
 * Returns null if the specifier is relative, absolute, internal, or a runtime built-in.
 *
 * @param {string} specifier
 * @returns {string | null}
 */
export function extractPackageName(specifier) {
  if (!specifier || typeof specifier !== "string") return null;
  const spec = specifier.trim();
  if (!spec) return null;

  // Ignore relative, absolute, or hash-prefixed subpath imports
  if (
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    spec.startsWith("\\") ||
    spec.startsWith("#")
  ) {
    return null;
  }

  // Windows absolute path (e.g. C:\)
  if (/^[a-zA-Z]:/.test(spec)) {
    return null;
  }

  // Runtime prefixes
  if (spec.startsWith("node:") || spec.startsWith("bun:") || spec.startsWith("deno:")) {
    return null;
  }

  // Direct built-in match
  if (NODE_BUILTINS.has(spec)) {
    return null;
  }

  // Scoped package (@scope/package or @scope/package/subpath)
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length >= 2) {
      const scopePkg = `${parts[0]}/${parts[1]}`;
      return scopePkg;
    }
    return null;
  }

  // Normal package name (pkg or pkg/subpath)
  const root = spec.split("/")[0];
  if (NODE_BUILTINS.has(root)) {
    return null;
  }

  return root;
}

/**
 * @typedef {Object} ImportOccurrence
 * @property {string} packageName
 * @property {string} specifier
 * @property {number} line
 */

/**
 * Strips comments from JavaScript/TypeScript code while preserving line numbers.
 * Replaces comment characters with spaces so line counts remain exact.
 *
 * @param {string} code
 * @returns {string}
 */
export function stripCommentsPreservingLines(code) {
  let result = "";
  let i = 0;
  const len = code.length;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < len) {
    const ch = code[i];
    const next = i + 1 < len ? code[i + 1] : "";

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        result += "\n";
      } else {
        result += " ";
      }
      i++;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        result += "  ";
        i += 2;
      } else {
        result += ch === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }

    if (inSingleQuote) {
      result += ch;
      if (ch === "\\" && i + 1 < len) {
        result += next;
        i += 2;
        continue;
      }
      if (ch === "'") inSingleQuote = false;
      i++;
      continue;
    }

    if (inDoubleQuote) {
      result += ch;
      if (ch === "\\" && i + 1 < len) {
        result += next;
        i += 2;
        continue;
      }
      if (ch === '"') inDoubleQuote = false;
      i++;
      continue;
    }

    if (inTemplate) {
      result += ch;
      if (ch === "\\" && i + 1 < len) {
        result += next;
        i += 2;
        continue;
      }
      if (ch === "`") inTemplate = false;
      i++;
      continue;
    }

    // Check for comment start
    if (ch === "/" && next === "/") {
      inLineComment = true;
      result += "  ";
      i += 2;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      result += "  ";
      i += 2;
      continue;
    }

    // String start
    if (ch === "'") inSingleQuote = true;
    else if (ch === '"') inDoubleQuote = true;
    else if (ch === "`") inTemplate = true;

    result += ch;
    i++;
  }

  return result;
}

/**
 * Scans source code content for imported or required package specifiers.
 *
 * @param {string} content
 * @returns {ImportOccurrence[]}
 */
export function scanImports(content) {
  /** @type {ImportOccurrence[]} */
  const occurrences = [];
  const sanitized = stripCommentsPreservingLines(content);

  // Regex patterns to capture import/require specifiers
  // Pattern 1: import ... from "spec" or export ... from "spec"
  // Pattern 2: import "spec"
  // Pattern 3: require("spec") or import("spec") or require.resolve("spec")
  // Pattern 4: jest.mock("spec") or vi.mock("spec")
  const patterns = [
    // import/export ... from '...'
    /(?:import|export)\s+(?:type\s+)?(?:[\w*\s{},$]+from\s+)?['"]([^'"]+)['"]/g,
    // require('...'), import('...'), require.resolve('...')
    /(?:require|import|require\.resolve|jest\.mock|vi\.mock)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];

  for (const regex of patterns) {
    let match;
    while ((match = regex.exec(sanitized)) !== null) {
      const specifier = match[1];
      const pkg = extractPackageName(specifier);
      if (pkg) {
        // Calculate line number
        const preMatch = sanitized.slice(0, match.index);
        const line = preMatch.split("\n").length;
        occurrences.push({
          packageName: pkg,
          specifier,
          line
        });
      }
    }
  }

  return occurrences;
}
