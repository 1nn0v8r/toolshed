// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateByDir, fmt, pct, renderTable, sortRows } from "../src/report.js";

test("sortRows orders by tokens then path and does not mutate", () => {
  const input = [
    { path: "b", tokens: 1 },
    { path: "a", tokens: 1 },
    { path: "c", tokens: 9 },
  ];
  assert.deepEqual(sortRows(input).map((r) => r.path), ["c", "a", "b"]);
  assert.equal(input[0].path, "b");
});

test("aggregateByDir groups top-level dirs and root files", () => {
  const rows = [
    { path: "src/a.js", tokens: 5, chars: 20 },
    { path: "src/deep/b.js", tokens: 7, chars: 28 },
    { path: "README.md", tokens: 2, chars: 8 },
    { path: "docs/x.md", tokens: 1, chars: 4 },
  ];
  const agg = sortRows(aggregateByDir(rows));
  assert.deepEqual(agg, [
    { path: "src/", tokens: 12, files: 2 },
    { path: "(root)", tokens: 2, files: 1 },
    { path: "docs/", tokens: 1, files: 1 },
  ]);
});

test("pct handles zero total", () => {
  assert.equal(pct(0, 0), "0.0%");
  assert.equal(pct(1, 4), "25.0%");
  assert.equal(pct(1, 3), "33.3%");
});

test("fmt groups thousands", () => {
  assert.equal(fmt(1234567), "1,234,567");
});

test("renderTable aligns columns and has a header", () => {
  const lines = renderTable([{ path: "a.txt", tokens: 1000 }, { path: "b.txt", tokens: 5 }], 1005);
  assert.match(lines[0], /^tokens\s+share\s+path$/);
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^\s*1,000\s+99\.5%\s+a\.txt$/);
  assert.equal(lines[1].indexOf("a.txt"), lines[2].indexOf("b.txt"));
});

test("renderTable with no rows is just the header", () => {
  assert.equal(renderTable([], 0).length, 1);
});
