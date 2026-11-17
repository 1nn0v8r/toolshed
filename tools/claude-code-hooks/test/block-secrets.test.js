// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, newTexts } from "../src/hooks/block-secrets.js";
import { findSecrets, isPlaceholder, mask } from "../src/lib/secrets.js";
import { decisionOf, fx, mkTmp, payload, rmTmp, runHookProcess } from "./helpers.js";

/** @param {string} content */
const write = (content) => evaluate(payload("Write", { file_path: "/p/a.js", content }));

test("each provider pattern is detected and masked", () => {
  const cases = /** @type {[string, string][]} */ ([
    ["AWS access key id", fx.aws()],
    ["GitHub token", fx.github()],
    ["GitHub fine-grained token", fx.githubPat()],
    ["Private key block", fx.privateKeyHeader()],
    ["Slack token", fx.slack()],
    ["Stripe live key", fx.stripe()],
    ["Anthropic API key", fx.anthropic()],
    ["OpenAI API key", fx.openai()],
    ["Google API key", fx.google()],
    ["JSON Web Token", fx.jwt()],
  ]);
  for (const [name, value] of cases) {
    const found = findSecrets(`const x = "${value}";`);
    assert.ok(
      found.some((f) => f.name === name),
      `${name} not found, got ${found.map((f) => f.name).join(",")}`,
    );
    const r = write(`line1\nconst x = "${value}";\n`);
    assert.equal(r.decision, "deny", name);
    assert.ok(!r.reason.includes(value), `${name} leaked in reason`);
    assert.match(r.reason, /line 2/);
  }
});

test("generic assignments with real-looking values are denied", () => {
  const v = fx.realValue();
  for (const line of [
    `const apiKey = "${v}";`,
    `api_key: '${v}'`,
    `password = "${v}"`,
    `"client_secret": "${v}",`,
    `DB_PASSWORD=${v}${v}`,
    `export AUTH_TOKEN="${v}"`,
    `token => "${v}"`,
  ]) {
    const r = write(line);
    assert.equal(r.decision, "deny", line);
    assert.ok(!r.reason.includes(v), "value must be masked");
  }
});

test("placeholders and references are ignored", () => {
  for (const line of [
    'api_key = "your-api-key-here"',
    'password = "changeme123"',
    'secret = "<your secret>"',
    'token = "${TOKEN_FROM_ENV}"',
    "const apiKey = process.env.API_KEY;",
    "api_key = os.environ['API_KEY']",
    'password = "xxxxxxxxxxxxxxxx"',
    'password = "********"',
    'token = "example_token_1234"',
    'password = getPassword()',
    'password: "short1"',
    'secret_name = "my_secret_name_value"',
    'api_url = "https://example.com/api/v1/token1234"',
    "const tokenType = 'AccessTokenType';",
    "password = 'aaaaaaaaaaaaaaaa1'",
    "DB_PASSWORD=",
    "token = null",
    'apiKey: "test-key-' + '1234567"',
    `const x = "${"AK" + "IA" + "IOSFODNN7" + "EXAMPLE"}";`,
    "plain text with no secrets at all",
    "",
  ]) {
    assert.equal(write(line).decision, "allow", line);
  }
});

test("allow marker silences a line", () => {
  assert.equal(write(`const x = "${fx.aws()}"; // claude-hooks:allow`).decision, "allow");
  assert.equal(write(`const x = "${fx.aws()}"; # gitleaks:allow`).decision, "allow");
});

test("Edit, MultiEdit and Write inputs are all scanned", () => {
  const v = fx.github();
  assert.equal(evaluate(payload("Edit", { file_path: "/p/a", old_string: "a", new_string: v })).decision, "deny");
  assert.equal(
    evaluate(payload("MultiEdit", { file_path: "/p/a", edits: [{ old_string: "a", new_string: "ok" }, { old_string: "b", new_string: v }] })).decision,
    "deny",
  );
  assert.equal(evaluate(payload("Edit", { file_path: "/p/a", old_string: v, new_string: "ok" })).decision, "allow");
});

test("CRLF content is scanned line by line", () => {
  const r = write(`a\r\nb\r\nconst k = "${fx.aws()}"\r\n`);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /line 3/);
});

test("unicode and huge content", () => {
  assert.equal(write("const s = 'héllo wörld ✓ \u{1F600}';").decision, "allow");
  const big = "x = 1\n".repeat(200000) + `k = "${fx.aws()}"\n`;
  assert.equal(write(big).decision, "deny");
});

test("many findings are summarized", () => {
  const lines = Array.from({ length: 8 }, () => `k = "${fx.aws()}"`).join("\n");
  const r = write(lines);
  assert.match(r.reason, /and 3 more/);
});

test("missing and malformed fields allow", () => {
  assert.equal(evaluate({}).decision, "allow");
  assert.equal(evaluate({ tool_input: null }).decision, "allow");
  assert.equal(evaluate({ tool_input: { file_path: "/a" } }).decision, "allow");
  assert.equal(evaluate({ tool_input: { content: 5, edits: [null, 4, {}] } }).decision, "allow");
  assert.deepEqual(newTexts(null), []);
  assert.deepEqual(newTexts({ content: "a", new_string: "b", edits: [{ new_string: "c" }] }), ["a", "b", "c"]);
});

test("config: allow globs and extra patterns", () => {
  const v = fx.aws();
  const p = payload("Write", { file_path: "/p/test/fixtures/a.js", content: v });
  assert.equal(evaluate(p).decision, "deny");
  assert.equal(evaluate(p, { allow: ["test/fixtures/**"] }).decision, "allow");
  const extra = { extraPatterns: [{ name: "Internal id", pattern: "INT-[0-9]{6}" }, { pattern: "(" }, null] };
  const q = payload("Write", { file_path: "/p/a", content: "id INT-123456" });
  const r = evaluate(q, extra);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /Internal id/);
});

test("lib: mask and isPlaceholder", () => {
  assert.equal(mask("short"), "****");
  assert.equal(mask("abcdefghijkl"), "abcd****");
  assert.ok(isPlaceholder("$VAR"));
  assert.ok(isPlaceholder("null"));
  assert.ok(isPlaceholder("https://x.test/a"));
  assert.ok(!isPlaceholder(fx.realValue()));
  assert.deepEqual(findSecrets(""), []);
});

test("e2e: deny output and exit code", () => {
  const home = mkTmp();
  try {
    const v = fx.anthropic();
    const r = runHookProcess("block-secrets", payload("Write", { file_path: "/abs/path/config.js", content: `const k = "${v}"` }), { home });
    assert.equal(r.status, 0);
    const d = decisionOf(r.stdout);
    assert.equal(d.decision, "deny");
    assert.ok(!r.stdout.includes(v));
    const ok = runHookProcess("block-secrets", payload("Write", { file_path: "/abs/path/a.js", content: "const a = 1" }), { home });
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout, "");
    const bad = runHookProcess("block-secrets", "}{", { home });
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout, "");
    assert.match(bad.stderr, /allowing/);
  } finally {
    rmTmp(home);
  }
});
