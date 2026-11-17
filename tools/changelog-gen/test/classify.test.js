// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { categoryFromFirstWord, classify, findBreakingFooter, stripTrailers } from "../src/classify.js";
import { group, renderMarkdown } from "../src/render.js";

/**
 * @param {string} subject
 * @param {string} [body]
 * @param {string[]} [names]
 */
const c = (subject, body = "", names = []) => classify({ hash: "a".repeat(40), short: "aaaaaaa", subject, body }, { names });

test("conventional types map to categories", () => {
  assert.equal(c("feat: x").category, "Added");
  assert.equal(c("fix: x").category, "Fixed");
  assert.equal(c("perf: x").category, "Changed");
  assert.equal(c("refactor: x").category, "Changed");
  assert.equal(c("docs: x").category, "Documentation");
  assert.equal(c("revert: x").category, "Removed");
  assert.equal(c("FEAT: x").category, "Added");
});

test("hidden conventional types", () => {
  for (const t of ["chore", "test", "ci", "build", "style"]) {
    const e = c(`${t}: x`);
    assert.equal(e.hidden, true, t);
    assert.equal(e.category, "Changed");
  }
  assert.equal(c("feat: x").hidden, false);
});

test("breaking via bang, scope bang and footer", () => {
  assert.equal(c("feat!: x").breaking, true);
  assert.equal(c("fix(api)!: x").breaking, true);
  const e = c("feat: x", "details\n\nBREAKING CHANGE: the flag is gone\nuse --new instead");
  assert.equal(e.breaking, true);
  assert.equal(e.breakingNote, "the flag is gone use --new instead");
  assert.equal(c("feat: x", "BREAKING-CHANGE: y").breaking, true);
  assert.equal(c("feat: x", "BREAKING CHANGE:").breakingNote, null);
  assert.equal(c("feat: x", "nothing here").breaking, false);
});

test("a breaking chore is not hidden", () => {
  const e = c("chore!: drop node 18");
  assert.equal(e.hidden, false);
  assert.equal(e.breaking, true);
});

test("conventional scope is kept unless it matches a known name", () => {
  assert.equal(c("feat(parser): add x").subject, "**parser:** add x");
  assert.equal(c("feat(repo-pack): add x", "", ["repo-pack"]).subject, "add x");
  assert.equal(c("feat(Repo-Pack): add x", "", ["repo-pack"]).subject, "add x");
});

test("repo style strips matching prefix and classifies by first word", () => {
  const n = ["repo-pack"];
  assert.deepEqual([c("repo-pack: Add thing", "", n).category, c("repo-pack: Add thing", "", n).subject], ["Added", "Add thing"]);
  assert.equal(c("repo-pack: Create x", "", n).category, "Added");
  assert.equal(c("repo-pack: Introduce x", "", n).category, "Added");
  assert.equal(c("repo-pack: Fix x", "", n).category, "Fixed");
  assert.equal(c("repo-pack: Correct x", "", n).category, "Fixed");
  assert.equal(c("repo-pack: Repair x", "", n).category, "Fixed");
  assert.equal(c("repo-pack: Remove x", "", n).category, "Removed");
  assert.equal(c("repo-pack: Drop x", "", n).category, "Removed");
  assert.equal(c("repo-pack: Delete x", "", n).category, "Removed");
  assert.equal(c("repo-pack: Update x", "", n).category, "Changed");
  assert.equal(c("repo-pack: Dropped x", "", n).category, "Removed");
  assert.equal(c("repo-pack: Adds x", "", n).category, "Added");
  assert.equal(c("repo-pack: Fixed x", "", n).category, "Fixed");
});

test("repo prefix is not stripped when it does not match", () => {
  const e = c("other-tool: Add thing", "", ["repo-pack"]);
  assert.equal(e.subject, "other-tool: Add thing");
  assert.equal(e.category, "Changed");
  assert.equal(c("other-tool: Add thing").subject, "other-tool: Add thing");
});

test("plain subjects use the first word", () => {
  assert.equal(c("Add a thing").category, "Added");
  assert.equal(c("Tidy things").category, "Changed");
  assert.equal(categoryFromFirstWord("  remove old"), "Removed");
  assert.equal(categoryFromFirstWord("123"), "Changed");
  assert.equal(categoryFromFirstWord(""), "Changed");
});

test("unicode subjects survive", () => {
  assert.equal(c("feat: add café support ✓").subject, "add café support ✓");
});

test("trailers are stripped", () => {
  const body = "Some text\n\nCo-Authored-By: A <a@example.com>\nSigned-off-by: B <b@example.com>\nco-authored-by: C <c@example.com>";
  assert.equal(stripTrailers(body), "Some text");
  assert.equal(stripTrailers("x\r\nSigned-off-by: B\r\ny"), "x\ny");
  const e = c("feat: x", "BREAKING CHANGE: gone\nCo-Authored-By: A <a@example.com>");
  assert.equal(e.breakingNote, "gone");
});

test("findBreakingFooter", () => {
  assert.deepEqual(findBreakingFooter("hi"), { found: false, note: null });
  assert.deepEqual(findBreakingFooter("BREAKING CHANGE: a\r\nb\r\n\r\nc"), { found: true, note: "a b" });
});

test("render: fixed section order, empty sections omitted, hashes optional", () => {
  const entries = [c("docs: d"), c("fix: f"), c("feat: a"), c("revert: r"), c("perf: p"), c("feat!: big", "BREAKING CHANGE: note")];
  const md = renderMarkdown({ label: "1.0.0", date: "2026-01-02", entries, hash: true });
  const heads = md.split("\n").filter((l) => l.startsWith("#"));
  assert.deepEqual(heads, ["## 1.0.0 - 2026-01-02", "### Added", "### Changed", "### Fixed", "### Removed", "### Documentation", "### Breaking"]);
  assert.match(md, /- a \(aaaaaaa\)/);
  assert.match(md, /### Breaking\n\n- big: note \(aaaaaaa\)$/);
  const bare = renderMarkdown({ label: "1.0.0", date: "2026-01-02", entries: [c("fix: f")], hash: false });
  assert.equal(bare, "## 1.0.0 - 2026-01-02\n\n### Fixed\n\n- f");
  assert.equal(group([]).breaking.length, 0);
});

