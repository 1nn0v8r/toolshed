// @ts-check
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanTextForFlakes } from "../src/rules.js";
import { parseTestCases, aggregateTestCases } from "../src/parsers.js";
import { computeTimingStats, runStressChecks } from "../src/runner.js";
import { run } from "../src/main.js";

/**
 * Helper to create an isolated temp dir for each test.
 * @param {(dir: string) => Promise<void> | void} fn
 */
async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flake-check-test-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run CLI capturing stdout and stderr.
 * @param {string[]} argv
 * @param {string} cwd
 */
async function runCli(argv, cwd) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    cwd,
    out: (s) => {
      stdout += s;
    },
    err: (s) => {
      stderr += s;
    },
  });
  return { code, stdout, stderr };
}

describe("static flakiness rules", () => {
  it("detects focused and skipped tests", () => {
    const code = [
      `it` + `.only("focuses one test", () => {});`,
      `f` + `describe("suite", () => {});`,
      `it` + `.skip("skips broken check", () => {});`,
      `@pytest.mark.` + `skip(reason="flaky")`,
    ].join("\n");
    const findings = scanTextForFlakes(code, "a.test.js");
    const ids = findings.map((f) => f.ruleId);
    assert.deepEqual(ids, [
      "flake.focused-test",
      "flake.focused-test",
      "flake.skipped-test",
      "flake.skipped-test",
    ]);
    assert.equal(findings[0].severity, "error");
    assert.equal(findings[2].severity, "warn");
  });

  it("flags hardcoded ports while allowing ephemeral port 0", () => {
    const code = [
      `server.` + `listen(0, "127.0.0.1");`,
      `server.` + `listen(3000);`,
      `const opts = { port` + `: 8080 };`,
      `net.` + `Listen("tcp", ":9000")`,
    ].join("\n");
    const findings = scanTextForFlakes(code, "net.test.js");
    assert.equal(findings.length, 3);
    assert.ok(findings.every((f) => f.ruleId === "flake.hardcoded-port"));
    assert.equal(findings[0].line, 2);
  });

  it("flags arbitrary sleeps while allowing microtask 0ms and alias waits", () => {
    const code = [
      `await new Promise((r) => setTimeout(r, 0));`,
      `await new Promise((r) => set` + `Timeout(r, 150));`,
      `time.` + `sleep(0.25)`,
      `await page.` + `waitForTimeout(500);`,
      `cy.` + `wait("@getUser");`,
      `cy.` + `wait(300);`,
    ].join("\n");
    const findings = scanTextForFlakes(code, "wait.test.js");
    assert.equal(findings.length, 4);
    assert.ok(findings.every((f) => f.ruleId === "flake.arbitrary-sleep"));
  });

  it("flags unmocked wall-clock and randomness unless mocked or seeded", () => {
    const unmocked = [
      `const ts = Date.` + `now();`,
      `const d = new ` + `Date();`,
      `const r = Math.` + `random();`,
    ].join("\n");
    const findings = scanTextForFlakes(unmocked, "clock.test.js");
    assert.deepEqual(
      findings.map((f) => f.ruleId),
      ["flake.wall-clock", "flake.wall-clock", "flake.unseeded-random"],
    );

    const mocked = [
      `vi.useFakeTimers();`,
      `vi.spyOn(Math, "random").mockReturnValue(0.5);`,
      `const ts = Date.` + `now();`,
      `const r = Math.` + `random();`,
    ].join("\n");
    assert.deepEqual(scanTextForFlakes(mocked, "clock-mocked.test.js"), []);
  });

  it("flags live external network calls but allows loopback and RFC example hosts", () => {
    const code = [
      `await fetch` + `("http://127.0.0.1:0/health");`,
      `await fetch` + `("https://api.example.com/items");`,
      `await fetch` + `("https://api.github.com/repos/foo/bar");`,
      `requests.` + `get("https://httpbin.org/get")`,
    ].join("\n");
    const findings = scanTextForFlakes(code, "http.test.js");
    assert.equal(findings.length, 2);
    assert.ok(findings.every((f) => f.ruleId === "flake.external-network"));
  });

  it("flags fixed shared temp paths while allowing mkdtempSync", () => {
    const code = [
      `const safe = fs.mkdtempSync(path.join(os.tmpdir(), "app-"));`,
      `fs.writeFileSync("/` + `tmp/shared-lock.json", "{}");`,
      `const bad = path.` + `join(os.tmpdir(), "shared-cache");`,
    ].join("\n");
    const findings = scanTextForFlakes(code, "tmp.test.js");
    assert.equal(findings.length, 2);
    assert.ok(findings.every((f) => f.ruleId === "flake.shared-tmp-path"));
  });

  it("supports inline and previous-line ignore comments and skips comment lines", () => {
    const code = [
      `// server.` + `listen(3000) in comment should not trigger`,
      `server.` + `listen(3000); // flake-check-ignore flake.hardcoded-port`,
      `// flake-check-ignore`,
      `const x = Math.` + `random();`,
    ].join("\n");
    assert.deepEqual(scanTextForFlakes(code, "ignored.test.js"), []);
  });
});

