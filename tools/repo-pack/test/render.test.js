// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { buildTree, cdata, escapeAttr, fenceFor, renderMarkdown, renderXml } from "../src/render.js";

test("fenceFor picks a fence longer than any backtick run", () => {
  assert.equal(fenceFor("plain"), "```");
  assert.equal(fenceFor("a ``` b"), "````");
  assert.equal(fenceFor("`````x"), "``````");
  assert.equal(fenceFor("`one`"), "```");
});

test("buildTree nests folders first and sorts", () => {
  const tree = buildTree(["b.js", "src/z.js", "src/a/x.js", "a.js"]);
  assert.equal(
    tree,
    ["|-- src/", "|   |-- a/", "|   |   `-- x.js", "|   `-- z.js", "|-- a.js", "`-- b.js"].join("\n"),
  );
});

test("buildTree of nothing is empty", () => {
  assert.equal(buildTree([]), "");
});

test("escapeAttr and cdata", () => {
  assert.equal(escapeAttr(`a&b<c>"d"'e'`), "a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;");
  assert.equal(cdata("plain"), "<![CDATA[plain]]>");
  assert.equal(cdata("a]]>b"), "<![CDATA[a]]]]><![CDATA[>b]]>");
  assert.equal(cdata("]]>]]>"), "<![CDATA[]]]]><![CDATA[>]]]]><![CDATA[>]]>");
});

/** @param {Partial<Parameters<typeof renderMarkdown>[0]>} over */
const input = (over = {}) => ({
  rootName: "demo",
  files: [
    { path: "src/a.js", text: "let a = 1;\n", tokens: 3 },
    { path: "README.md", text: "# hi\n```js\nx\n```\n", tokens: 5 },
  ],
  omitted: [],
  totalTokens: 8,
  maxTokens: null,
  ...over,
});

test("markdown: header, tree, tagged fences, content fences cannot be broken", () => {
  const md = renderMarkdown(input());
  assert.match(md, /^# Repo pack: demo\n/);
  assert.match(md, /- Files: 2\n/);
  assert.match(md, /- Estimated tokens: 8 \(estimate: ceil\(characters \/ 4\)/);
  assert.doesNotMatch(md, /Token budget/);
  assert.match(md, /## File tree\n\n```text\n/);
  assert.match(md, /### src\/a\.js\n\n```js\nlet a = 1;\n```\n/);
  assert.match(md, /### README\.md\n\n````md\n# hi\n```js\nx\n```\n````\n/);
});

test("markdown: budget and left-out sections", () => {
  const md = renderMarkdown(input({ maxTokens: 10, omitted: [{ path: "big.js", tokens: 99 }] }));
  assert.match(md, /- Token budget: 10/);
  assert.match(md, /- Left out \(over budget\): 1/);
  assert.match(md, /## Left out \(over budget\)\n\n- big\.js \(about 99 tokens\)/);
});

test("markdown: empty file and file without trailing newline", () => {
  const md = renderMarkdown(
    input({
      files: [
        { path: "empty.txt", text: "", tokens: 0 },
        { path: "x.js", text: "no newline", tokens: 3 },
      ],
    }),
  );
  assert.match(md, /### empty\.txt\n\n```text\n```\n/);
  assert.match(md, /```js\nno newline\n```\n/);
});

test("markdown: unknown extension gets a bare fence", () => {
  const md = renderMarkdown(input({ files: [{ path: "thing.zzz", text: "q\n", tokens: 1 }] }));
  assert.match(md, /### thing\.zzz\n\n```\nq\n```/);
});

test("xml: structure, attributes, CDATA escaping", () => {
  const xml = renderXml(
    input({
      rootName: 'we"ird',
      files: [{ path: "a&b/x.js", text: "if (a]]>b) {}\n", tokens: 4 }],
      omitted: [{ path: "o.js", tokens: 7 }],
      maxTokens: 50,
    }),
  );
  assert.match(xml, /^<repo-pack root="we&quot;ird" files="1" estimated-tokens="8" max-tokens="50">\n/);
  assert.match(xml, /<tree><!\[CDATA\[/);
  assert.match(xml, /<omitted path="o\.js" estimated-tokens="7"\/>/);
  assert.match(
    xml,
    /<file path="a&amp;b\/x\.js" language="js" estimated-tokens="4"><!\[CDATA\[if \(a\]\]\]\]><!\[CDATA\[>b\) \{\}\n\]\]><\/file>/,
  );
  assert.ok(xml.endsWith("</repo-pack>\n"));
});

test("xml: no language attribute for unknown extensions, no max-tokens when unset", () => {
  const xml = renderXml(input({ files: [{ path: "q.zzz", text: "", tokens: 0 }] }));
  assert.match(xml, /<file path="q\.zzz" estimated-tokens="0">/);
  assert.doesNotMatch(xml, /max-tokens/);
});
