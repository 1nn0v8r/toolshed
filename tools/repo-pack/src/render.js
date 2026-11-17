// @ts-check
import { languageFor } from "./language.js";

/**
 * @typedef {object} PackedFile
 * @property {string} path forward-slash path relative to the root
 * @property {string} text content to print (LF endings, line numbers applied)
 * @property {number} tokens estimated tokens of `text`
 */

/**
 * @typedef {object} RenderInput
 * @property {string} rootName
 * @property {PackedFile[]} files in output order
 * @property {{path: string, tokens: number}[]} omitted left out because of the budget
 * @property {number} totalTokens
 * @property {number | null} maxTokens
 */

/**
 * Fence long enough that the content cannot close it: one backtick longer
 * than the longest backtick run in the content, minimum three.
 * @param {string} text
 * @returns {string}
 */
export function fenceFor(text) {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Render a plain ASCII tree of forward-slash paths. Folders first, then
 * files, each in code unit order.
 * @param {string[]} paths
 * @returns {string}
 */
export function buildTree(paths) {
  /** @typedef {{dirs: Map<string, Node>, files: string[]}} Node */
  /** @returns {Node} */
  const mk = () => ({ dirs: new Map(), files: [] });
  const root = mk();
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      let next = node.dirs.get(dir);
      if (!next) {
        next = mk();
        node.dirs.set(dir, next);
      }
      node = next;
    }
    node.files.push(parts[parts.length - 1]);
  }
  /** @type {string[]} */
  const lines = [];
  /**
   * @param {Node} node
   * @param {string} prefix
   */
  const walk = (node, prefix) => {
    const dirNames = [...node.dirs.keys()].sort();
    const fileNames = [...node.files].sort();
    const entries = [
      ...dirNames.map((n) => ({ name: `${n}/`, child: node.dirs.get(n) })),
      ...fileNames.map((n) => ({ name: n, child: undefined })),
    ];
    entries.forEach((e, i) => {
      const last = i === entries.length - 1;
      lines.push(`${prefix}${last ? "`-- " : "|-- "}${e.name}`);
      if (e.child) walk(e.child, prefix + (last ? "    " : "|   "));
    });
  };
  walk(root, "");
  return lines.join("\n");
}

/**
 * @param {string} s
 * @returns {string}
 */
export function escapeAttr(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Wrap text in CDATA, splitting any "]]>" in the text across two sections.
 * @param {string} s
 * @returns {string}
 */
export function cdata(s) {
  return `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

/**
 * @param {string} s
 * @returns {string}
 */
function withTrailingNewline(s) {
  return s.endsWith("\n") ? s : `${s}\n`;
}

/**
 * @param {RenderInput} input
 * @returns {string}
 */
export function renderMarkdown(input) {
  const { rootName, files, omitted, totalTokens, maxTokens } = input;
  const out = [];
  out.push(`# Repo pack: ${rootName}`, "");
  out.push(`- Files: ${files.length}`);
  out.push(
    `- Estimated tokens: ${totalTokens} (estimate: ceil(characters / 4), file contents only, not an exact tokenizer count)`,
  );
  if (maxTokens !== null) out.push(`- Token budget: ${maxTokens}`);
  if (omitted.length > 0) out.push(`- Left out (over budget): ${omitted.length}`);
  out.push("");

  const tree = buildTree(files.map((f) => f.path));
  const treeFence = fenceFor(tree);
  out.push("## File tree", "", `${treeFence}text`, tree, treeFence, "");

  if (omitted.length > 0) {
    out.push("## Left out (over budget)", "");
    for (const o of omitted) out.push(`- ${o.path} (about ${o.tokens} tokens)`);
    out.push("");
  }

  out.push("## Files", "");
  for (const f of files) {
    const fence = fenceFor(f.text);
    out.push(`### ${f.path}`, "");
    out.push(`${fence}${languageFor(f.path)}`);
    if (f.text !== "") out.push(withTrailingNewline(f.text).slice(0, -1));
    out.push(fence, "");
  }
  return `${out.join("\n")}`;
}

/**
 * @param {RenderInput} input
 * @returns {string}
 */
export function renderXml(input) {
  const { rootName, files, omitted, totalTokens, maxTokens } = input;
  const attrs = [
    `root="${escapeAttr(rootName)}"`,
    `files="${files.length}"`,
    `estimated-tokens="${totalTokens}"`,
    ...(maxTokens !== null ? [`max-tokens="${maxTokens}"`] : []),
  ];
  const out = [`<repo-pack ${attrs.join(" ")}>`];
  out.push(`<tree>${cdata(buildTree(files.map((f) => f.path)))}</tree>`);
  for (const o of omitted) {
    out.push(`<omitted path="${escapeAttr(o.path)}" estimated-tokens="${o.tokens}"/>`);
  }
  for (const f of files) {
    const lang = languageFor(f.path);
    const langAttr = lang ? ` language="${escapeAttr(lang)}"` : "";
    out.push(
      `<file path="${escapeAttr(f.path)}"${langAttr} estimated-tokens="${f.tokens}">${cdata(f.text)}</file>`,
    );
  }
  out.push("</repo-pack>", "");
  return out.join("\n");
}