describe("test output parsers and timing stats", () => {
  it("parses TAP, spec, pytest, and go test lines and aggregates flaky cases", () => {
    const run1 = [
      `TAP version 13`,
      `ok 1 - adds numbers`,
      `ok 2 - handles concurrent request`,
      `tests/test_api.py::test_health PASSED [100%]`,
      `--- PASS: TestStore (0.01s)`,
    ].join("\n");
    const run2 = [
      `TAP version 13`,
      `ok 1 - adds numbers`,
      `not ok 2 - handles concurrent request`,
      `tests/test_api.py::test_health FAILED [100%]`,
      `--- PASS: TestStore (0.02s)`,
    ].join("\n");

    const parsed1 = parseTestCases(run1);
    const parsed2 = parseTestCases(run2);
    const agg = aggregateTestCases([parsed1, parsed2]);

    const flakyNames = agg.filter((c) => c.flaky).map((c) => c.name);
    assert.deepEqual(flakyNames, [
      "handles concurrent request",
      "tests/test_api.py::test_health",
    ]);
    assert.equal(agg.find((c) => c.name === "adds numbers")?.flaky, false);
  });

  it("computes min, median, p95, max, and CV%", () => {
    const stats = computeTimingStats([100, 110, 120, 130, 240]);
    assert.equal(stats.minMs, 100);
    assert.equal(stats.medianMs, 120);
    assert.equal(stats.maxMs, 240);
    assert.equal(stats.p95Ms, 240);
    assert.ok(stats.cvPercent > 0);
  });
});

