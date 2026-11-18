// @ts-check

/**
 * Priority tiers, lowest number first:
 *   0 docs    README files (any depth), and .md/.mdx/.rst/.adoc files at the
 *             root or inside a docs/doc/documentation folder
 *   1 config  well-known config files and root-level dotfiles or
 *             json/yaml/toml/ini files
 *   2 source  everything else
 *   3 tests   files in test/tests/__tests__/spec/specs/e2e folders, or named
 *             *.test.*, *.spec.*, *_test.*, test_*.*
 * Tests are checked first, so a README inside a tests folder is a test.
 * Within a tier: fewer path segments first, then plain path order (UTF-16
 * code unit comparison, so the result never depends on locale).
 */
export const TIER_NAMES = ["docs", "config", "source", "tests"];

const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e"]);
const DOC_DIRS = new Set(["docs", "doc", "documentation"]);
const DOC_EXT = /\.(md|mdx|rst|adoc)$/i;
const CONFIG_NAMES = new Set([
  "package.json", "pyproject.toml", "setup.py", "setup.cfg", "cargo.toml", "go.mod",
  "gemfile", "makefile", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json",
  "deno.json", "deno.jsonc", "tox.ini", "pubspec.yaml", "mix.exs",
]);
const CONFIG_PATTERNS = [
  /^tsconfig(\..+)?\.json$/,
  /^jsconfig(\..+)?\.json$/,
  /^requirements.*\.txt$/,
  /^dockerfile(\..+)?$/,
  /^docker-compose(\..+)?\.ya?ml$/,
  /^compose(\..+)?\.ya?ml$/,
  /\.config\.(js|mjs|cjs|ts|mts|cts|json)$/,
];
const ROOT_CONFIG_EXT = /\.(json|jsonc|ya?ml|toml|ini|cfg|conf)$/i;

/**
 * @param {string} relPath forward-slash relative path
 * @param {((p: string) => number) | null} [priorityMatcher]
 * @returns {number} tier index (-1 for priority matches, 0..3 otherwise)
 */
export function tierOf(relPath, priorityMatcher = null) {
  if (priorityMatcher && priorityMatcher(relPath) >= 0) {
    return -1;
  }
  const parts = relPath.split("/");
  const base = parts[parts.length - 1];
  const lower = base.toLowerCase();
  const dirs = parts.slice(0, -1).map((d) => d.toLowerCase());

  if (
    dirs.some((d) => TEST_DIRS.has(d)) ||
    /\.(test|spec)\.[^.]+$/.test(lower) ||
    /_test\.[^.]+$/.test(lower) ||
    /^test_.+\.[^.]+$/.test(lower)
  ) {
    return 3;
  }
  if (/^readme(\.|$)/.test(lower)) return 0;
  if (DOC_EXT.test(lower) && (dirs.length === 0 || dirs.some((d) => DOC_DIRS.has(d)))) return 0;
  if (CONFIG_NAMES.has(lower) || CONFIG_PATTERNS.some((re) => re.test(lower))) return 1;
  if (dirs.length === 0 && (lower.startsWith(".") || ROOT_CONFIG_EXT.test(lower))) return 1;
  return 2;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deterministic priority order. Does not mutate the input.
 * @template {{path: string}} T
 * @param {T[]} items
 * @param {((p: string) => number) | null} [priorityMatcher]
 * @returns {T[]}
 */
export function sortByPriority(items, priorityMatcher = null) {
  return [...items].sort((x, y) => {
    const tx = tierOf(x.path, priorityMatcher);
    const ty = tierOf(y.path, priorityMatcher);
    if (tx !== ty) return tx - ty;
    if (tx === -1 && priorityMatcher) {
      const px = priorityMatcher(x.path);
      const py = priorityMatcher(y.path);
      if (px !== py) return px - py;
    }
    const d = x.path.split("/").length - y.path.split("/").length;
    if (d !== 0) return d;
    return comparePaths(x.path, y.path);
  });
}

/**
 * Plain path order. Does not mutate the input.
 * If priorityMatcher is provided, priority matches appear first.
 * @template {{path: string}} T
 * @param {T[]} items
 * @param {((p: string) => number) | null} [priorityMatcher]
 * @returns {T[]}
 */
export function sortByPath(items, priorityMatcher = null) {
  if (!priorityMatcher) {
    return [...items].sort((x, y) => comparePaths(x.path, y.path));
  }
  return [...items].sort((x, y) => {
    const px = priorityMatcher(x.path);
    const py = priorityMatcher(y.path);
    const hasX = px >= 0;
    const hasY = py >= 0;
    if (hasX && !hasY) return -1;
    if (!hasX && hasY) return 1;
    if (hasX && hasY && px !== py) return px - py;
    return comparePaths(x.path, y.path);
  });
}
