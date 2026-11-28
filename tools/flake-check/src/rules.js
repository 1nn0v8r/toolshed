// @ts-check

/**
 * @typedef {"error" | "warn"} Severity
 * @typedef {{
 *   id: string,
 *   severity: Severity,
 *   title: string,
 *   description: string,
 *   fix: string,
 * }} RuleDef
 * @typedef {{
 *   ruleId: string,
 *   severity: Severity,
 *   file: string,
 *   line: number,
 *   column: number,
 *   message: string,
 *   snippet: string,
 *   fix: string,
 * }} Finding
 */

/** @type {RuleDef[]} */
export const RULES = [
  {
    id: "flake.focused-test",
    severity: "error",
    title: "Focused test modifier",
    description: "Detects .only(), fit(), fdescribe(), or @pytest.mark.only left in tests.",
    fix: "Remove .only / fit / fdescribe so the full test suite runs in CI.",
  },
  {
    id: "flake.skipped-test",
    severity: "warn",
    title: "Skipped test modifier",
    description: "Detects .skip(), xit(), xdescribe(), @pytest.mark.skip, or t.Skip().",
    fix: "Fix or delete skipped tests instead of silently bypassing assertions.",
  },
  {
    id: "flake.hardcoded-port",
    severity: "warn",
    title: "Hardcoded network port",
    description: "Detects fixed server ports (e.g. .listen(3000)) that collide under parallel test runs.",
    fix: "Bind to ephemeral port 0 (e.g. server.listen(0, '127.0.0.1')) and read server.address().port.",
  },
  {
    id: "flake.arbitrary-sleep",
    severity: "warn",
    title: "Arbitrary sleep / fixed delay",
    description: "Detects fixed sleep waits (setTimeout >= 25ms, time.sleep, waitForTimeout, cy.wait(ms)).",
    fix: "Await an explicit event, promise, condition poll, or fake timer instead of a fixed sleep.",
  },
  {
    id: "flake.wall-clock",
    severity: "warn",
    title: "Unmocked wall-clock access",
    description: "Detects Date.now(), new Date(), time.time(), datetime.now(), or time.Now() without fake timers.",
    fix: "Use fake timers (mock.timers / vi.useFakeTimers / freezegun) or inject a deterministic clock.",
  },
  {
    id: "flake.unseeded-random",
    severity: "warn",
    title: "Unseeded random generator",
    description: "Detects Math.random(), random.*, or Go rand.* calls without an explicit seed or spy.",
    fix: "Use a fixed seed, deterministic test fixture, or stub the RNG in tests.",
  },
  {
    id: "flake.external-network",
    severity: "warn",
    title: "Live external network request",
    description: "Detects HTTP requests to non-local hosts in tests without mocking.",
    fix: "Mock HTTP transport or point tests at a local ephemeral test server (127.0.0.1:0).",
  },
  {
    id: "flake.shared-tmp-path",
    severity: "warn",
    title: "Shared fixed temp path",
    description: "Detects fixed /tmp/<name> or unrandomized os.tmpdir() paths that collide across parallel runs.",
    fix: "Create an isolated directory per test with fs.mkdtempSync(), pytest tmp_path, or t.TempDir().",
  },
];

/** @type {Map<string, RuleDef>} */
export const RULE_MAP = new Map(RULES.map((r) => [r.id, r]));

const SAFE_TEST_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "example.com",
  "example.org",
  "example.net",
]);

/**
 * Return true if the host is local or RFC-reserved for tests/examples.
 * @param {string} host
 * @returns {boolean}
 */
function isSafeTestHost(host) {
  const h = host.toLowerCase();
  if (SAFE_TEST_HOSTS.has(h)) return true;
  return (
    h.endsWith(".example") ||
    h.endsWith(".example.com") ||
    h.endsWith(".example.org") ||
    h.endsWith(".example.net") ||
    h.endsWith(".test") ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".invalid")
  );
}

/**
 * Parse `flake-check-ignore` directives from a line.
 * Returns `"all"` if all rules are ignored, a Set of ignored rule IDs, or `null`.
 * @param {string} line
 * @returns {"all" | Set<string> | null}
 */
function parseIgnoreDirective(line) {
  const m = /(?:\/\/|#)\s*flake-check-ignore(?:\s+([^\r\n*]+))?/i.exec(line);
  if (!m) return null;
  const raw = (m[1] || "").trim();
  if (!raw) return "all";
  const ids = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("flake."));
  return ids.length > 0 ? new Set(ids) : "all";
}

/**
 * Check whether a rule is ignored by inline comment on `line` or `prevLine`.
 * @param {string} ruleId
 * @param {string} line
 * @param {string} prevLine
 * @returns {boolean}
 */
