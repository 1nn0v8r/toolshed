// @ts-check

/**
 * @typedef {"passed" | "failed" | "skipped"} TestOutcome
 * @typedef {{ name: string, status: TestOutcome }} ParsedTestCase
 * @typedef {{
 *   name: string,
 *   runs: number,
 *   passed: number,
 *   failed: number,
 *   skipped: number,
 *   flaky: boolean,
 * }} AggregatedTestCase
 */

const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

/**
 * Strip ANSI color codes from runner output.
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  return text.replace(ANSI_RE, "");
}

/**
 * Parse per-test outcomes from combined stdout/stderr across common runners
 * (TAP / node --test, Jest, Vitest, pytest -v, go test -v).
 * @param {string} output
 * @returns {ParsedTestCase[]}
 */
export function parseTestCases(output) {
  const clean = stripAnsi(output);
  const lines = clean.split(/\r?\n/);
  /** @type {Map<string, TestOutcome>} */
  const cases = new Map();

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 1. TAP v13/v14 (node --test TAP reporter, tape, tap)
    const tapMatch = /^(not ok|ok)\s+\d+\s+-\s+(.+)$/.exec(trimmed);
    if (tapMatch) {
      const ok = tapMatch[1] === "ok";
      let name = tapMatch[2].trim();
      const directiveMatch = /\s+#\s*(SKIP|TODO)\b.*$/i.exec(name);
      if (directiveMatch) {
        name = name.slice(0, directiveMatch.index).trim();
        if (name && !cases.has(name)) {
          cases.set(name, "skipped");
        }
        continue;
      }
      if (name) {
        // Skip TAP subtest group summary if leaf subtests already exist? Keep distinct names.
        cases.set(name, ok ? "passed" : "failed");
      }
      continue;
    }

    // 2. node --test spec reporter / Jest / Vitest test lines: "✔ name (1.2ms)" or "✖ name (1.2ms)"
    const specMatch = /^([✔✓√✖✕×])\s+(.+?)(?:\s+\([0-9.]+\s*m?s\))?$/.exec(trimmed);
    if (specMatch) {
      const symbol = specMatch[1];
      const name = specMatch[2].trim();
      if (name) {
        const passed = symbol === "✔" || symbol === "✓" || symbol === "√";
        cases.set(name, passed ? "passed" : "failed");
      }
      continue;
    }

    // 3. pytest -v lines: "tests/test_api.py::test_login PASSED [ 50%]"
    const pytestMatch = /^([^\s]+::[^\s]+)\s+(PASSED|FAILED|ERROR|SKIPPED)\b/.exec(trimmed);
    if (pytestMatch) {
      const name = pytestMatch[1];
      const verdict = pytestMatch[2];
      const status =
        verdict === "PASSED" ? "passed" : verdict === "SKIPPED" ? "skipped" : "failed";
      cases.set(name, status);
      continue;
    }

    // 4. go test -v lines: "--- PASS: TestFoo (0.01s)" or "--- FAIL: TestFoo (0.01s)"
    const goMatch = /^---\s+(PASS|FAIL|SKIP):\s+([^\s(]+)/.exec(trimmed);
    if (goMatch) {
      const verdict = goMatch[1];
      const name = goMatch[2];
      const status =
        verdict === "PASS" ? "passed" : verdict === "SKIP" ? "skipped" : "failed";
      cases.set(name, status);
    }
  }

  return [...cases.entries()].map(([name, status]) => ({ name, status }));
}

/**
 * Aggregate per-test-case outcomes across multiple runs.
 * @param {ParsedTestCase[][]} runCases
 * @returns {AggregatedTestCase[]}
 */
export function aggregateTestCases(runCases) {
  /** @type {Map<string, { passed: number, failed: number, skipped: number }>} */
  const map = new Map();

  for (const cases of runCases) {
    for (const c of cases) {
      let entry = map.get(c.name);
      if (!entry) {
        entry = { passed: 0, failed: 0, skipped: 0 };
        map.set(c.name, entry);
      }
      if (c.status === "passed") entry.passed += 1;
      else if (c.status === "failed") entry.failed += 1;
      else entry.skipped += 1;
    }
  }

  /** @type {AggregatedTestCase[]} */
  const result = [];
  for (const [name, counts] of map.entries()) {
    const runs = counts.passed + counts.failed + counts.skipped;
    result.push({
      name,
      runs,
      passed: counts.passed,
      failed: counts.failed,
      skipped: counts.skipped,
      flaky: counts.passed > 0 && counts.failed > 0,
    });
  }

  result.sort((a, b) => {
    if (a.flaky !== b.flaky) return a.flaky ? -1 : 1;
    if (a.failed !== b.failed) return b.failed - a.failed;
    return a.name.localeCompare(b.name);
  });

  return result;
}
