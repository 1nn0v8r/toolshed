// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  clipLines,
  clipText,
  isoDate,
  parseBlamePorcelain,
  parseChurn,
  parseCommitHeader,
  parseContributors,
  parseFileHistory,
  parseLineLog,
  parseNumstatLines,
  redactEmails,
  splitLines,
} from "../src/parse.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("redactEmails hides addresses and keeps other text", () => {
  assert.equal(redactEmails("Zed <zed@example.com> wrote @@ -1 +1 @@"), "Zed <[email hidden]> wrote @@ -1 +1 @@");
  assert.equal(redactEmails("no mail here"), "no mail here");
});

test("clipText and clipLines", () => {
  assert.equal(clipText("abc", 5), "abc");
  assert.equal(clipText("abcdefghij", 6), "abc...");
  assert.deepEqual(clipLines(["a", "b", "c"], 2), { lines: ["a", "b"], dropped: 1 });
  assert.deepEqual(clipLines(["a"], 2), { lines: ["a"], dropped: 0 });
});

test("splitLines accepts LF and CRLF; isoDate is UTC", () => {
  assert.deepEqual(splitLines("a\r\nb\nc"), ["a", "b", "c"]);
  assert.equal(isoDate(1767225600), "2026-01-01");
});

test("parseNumstatLines handles binary, renames and noise", () => {
  const r = parseNumstatLines(["3\t1\tsrc/a b.js", "-\t-\timg.png", "", "garbage", "0\t0\tsrc/{a => b}.js"]);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], { added: 3, deleted: 1, binary: false, path: "src/a b.js" });
  assert.equal(r[1].binary, true);
  assert.equal(r[1].added, 0);
  assert.equal(r[2].path, "src/{a => b}.js");
});

test("parseFileHistory sums stats per commit and tolerates CRLF and empty input", () => {
  assert.deepEqual(parseFileHistory(""), []);
  const out =
    `\0${SHA_A}\x012026-05-01\x01Ann\x01Fix: a\x01b\r\n\r\n2\t1\tf.txt\r\n` + `\0${SHA_B}\x012026-04-01\x01Bo\x01second\n\n-\t-\tf.bin\n1\t0\tg.txt\n`;
  const c = parseFileHistory(out);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0], { sha: "aaaaaaa", date: "2026-05-01", author: "Ann", subject: "Fix: a\x01b", added: 2, deleted: 1 });
  assert.equal(c[1].added, 1);
  assert.equal(c[1].deleted, 0);
});

test("parseBlamePorcelain groups consecutive lines by commit and reuses info", () => {
  const out = [
    `${SHA_A} 1 1 2`,
    "author Ann",
    "author-mail <ann@example.com>",
    "author-time 1767225600",
    "summary first",
    "filename f.txt",
    "\tone\r",
    `${SHA_A} 2 2`,
    "\ttwo",
    `${SHA_B} 3 3 1`,
    "author Bo",
    "author-time 1767312000",
    "summary second",
    "filename f.txt",
    "\tthree",
    `${SHA_A} 4 4 1`,
    "\tfour",
    `${"0".repeat(40)} 5 5 1`,
    "author Not Committed Yet",
    "author-time 1767312000",
    "summary Version of f.txt from f.txt",
    "\tfive",
  ].join("\n");
  const g = parseBlamePorcelain(out);
  assert.equal(g.length, 4);
  assert.deepEqual([g[0].start, g[0].end, g[0].info.sha, g[0].info.author, g[0].info.date], [1, 2, "aaaaaaa", "Ann", "2026-01-01"]);
  assert.deepEqual(g[0].code, ["one", "two"]);
  assert.equal(g[1].info.subject, "second");
  assert.equal(g[2].info.author, "Ann");
  assert.equal(g[2].info.subject, "first");
  assert.equal(g[3].info.uncommitted, true);
  assert.deepEqual(parseBlamePorcelain(""), []);
  assert.deepEqual(parseBlamePorcelain("\torphan code line"), []);
});

test("parseLineLog drops diff metadata and keeps hunks", () => {
  const out =
    `\0${SHA_A}\x012026-05-01\x01Ann\x01subj\n\ndiff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-old\n+new\n\n` +
    `\0${SHA_B}\x012026-04-01\x01Bo\x01s2\r\n\r\n@@ -0,0 +1,1 @@\r\n+x\r\n`;
  const e = parseLineLog(out);
  assert.equal(e.length, 2);
  assert.deepEqual(e[0].patch, ["@@ -1,1 +1,1 @@", "-old", "+new"]);
  assert.deepEqual(e[1].patch, ["@@ -0,0 +1,1 @@", "+x"]);
  assert.equal(e[0].header.startsWith(SHA_A), true);
});

test("parseChurn counts a file once per commit and sorts", () => {
  const out = "\0\n1\t1\ta.js\n2\t0\tb.js\n\0\n1\t1\ta.js\n-\t-\tc.bin\n\0\n5\t5\tb.js\n";
  const rows = parseChurn(out);
  assert.deepEqual(rows[0], { path: "b.js", commits: 2, lines: 12 });
  assert.deepEqual(rows[1], { path: "a.js", commits: 2, lines: 4 });
  assert.deepEqual(rows[2], { path: "c.bin", commits: 1, lines: 0 });
  assert.deepEqual(parseChurn(""), []);
});

test("parseContributors counts names", () => {
  const r = parseContributors("Bo\0\nAnn\0\nBo\0\n\0Cy\0");
  assert.deepEqual(r, [
    { name: "Bo", commits: 2 },
    { name: "Ann", commits: 1 },
    { name: "Cy", commits: 1 },
  ]);
  assert.deepEqual(parseContributors(""), []);
});

test("parseCommitHeader handles root commits, merges and CRLF messages", () => {
  const root = parseCommitHeader(`${SHA_A}\0Ann\0 2026-05-01 10:00:00 +0000\0\0Subject\r\n\r\nBody\r\n`);
  assert.deepEqual(root.parents, []);
  assert.equal(root.message, "Subject\n\nBody");
  const merge = parseCommitHeader(`${SHA_A}\0Ann\0d\0${SHA_B} ${SHA_A}\0Merge`);
  assert.equal(merge.parents.length, 2);
});
