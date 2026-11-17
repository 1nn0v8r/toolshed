// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applySection, writeSection } from "../src/write.js";
import { cleanup, makeDir } from "./helpers.js";

const SEC = "## 1.0.0 - 2026-01-01\n\n### Added\n\n- x (abc1234)";
const b = (/** @type {string} */ s) => Buffer.from(s, "utf8");

test("inserts before the first version heading", () => {
  const src = "# Changelog\n\nIntro text.\n\n## 0.1.0 - 2025-01-01\n\n- old\n";
  const { output, action } = applySection(b(src), SEC, "1.0.0");
  assert.equal(action, "inserted");
  assert.equal(output.toString(), `# Changelog\n\nIntro text.\n\n${SEC}\n\n## 0.1.0 - 2025-01-01\n\n- old\n`);
});

test("replaces an Unreleased section", () => {
  const src = "# Changelog\n\n## Unreleased\n\n- stale\n\n## 0.1.0 - 2025-01-01\n\n- old\n";
  const sec = "## Unreleased - 2026-01-01\n\n### Fixed\n\n- y";
  const { output, action } = applySection(b(src), sec, "Unreleased");
  assert.equal(action, "replaced");
  assert.equal(output.toString(), `# Changelog\n\n${sec}\n\n## 0.1.0 - 2025-01-01\n\n- old\n`);
});

test("replaces [Unreleased] and dated Unreleased headings, case-insensitive label", () => {
  for (const h of ["## [Unreleased]", "## unreleased - 2025-01-01"]) {
    const src = `# C\n\n${h}\n\n- stale\n\n## 0.1.0\n\n- old\n`;
    const { output, action } = applySection(b(src), "## Unreleased - 2026-01-01\n\n- n", "unreleased");
    assert.equal(action, "replaced");
    assert.ok(!output.toString().includes("stale"));
    assert.ok(output.toString().includes("## 0.1.0\n\n- old\n"));
  }
});

test("replaces Unreleased at the end of the file without extra blank line", () => {
  const src = "# C\n\n## 0.1.0\n\n- old\n\n## Unreleased\n\n- stale\n";
  const { output } = applySection(b(src), "## Unreleased - 2026-01-01\n\n- n", "Unreleased");
  assert.equal(output.toString(), "# C\n\n## 0.1.0\n\n- old\n\n## Unreleased - 2026-01-01\n\n- n\n");
});

test("Unreleased label without an existing Unreleased section inserts", () => {
  const src = "# C\n\n## 0.1.0\n\n- old\n";
  const { action } = applySection(b(src), "## Unreleased - 2026-01-01\n\n- n", "Unreleased");
  assert.equal(action, "inserted");
});

test("a non-Unreleased label leaves an existing Unreleased section alone", () => {
  const src = "# C\n\n## Unreleased\n\n- keep\n";
  const { output } = applySection(b(src), SEC, "1.0.0");
  assert.equal(output.toString(), `# C\n\n${SEC}\n\n## Unreleased\n\n- keep\n`);
});

test("CRLF files stay CRLF and the rest is byte for byte", () => {
  const src = "# Changelog\r\n\r\nIntro\r\n\r\n## 0.1.0 - 2025-01-01\r\n\r\n- old é\r\n";
  const { output } = applySection(b(src), SEC, "1.0.0");
  const out = output.toString();
  assert.equal(out, `# Changelog\r\n\r\nIntro\r\n\r\n${SEC.replace(/\n/g, "\r\n")}\r\n\r\n## 0.1.0 - 2025-01-01\r\n\r\n- old é\r\n`);
  assert.ok(!/(^|[^\r])\n/.test(out), "no bare LF");
});

test("CRLF Unreleased replacement", () => {
  const src = "# C\r\n\r\n## Unreleased\r\n\r\n- stale\r\n\r\n## 0.1.0\r\n\r\n- old\r\n";
  const { output } = applySection(b(src), "## Unreleased - 2026-01-01\n\n- n", "Unreleased");
  assert.equal(output.toString(), "# C\r\n\r\n## Unreleased - 2026-01-01\r\n\r\n- n\r\n\r\n## 0.1.0\r\n\r\n- old\r\n");
});

test("non-UTF-8 bytes and a BOM elsewhere in the file are preserved", () => {
  const head = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b("# C\n\n")]);
  const tail = Buffer.concat([b("## 0.1.0\n\n- "), Buffer.from([0xff, 0xfe]), b("\n")]);
  const { output } = applySection(Buffer.concat([head, tail]), SEC, "1.0.0");
  assert.ok(output.subarray(0, head.length).equals(head));
  assert.ok(output.subarray(output.length - tail.length).equals(tail));
});

test("appends when there are no version headings", () => {
  assert.equal(applySection(b("# Changelog\n"), SEC, "1.0.0").output.toString(), `# Changelog\n\n${SEC}\n`);
  assert.equal(applySection(b("# Changelog\n\n"), SEC, "1.0.0").output.toString(), `# Changelog\n\n${SEC}\n`);
  assert.equal(applySection(b("# Changelog"), SEC, "1.0.0").output.toString(), `# Changelog\n\n${SEC}\n`);
  assert.equal(applySection(b(""), SEC, "1.0.0").output.toString(), `${SEC}\n`);
  const crlf = applySection(b("# C\r\n"), "## v\n\n- a", "v");
  assert.equal(crlf.output.toString(), "# C\r\n\r\n## v\r\n\r\n- a\r\n");
  assert.equal(crlf.action, "appended");
});

test("new file is created with a title", () => {
  const { output, action } = applySection(null, SEC, "1.0.0");
  assert.equal(action, "created");
  assert.equal(output.toString(), `# Changelog\n\n${SEC}\n`);
});

test("writeSection reads and writes files, creating missing ones", () => {
  const dir = makeDir();
  try {
    const file = path.join(dir, "CHANGELOG.md");
    assert.equal(writeSection(file, SEC, "1.0.0"), "created");
    assert.equal(writeSection(file, "## 1.1.0 - 2026-02-01\n\n- z", "1.1.0"), "inserted");
    assert.match(fs.readFileSync(file, "utf8"), /# Changelog\n\n## 1\.1\.0[\s\S]*## 1\.0\.0/);
    assert.throws(() => writeSection(dir, SEC, "1.0.0"), /EISDIR|EPERM|EACCES/);
  } finally {
    cleanup(dir);
  }
});