function isLineIgnored(ruleId, line, prevLine) {
  for (const candidate of [line, prevLine]) {
    const parsed = parseIgnoreDirective(candidate);
    if (parsed === "all") return true;
    if (parsed && parsed.has(ruleId)) return true;
  }
  return false;
}

/**
 * Check if a trimmed line is purely a comment line.
 * @param {string} trimmed
 * @returns {boolean}
 */
function isCommentLine(trimmed) {
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("*/")
  );
}

/**
 * Scan test file text for static flakiness patterns.
 * @param {string} content
 * @param {string} filePath
 * @param {{ ignoreRules?: Set<string> }} [options]
 * @returns {Finding[]}
 */
export function scanTextForFlakes(content, filePath, options = {}) {
  const ignored = options.ignoreRules ?? new Set();
  const hasFakeTimers =
    /\b(?:useFakeTimers|mock\.timers|setSystemTime|freeze_time|freezegun|timecop)\b/.test(content);
  const hasSeededRandom =
    /\b(?:random\.seed|seedrandom)\b|spyOn\s*\(\s*Math\s*,\s*["']random["']\s*\)|mock\.method\s*\(\s*Math\s*,\s*["']random["']\s*\)/.test(
      content,
    );

  const lines = content.split(/\r?\n/);
  /** @type {Finding[]} */
  const findings = [];

  /**
   * @param {string} ruleId
   * @param {number} lineNum
   * @param {number} col
   * @param {string} message
   * @param {string} lineText
   * @param {string} prevLineText
   */
  function pushFinding(ruleId, lineNum, col, message, lineText, prevLineText) {
    if (ignored.has(ruleId)) return;
    if (isLineIgnored(ruleId, lineText, prevLineText)) return;
    const def = RULE_MAP.get(ruleId);
    if (!def) return;
    const snippet = lineText.trim().slice(0, 140);
    findings.push({
      ruleId: def.id,
      severity: def.severity,
      file: filePath,
      line: lineNum,
      column: col,
      message,
      snippet,
      fix: def.fix,
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prevLine = i > 0 ? lines[i - 1] : "";
    const trimmed = line.trim();
    const lineNum = i + 1;

    if (!trimmed || isCommentLine(trimmed)) continue;

    // 1. Focused tests
    const focusedMatch =
      /\b(?:it|test|describe|context|suite)\.only\s*\(|\b(?:fit|fdescribe|fcontext)\s*\(|@pytest\.mark\.only\b/.exec(
        line,
      );
    if (focusedMatch) {
      pushFinding(
        "flake.focused-test",
        lineNum,
        focusedMatch.index + 1,
        `Focused test "${focusedMatch[0].replace(/\($/, "")}" skips other tests in CI`,
        line,
        prevLine,
      );
    }

    // 2. Skipped tests
    const skippedMatch =
      /\b(?:it|test|describe|context|suite)\.skip\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|@pytest\.mark\.skip(?:If)?\b|\bt\.Skip(?:f|Now)?\s*\(/.exec(
        line,
      );
    if (skippedMatch) {
      pushFinding(
        "flake.skipped-test",
        lineNum,
        skippedMatch.index + 1,
        `Skipped test "${skippedMatch[0].replace(/\($/, "")}" hides unverified behavior`,
        line,
        prevLine,
      );
    }

    // 3. Hardcoded ports
    const listenMatch = /\.listen\s*\(\s*([1-9]\d{2,4})\b/.exec(line);
    if (listenMatch) {
      pushFinding(
        "flake.hardcoded-port",
        lineNum,
        listenMatch.index + 1,
        `Hardcoded port ${listenMatch[1]} in .listen() can fail with EADDRINUSE in parallel runs`,
        line,
        prevLine,
      );
    } else {
      const portAssignMatch =
        /\b(?:port|PORT)\s*[:=]\s*(300[0-9]|400[0-9]|500[0-9]|800[0-9]|808[0-9]|8888|900[0-9])\b/.exec(
          line,
        );
      if (portAssignMatch) {
        pushFinding(
          "flake.hardcoded-port",
          lineNum,
          portAssignMatch.index + 1,
          `Hardcoded test port ${portAssignMatch[1]} can collide across concurrent runs`,
          line,
          prevLine,
        );
      } else {
        const goListenMatch = /net\.Listen\s*\([^,]+,\s*":([1-9]\d{2,4})"/.exec(line);
        if (goListenMatch) {
          pushFinding(
            "flake.hardcoded-port",
            lineNum,
            goListenMatch.index + 1,
            `Hardcoded port :${goListenMatch[1]} in net.Listen(); prefer ":0"`,
            line,
            prevLine,
          );
        }
      }
    }

    // 4. Arbitrary sleeps
    const setTimeoutMatch = /\bsetTimeout\s*\([^,]+,\s*(\d+)\s*\)/.exec(line);
    if (setTimeoutMatch && Number(setTimeoutMatch[1]) >= 25) {
      pushFinding(
        "flake.arbitrary-sleep",
        lineNum,
        setTimeoutMatch.index + 1,
        `Fixed setTimeout(${setTimeoutMatch[1]}ms) delay risks timing flakiness under load`,
        line,
        prevLine,
      );
    } else {
      const pySleepMatch = /\b(?:time|asyncio)\.sleep\s*\(\s*([0-9]+(?:\.[0-9]+)?)\s*\)/.exec(
        line,
      );
      if (pySleepMatch && Number(pySleepMatch[1]) > 0) {
        pushFinding(
          "flake.arbitrary-sleep",
          lineNum,
          pySleepMatch.index + 1,
          `Fixed sleep(${pySleepMatch[1]}s) in test risks timing flakiness`,
          line,
          prevLine,
        );
      } else {
        const uiWaitMatch =
          /\bpage\.waitForTimeout\s*\(|\bcy\.wait\s*\(\s*\d+\s*\)|\btime\.Sleep\s*\(/.exec(line);
        if (uiWaitMatch) {
          pushFinding(
            "flake.arbitrary-sleep",
            lineNum,
            uiWaitMatch.index + 1,
            `Fixed wait "${uiWaitMatch[0].replace(/\($/, "")}" in test; await an explicit condition instead`,
            line,
            prevLine,
          );
        }
      }
    }

    // 5. Wall-clock access (only if file does not configure fake timers)
    if (!hasFakeTimers) {
      const clockMatch =
        /\bDate\.now\s*\(\s*\)|\bnew\s+Date\s*\(\s*\)|\btime\.time\s*\(\s*\)|\bdatetime\.(?:datetime\.)?(?:now|utcnow|today)\s*\(|\btime\.Now\s*\(\s*\)/.exec(
          line,
        );
      if (clockMatch) {
        pushFinding(
          "flake.wall-clock",
          lineNum,
          clockMatch.index + 1,
          `Unmocked wall-clock call "${clockMatch[0].trim()}" can drift across time/CI environments`,
          line,
          prevLine,
        );
      }
    }

    // 6. Unseeded randomness (only if file does not seed/mock RNG)
    if (!hasSeededRandom) {
      const randMatch =
        /\bMath\.random\s*\(\s*\)|\brandom\.(?:random|randint|choice|shuffle|uniform)\s*\(|\brand\.(?:Intn|Float64|Read)\s*\(/.exec(
          line,
        );
      if (randMatch) {
        pushFinding(
          "flake.unseeded-random",
          lineNum,
          randMatch.index + 1,
          `Unseeded random call "${randMatch[0].trim()}" makes failures hard to reproduce`,
          line,
          prevLine,
        );
      }
    }

    // 7. Live external network calls
    const netMatch =
      /\b(?:fetch|got|axios\.\w+|superagent\.\w+|requests\.(?:get|post|put|delete|patch|head)|httpx\.\w+|urllib\.request\.urlopen|http\.(?:Get|Post))\s*\(\s*["'`](https?:\/\/([^/"'`\s:?]+))/.exec(
        line,
      );
    if (netMatch && !isSafeTestHost(netMatch[2])) {
      pushFinding(
        "flake.external-network",
        lineNum,
        netMatch.index + 1,
        `Live external HTTP call to "${netMatch[2]}" in test`,
        line,
        prevLine,
      );
    }

    // 8. Shared fixed temp paths
    if (!/\b(?:mkdtemp|mkdtempSync|TemporaryDirectory|NamedTemporaryFile|TempDir)\b/.test(line)) {
      const fixedTmpMatch = /["'`]\/tmp\/[a-zA-Z0-9._/-]+["'`]/.exec(line);
      if (fixedTmpMatch && !fixedTmpMatch[0].includes("XXXXXX")) {
        pushFinding(
          "flake.shared-tmp-path",
          lineNum,
          fixedTmpMatch.index + 1,
          `Hardcoded shared temp path ${fixedTmpMatch[0]} can collide in parallel runs`,
          line,
          prevLine,
        );
      } else {
        const osTmpMatch =
          /\bpath\.join\s*\(\s*os\.tmpdir\s*\(\s*\)\s*,\s*["'`][a-zA-Z0-9._-]+["'`]\s*\)/.exec(
            line,
          );
        if (osTmpMatch && !/\b(?:pid|Date|random|uuid)\b/i.test(line)) {
          pushFinding(
            "flake.shared-tmp-path",
            lineNum,
            osTmpMatch.index + 1,
            `Fixed os.tmpdir() path without mkdtempSync() can collide across parallel runs`,
            line,
            prevLine,
          );
        }
      }
    }
  }

  return findings;
}
