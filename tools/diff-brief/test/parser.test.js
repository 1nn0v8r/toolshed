// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { parseUnifiedDiff } from "../src/parser.js";

test("parses modified, added, deleted, renamed, and binary git diffs", () => {
  const sample = [
    "diff --git a/src/app.js b/src/app.js",
    "index 1111111..2222222 100644",
    "--- a/src/app.js",
    "+++ b/src/app.js",
    "@@ -10,3 +10,4 @@ export function greet(name) {",
    "   const clean = name.trim();",
    "-  return 'hi ' + clean;",
    "+  return `hello ${clean}`;",
    "+  // updated",
    " }",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,2 @@",
    "+export const VERSION = 1;",
    "+export function ping() { return true; }",
    "\\ No newline at end of file",
    "diff --git a/old-name.txt b/new-name.txt",
    "similarity index 90%",
    "rename from old-name.txt",
    "rename to new-name.txt",
    "diff --git a/logo.png b/logo.png",
    "new file mode 100644",
    "Binary files /dev/null and b/logo.png differ"
  ].join("\n");

  const files = parseUnifiedDiff(sample);
  assert.equal(files.length, 4);

  assert.equal(files[0].path, "src/app.js");
  assert.equal(files[0].status, "modified");
  assert.equal(files[0].additions, 2);
  assert.equal(files[0].deletions, 1);
  assert.equal(files[0].hunks[0].lines[1].oldLine, 11);
  assert.equal(files[0].hunks[0].lines[2].newLine, 11);
  assert.equal(files[0].hunks[0].lines[3].newLine, 12);

  assert.equal(files[1].path, "src/new.ts");
  assert.equal(files[1].status, "added");
  assert.equal(files[1].additions, 2);

  assert.equal(files[2].path, "new-name.txt");
  assert.equal(files[2].oldPath, "old-name.txt");
  assert.equal(files[2].status, "renamed");

  assert.equal(files[3].path, "logo.png");
  assert.equal(files[3].binary, true);
});

test("parses plain unified diff without diff --git header", () => {
  const plain = [
    "--- a/foo.py",
    "+++ b/foo.py",
    "@@ -1,2 +1,2 @@",
    "-def old_fn():",
    "+def new_fn():",
    "     pass"
  ].join("\n");

  const files = parseUnifiedDiff(plain);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "foo.py");
  assert.equal(files[0].additions, 1);
  assert.equal(files[0].deletions, 1);
});

test("returns empty array for empty diff", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
  assert.deepEqual(parseUnifiedDiff("   \n  "), []);
});