describe("CLI scan and stress runner", () => {
  it("scans a project with .flake-check.json and outputs JSON and SARIF", async () => {
    await withTempDir(async (dir) => {
      fs.mkdirSync(path.join(dir, "test"), { recursive: true });
      fs.mkdirSync(path.join(dir, "test", "fixtures"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "test", "app.test.js"),
        `it` + `.only("broken focus", () => {});\n`,
        "utf8",
      );
      fs.writeFileSync(
        path.join(dir, "test", "fixtures", "bad.test.js"),
        `server.` + `listen(4000);\n`,
        "utf8",
      );
      fs.writeFileSync(
        path.join(dir, ".flake-check.json"),
        JSON.stringify({ ignoreFiles: ["test/fixtures/**"] }),
        "utf8",
      );

      const jsonRes = await runCli(["scan", "--json"], dir);
      assert.equal(jsonRes.code, 1);
      const parsed = JSON.parse(jsonRes.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.scannedFiles, 1);
      assert.equal(parsed.summary.errors, 1);
      assert.equal(parsed.findings[0].ruleId, "flake.focused-test");

      const sarifRes = await runCli(["scan", "--sarif"], dir);
      assert.equal(sarifRes.code, 1);
      const sarif = JSON.parse(sarifRes.stdout);
      assert.equal(sarif.version, "2.1.0");
      assert.equal(sarif.runs[0].results.length, 1);

      const mdRes = await runCli(["scan", "--md"], dir);
      assert.equal(mdRes.code, 1);
      assert.ok(mdRes.stdout.includes("flake-check static scan (FAILED)"));
    });
  });

  it("treats warnings as pass unless --strict is given", async () => {
    await withTempDir(async (dir) => {
      fs.mkdirSync(path.join(dir, "test"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "test", "warn.test.js"),
        `const port ` + `= 8080;\n`,
        "utf8",
      );

      const nonStrict = await runCli(["scan"], dir);
      assert.equal(nonStrict.code, 0);
      assert.ok(nonStrict.stdout.includes("Status: OK"));

      const strict = await runCli(["scan", "--strict"], dir);
      assert.equal(strict.code, 1);
      assert.ok(strict.stdout.includes("Status: FAILED"));
    });
  });

  it("stress-runs passing, failing, and flaky scripts and stops early on flake", async () => {
    await withTempDir(async (dir) => {
      const passScript = path.join(dir, "pass.mjs");
      fs.writeFileSync(
        passScript,
        `console.log("ok 1 - deterministic test");\n`,
        "utf8",
      );

      const passRes = await runCli(
        ["run", "--runs", "3", "--json", "--", process.execPath, passScript],
        dir,
      );
      assert.equal(passRes.code, 0);
      const passJson = JSON.parse(passRes.stdout);
      assert.equal(passJson.verdict, "PASS");
      assert.equal(passJson.passedRuns, 3);

      const failScript = path.join(dir, "fail.mjs");
      fs.writeFileSync(
        failScript,
        `console.log("not ok 1 - always broken"); process.exit(1);\n`,
        "utf8",
      );
      const failRes = await runCli(
        ["run", "--runs", "2", "--json", "--", process.execPath, failScript],
        dir,
      );
      assert.equal(failRes.code, 1);
      const failJson = JSON.parse(failRes.stdout);
      assert.equal(failJson.verdict, "FAIL");
      assert.equal(failJson.failedRuns, 2);

      // Deterministic simulated flake: fails on invocation #2, passes otherwise
      const counterFile = path.join(dir, "count.txt");
      const flakeScript = path.join(dir, "flake.mjs");
      fs.writeFileSync(
        flakeScript,
        [
          `import fs from "node:fs";`,
          `const f = ${JSON.stringify(counterFile)};`,
          `const n = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) + 1 : 1;`,
          `fs.writeFileSync(f, String(n));`,
          `console.log("ok 1 - stable case");`,
          `if (n === 2) { console.log("not ok 2 - race condition case"); process.exit(1); }`,
          `console.log("ok 2 - race condition case");`,
        ].join("\n"),
        "utf8",
      );

      const flakeRes = await runCli(
        [
          "run",
          "--runs",
          "5",
          "--stop-on-flake",
          "--json",
          "--",
          process.execPath,
          flakeScript,
        ],
        dir,
      );
      assert.equal(flakeRes.code, 1);
      const flakeJson = JSON.parse(flakeRes.stdout);
      assert.equal(flakeJson.verdict, "FLAKY");
      assert.equal(flakeJson.stoppedEarly, true);
      assert.equal(flakeJson.completedRuns, 2);
      const flakyCase = flakeJson.testCases.find((/** @type {{ name: string }} */ c) =>
        c.name === "race condition case",
      );
      assert.equal(flakyCase?.flaky, true);
    });
  });

  it("handles run timeouts cleanly", async () => {
    await withTempDir(async (dir) => {
      const slowScript = path.join(dir, "slow.mjs");
      fs.writeFileSync(slowScript, `setInterval(() => {}, 1000);\n`, "utf8");
      const report = await runStressChecks([process.execPath, slowScript], {
        cwd: dir,
        runs: 1,
        jobs: 1,
        timeoutMs: 150,
      });
      assert.equal(report.verdict, "FAIL");
      assert.equal(report.runs[0].timedOut, true);
    });
  });

  it("supports init, rules, help, version, and rejects invalid CLI usage", async () => {
    await withTempDir(async (dir) => {
      const help = await runCli(["--help"], dir);
      assert.equal(help.code, 0);
      assert.ok(help.stdout.includes("flake-check"));

      const ver = await runCli(["--version"], dir);
      assert.equal(ver.code, 0);
      assert.ok(ver.stdout.includes("0.1.0"));

      const rulesRes = await runCli(["rules"], dir);
      assert.equal(rulesRes.code, 0);
      assert.ok(rulesRes.stdout.includes("flake.hardcoded-port"));

      const init1 = await runCli(["init"], dir);
      assert.equal(init1.code, 0);
      assert.ok(fs.existsSync(path.join(dir, ".flake-check.json")));

      const init2 = await runCli(["init"], dir);
      assert.equal(init2.code, 2);

      const badFlag = await runCli(["--not-a-real-flag"], dir);
      assert.equal(badFlag.code, 2);

      const missingCmd = await runCli(["run"], dir);
      assert.equal(missingCmd.code, 2);
    });
  });
});
