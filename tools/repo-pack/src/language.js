// @ts-check

/** @type {Record<string, string>} */
const BY_EXT = {
  js: "js", mjs: "js", cjs: "js", jsx: "jsx", ts: "ts", mts: "ts", cts: "ts", tsx: "tsx",
  json: "json", jsonc: "jsonc", md: "md", mdx: "mdx", markdown: "md", rst: "rst", txt: "text",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", bat: "bat", cmd: "bat",
  html: "html", htm: "html", css: "css", scss: "scss", sass: "sass", less: "less",
  vue: "vue", svelte: "svelte", yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini",
  cfg: "ini", conf: "conf", xml: "xml", svg: "xml", sql: "sql", graphql: "graphql", gql: "graphql",
  proto: "protobuf", lua: "lua", pl: "perl", r: "r", scala: "scala", dart: "dart", ex: "elixir",
  exs: "elixir", hs: "haskell", clj: "clojure", tf: "hcl", csv: "csv", env: "dotenv",
};

/** @type {Record<string, string>} */
const BY_NAME = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
  ".gitignore": "gitignore",
  ".npmrc": "ini",
  ".editorconfig": "ini",
};

/**
 * Infer a fenced code block language tag from a path. Empty string if unknown.
 * @param {string} relPath
 * @returns {string}
 */
export function languageFor(relPath) {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1).toLowerCase();
  if (Object.hasOwn(BY_NAME, base)) return BY_NAME[base];
  if (base.startsWith("dockerfile.")) return "dockerfile";
  const dot = base.lastIndexOf(".");
  if (dot === -1) return "";
  const ext = base.slice(dot + 1);
  return Object.hasOwn(BY_EXT, ext) ? BY_EXT[ext] : "";
}
