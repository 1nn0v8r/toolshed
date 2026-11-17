// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { languageOf, scanContent } from "../src/scan.js";

/** @param {string} file @param {string} content */
const names = (file, content) => scanContent(file, content).uses.map((u) => u.name);

test("languageOf picks groups by extension and compose names", () => {
  assert.equal(languageOf("a/b.ts"), "js");
  assert.equal(languageOf("x.vue"), "js");
  assert.equal(languageOf("x.py"), "py");
  assert.equal(languageOf("x.go"), "go");
  assert.equal(languageOf("x.rb"), "rb");
  assert.equal(languageOf("x.php"), "php");
  assert.equal(languageOf("x.rs"), "rs");
  assert.equal(languageOf("docker-compose.yml"), "compose");
  assert.equal(languageOf("docker-compose.prod.yaml"), "compose");
  assert.equal(languageOf("compose.yaml"), "compose");
  assert.equal(languageOf("sub/compose.override.yml"), "compose");
  assert.equal(languageOf("config.yml"), null);
  assert.equal(languageOf("README.md"), null);
  assert.equal(scanContent("README.md", "process.env.X").uses.length, 0);
});

test("JS: dot, bracket (all quote styles), import.meta, Bun, Deno", () => {
  const src = [
    "const a = process.env.DOT_VAR;",
    'const b = process.env["DQ_VAR"];',
    "const c = process.env['SQ_VAR'];",
    "const d = process.env[`BT_VAR`];",
    "const e = import.meta.env.VITE_API_URL;",
    'const f = import.meta.env["VITE_OTHER"];',
    "const g = Bun.env.BUN_VAR;",
    'const h = Deno.env.get("DENO_VAR");',
    "const i = process.env [ 'SPACED' ] ;",
  ].join("\n");
  const r = scanContent("a.ts", src);
  assert.deepEqual(
    r.uses.map((u) => [u.name, u.line]),
    [
      ["DOT_VAR", 1],
      ["DQ_VAR", 2],
      ["SQ_VAR", 3],
      ["BT_VAR", 4],
      ["VITE_API_URL", 5],
      ["VITE_OTHER", 6],
      ["BUN_VAR", 7],
      ["DENO_VAR", 8],
      ["SPACED", 9],
    ],
  );
  assert.equal(r.dynamic.length, 0);
});

test("JS: Vite built-ins are not reported", () => {
  assert.deepEqual(names("a.ts", "if (import.meta.env.DEV && import.meta.env.MODE && import.meta.env['PROD']) {} import.meta.env.VITE_X"), ["VITE_X"]);
});

test("JS: destructuring, multi-line, defaults, aliases, rest", () => {
  const src = [
    "const { A, B } = process.env;",
    "const {",
    "  C,",
    '  D = "x, y",',
    "  E: renamed,",
    "  ...rest",
    "} = process.env;",
    "let { F } = import.meta.env;",
  ].join("\n");
  const r = scanContent("a.js", src);
  assert.deepEqual(
    r.uses.map((u) => [u.name, u.line]),
    [
      ["A", 1],
      ["B", 1],
      ["C", 3],
      ["D", 4],
      ["E", 5],
      ["F", 8],
    ],
  );
});

test("JS: dynamic reads are counted with lines, not named", () => {
  const src = "const k = 'X';\nconst a = process.env[k];\nconst b = process.env[`P_${k}`];\nDeno.env.get(k);\nimport.meta.env[k];\nBun.env[k];";
  const r = scanContent("a.ts", src);
  assert.equal(r.uses.length, 0);
  assert.deepEqual(r.dynamic.map((d) => d.line).sort((a, b) => a - b), [2, 3, 4, 5, 6]);
  assert.equal(r.dynamic.length, 5);
});

test("JS: commented-out reads are ignored", () => {
  const src = "// process.env.GONE\n/* process.env.GONE2 */\n * process.env.GONE3\nprocess.env.KEPT;";
  assert.deepEqual(names("a.js", src), ["KEPT"]);
});

test("JS: duplicate on one line is reported once", () => {
  assert.deepEqual(names("a.js", "const x = process.env.A || process.env.A;"), ["A"]);
});

