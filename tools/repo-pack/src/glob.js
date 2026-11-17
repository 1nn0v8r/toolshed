// @ts-check
import picomatch from "picomatch";

/**
 * Normalize a user glob: forward slashes on Windows, no leading "./" or "/",
 * no trailing slash.
 * @param {string} pattern
 * @returns {string}
 */
export function normalizePattern(pattern) {
  let s = pattern.trim();
  if (process.platform === "win32") s = s.replace(/\\/g, "/");
  s = s.replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return s;
}

/**
 * True when the text contains glob magic.
 * @param {string} text
 * @returns {boolean}
 */
export function isGlob(text) {
  return picomatch.scan(normalizePattern(text)).isGlob;
}

/**
 * Build a matcher over forward-slash relative paths. Dotfiles match.
 * A pattern without a slash matches a file or folder name at any depth. A
 * pattern with a slash is anchored to the root. A pattern that matches a
 * folder also matches everything below it.
 * @param {string[]} patterns
 * @returns {(relPath: string) => boolean}
 */
export function createMatcher(patterns) {
  const tests = patterns
    .map(normalizePattern)
    .filter((p) => p.length > 0)
    .map((p) => ({ nameOnly: !p.includes("/"), test: picomatch(p, { dot: true }) }));
  return (relPath) => {
    if (tests.length === 0) return false;
    const parts = relPath.split("/");
    for (let end = 1; end <= parts.length; end++) {
      const candidate = parts.slice(0, end).join("/");
      const name = parts[end - 1];
      for (const t of tests) if (t.test(t.nameOnly ? name : candidate)) return true;
    }
    return false;
  };
}