test("Python: environ[], environ.get, getenv, bare imports", () => {
  const src = [
    'a = os.environ["PY_A"]',
    "b = os.environ.get('PY_B', 'd')",
    'c = os.getenv("PY_C")',
    'd = environ["PY_D"]',
    'e = environ.get("PY_E")',
    'f = getenv("PY_F")',
    "# g = os.getenv('PY_COMMENT')",
  ].join("\n");
  assert.deepEqual(names("a.py", src), ["PY_A", "PY_B", "PY_C", "PY_D", "PY_E", "PY_F"]);
});

test("Python: dynamic", () => {
  const r = scanContent("a.py", "os.environ[key]\nos.environ.get(key)\nos.getenv(name, 'x')\nos.getenv('OK')");
  assert.equal(r.dynamic.length, 3);
  assert.deepEqual(r.uses.map((u) => u.name), ["OK"]);
});

test("Go: Getenv and LookupEnv", () => {
  const src = 'a := os.Getenv("GO_A")\nb, ok := os.LookupEnv("GO_B")\nc := os.Getenv(key)\n// os.Getenv("GO_C")';
  const r = scanContent("main.go", src);
  assert.deepEqual(r.uses.map((u) => u.name), ["GO_A", "GO_B"]);
  assert.equal(r.dynamic.length, 1);
});

test("Ruby: ENV[] and ENV.fetch", () => {
  const src = 'a = ENV["RB_A"]\nb = ENV[\'RB_B\']\nc = ENV.fetch("RB_C")\nd = ENV.fetch "RB_D", "x"\ne = ENV[k]\nf = ENV.fetch(k)\n# ENV["RB_COMMENT"]\ng = config.ENV["NOPE"]';
  const r = scanContent("a.rb", src);
  assert.deepEqual(r.uses.map((u) => u.name), ["RB_A", "RB_B", "RB_C", "RB_D"]);
  assert.equal(r.dynamic.length, 2);
});

test("PHP: getenv, $_ENV, env()", () => {
  const src = "<?php\n$a = getenv('PHP_A');\n$b = $_ENV['PHP_B'];\n$c = env('PHP_C', 'x');\n$d = getenv($k);\n$e = $_ENV[$k];\n$f = getenv();\n$g = $obj->env('NOT_THIS');\n# getenv('PHP_COMMENT')";
  const r = scanContent("a.php", src);
  assert.deepEqual(r.uses.map((u) => u.name), ["PHP_A", "PHP_B", "PHP_C"]);
  assert.equal(r.dynamic.length, 2);
});

test("Rust: env::var, std::env::var, var_os, env! macros", () => {
  const src = 'let a = env::var("RS_A");\nlet b = std::env::var("RS_B").unwrap();\nlet c = env::var_os("RS_C");\nlet d = env!("RS_D");\nlet e = option_env!("RS_E");\nlet f = env::var(name);';
  const r = scanContent("main.rs", src);
  assert.deepEqual(r.uses.map((u) => u.name), ["RS_A", "RS_B", "RS_C", "RS_D", "RS_E"]);
  assert.equal(r.dynamic.length, 1);
});

test("docker-compose: ${NAME}, defaults, required, escapes, comments", () => {
  const src = [
    "services:",
    "  web:",
    "    environment:",
    "      A: ${C_A}",
    "      B: ${C_B:-fallback}",
    "      C: ${C_C:?must be set}",
    "      D: ${C_D-x}",
    "      E: ${C_E?err}",
    "      F: ${C_F:+alt}",
    "      G: $${NOT_A_VAR}",
    "      # H: ${C_COMMENT}",
    "    image: app:${TAG}",
  ].join("\n");
  assert.deepEqual(names("docker-compose.yml", src), ["C_A", "C_B", "C_C", "C_D", "C_E", "C_F", "TAG"]);
});

test("CRLF content reports correct lines", () => {
  const r = scanContent("a.js", "a\r\nb\r\nconst x = process.env.CRLF_VAR;\r\n");
  assert.deepEqual(r.uses, [{ name: "CRLF_VAR", line: 3 }]);
});

test("unicode and empty content are fine", () => {
  assert.deepEqual(scanContent("a.js", "").uses, []);
  assert.deepEqual(names("a.js", "const s = 'café ☃'; process.env.UNI_OK;"), ["UNI_OK"]);
});

test("a very large file scans quickly", () => {
  const big = "const x = 1;\n".repeat(200000) + "process.env.LATE_VAR;\n";
  const start = Date.now();
  const r = scanContent("big.js", big);
  assert.deepEqual(r.uses, [{ name: "LATE_VAR", line: 200001 }]);
  assert.ok(Date.now() - start < 5000);
});
