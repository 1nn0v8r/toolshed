// @ts-check
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RULES, RULE_IDS, isEnvFile, isPlaceholder, mask } from "../src/rules.js";
import { EM, EN, ELL, fake, unixHome, winHome } from "./helpers.js";

/** @param {string} id */
function rule(id) {
  const r = RULES.find((x) => x.id === id);
  if (!r || !r.scan) throw new Error("no scan rule " + id);
  return r.scan;
}

describe("mask", () => {
  it("keeps 4 chars then ***", () => {
    assert.equal(mask("abcdefghij"), "abcd***");
    assert.equal(mask("ab"), "ab***");
  });
});

describe("rule table", () => {
  it("has unique ids and the documented defaults", () => {
    assert.equal(new Set(RULE_IDS).size, RULE_IDS.length);
    const byId = Object.fromEntries(RULES.map((r) => [r.id, r]));
    assert.equal(byId["path.personal"].severity, "warn");
    assert.equal(byId["file.large"].severity, "warn");
    assert.equal(byId["file.env"].severity, "error");
    assert.equal(byId["text.typography"].enabled, false);
    assert.ok(RULES.filter((r) => r.id.startsWith("secret.")).every((r) => r.severity === "error"));
  });
});

/** @type {[string, string, () => string[], string[]][]} */
const secretCases = [
  ["secret.aws-access-key", "AWS", () => [fake.aws(), fake.awsSts()], ["AKIA", "short AKIA12", "akia" + "Q7".repeat(8), "AKIA" + "Q7".repeat(8) + "Q7"]],
  ["secret.github-token", "GitHub", () => [fake.ghp(), fake.gho(), fake.ghu(), fake.ghs(), fake.ghr(), fake.ghPat()], ["ghp_short", "ghx_" + "a".repeat(40)]],
  ["secret.private-key", "Private key", () => [fake.privateKey(), fake.privateKeyPlain()], ["-----BEGIN PUBLIC KEY-----", "BEGIN PRIVATE KEY"]],
  ["secret.slack-token", "Slack", () => [fake.slack()], ["xoxz-1234567890abc", "xoxb-short"]],
  ["secret.stripe-live", "Stripe", () => [fake.stripe(), fake.stripeRestricted()], ["sk_" + "test_" + "A1b2C3d4E5f6G7h8", "sk_live_x"]],
  ["secret.anthropic-key", "Anthropic", () => [fake.anthropic()], ["sk-ant-short"]],
  ["secret.openai-key", "OpenAI", () => [fake.openai(), fake.openaiProj()], ["sk-short", "task-" + "a".repeat(30)]],
  ["secret.google-api-key", "Google", () => [fake.google()], ["AIza" + "a".repeat(10), "AIza" + "a".repeat(40)]],
  ["secret.jwt", "JSON Web Token", () => [fake.jwt()], ["eyJ.abc.def", "eyJabc.def"]],
];

for (const [id, label, positives, negatives] of secretCases) {
  describe(id, () => {
    it("flags real-looking values and masks them", () => {
      for (const secret of positives()) {
        const line = `value = ${secret} # trailing`;
        const hits = rule(id)(line);
        assert.equal(hits.length, 1, `${id} should match ${secret.slice(0, 6)}`);
        assert.equal(hits[0].index, line.indexOf(secret));
        assert.ok(hits[0].message.startsWith(label), hits[0].message);
        assert.ok(!hits[0].message.includes(secret), "message must not contain the full secret");
        assert.ok(hits[0].message.includes(secret.slice(0, 4) + "***"));
      }
    });
    it("ignores near misses", () => {
      for (const n of negatives) assert.deepEqual(rule(id)(`x = ${n}`), [], n);
    });
  });
}

describe("secret overlap", () => {
  it("anthropic keys are not also reported as openai keys", () => {
    assert.deepEqual(rule("secret.openai-key")(fake.anthropic()), []);
  });
  it("AWS documentation example key is allowed", () => {
    assert.deepEqual(rule("secret.aws-access-key")("AKIA" + "IOSFODNN7EXAMPLE"), []);
  });
});

describe("secret.generic-assignment", () => {
  const scan = rule("secret.generic-assignment");
  it("flags quoted values with mixed character classes", () => {
    const v = fake.generic();
    for (const line of [
      `api_key = "${v}"`,
      `const apiKey = '${v}';`,
      `"secret": "${v}"`,
      `password: '${v}'`,
      `DB_PASSWORD="${v}"`,
      `token => "${v}"`,
      `client_secret = \`${v}\``,
      `secretKey: "${v}"`,
    ]) {
      const hits = scan(line);
      assert.equal(hits.length, 1, line);
      assert.equal(hits[0].index, line.indexOf(v));
      assert.ok(!hits[0].message.includes(v));
      assert.ok(hits[0].message.includes("Zk3p***"));
    }
  });
  it("flags long alphanumeric values with only two classes", () => {
    assert.equal(scan(`token = "${"a1b2c3d4e5".repeat(3)}"`).length, 1);
  });
  it("ignores obvious placeholders", () => {
    for (const v of [
      "changeme123456", "replace-with-real-key", "<your-api-key-here>", "${API_KEY_VALUE}",
      "xxxxxxxxxxxxxxxx", "example-key-1234567", "your-token-goes-here1", "{{ secrets.TOKEN1 }}",
      "placeholder1234", "dummy-value-1234", "********************",
    ]) {
      assert.deepEqual(scan(`api_key = "${v}"`), [], v);
    }
  });
  it("ignores short, plain and unquoted values", () => {
    assert.deepEqual(scan(`password = "short1A"`), []);
    assert.deepEqual(scan(`password = "justlowercaseletters"`), []);
    assert.deepEqual(scan(`secret: "set-via-SOME_ENV-name"`), []);
    assert.deepEqual(scan(`token = process.env.TOKEN_VALUE`), []);
    assert.deepEqual(scan(`password == "${fake.generic()}"`), []);
    assert.deepEqual(scan(`tokenizer = "${fake.generic()}"`), []);
    assert.deepEqual(scan(`const username = "${fake.generic()}"`), []);
    assert.deepEqual(scan(`token = "has spaces ${fake.generic()}"`), []);
  });
});

describe("path.personal", () => {
  const scan = rule("path.personal");
  it("flags Windows paths with either separator", () => {
    for (const sep of ["\\", "/"]) {
      const hits = scan(`path = "${winHome("bob", sep)}"`);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].message.includes("bob***"));
      assert.ok(!hits[0].message.includes("bob\\"));
    }
    assert.equal(scan(`"C:\\\\Users\\\\bob\\\\x"`).length, 1);
  });
  it("flags macOS and Linux home paths", () => {
    assert.equal(scan(`cd ${unixHome("bob", "home")}`).length, 1);
    assert.equal(scan(`cd ${unixHome("bob", "Users")}`).length, 1);
  });
  it("ignores placeholders", () => {
    for (const n of ["you", "user", "username", "example", "...", "<name>", "Public", "YourName", "$USER", "%USERNAME%"]) {
      assert.deepEqual(scan(winHome(n)), [], n);
      assert.deepEqual(scan(unixHome(n)), [], n);
    }
  });
  it("ignores paths that merely contain 'home' deeper in the path", () => {
    assert.deepEqual(scan("/abs/path/home/bob/x"), []);
    assert.deepEqual(scan("~/home/bob/x"), []);
  });
  it("returns matches ordered by position", () => {
    const line = `${unixHome("carol")} then ${winHome("dave")}`;
    const hits = scan(line);
    assert.equal(hits.length, 2);
    assert.ok(hits[0].index < hits[1].index);
  });
});

describe("text.typography", () => {
  const scan = rule("text.typography");
  it("detects em dash, en dash and ellipsis by code point", () => {
    const hits = scan(`a${EM}b${EN}c${ELL}`);
    assert.deepEqual(hits.map((h) => h.index), [1, 3, 5]);
    assert.ok(hits[0].message.includes("U+2014"));
    assert.ok(hits[1].message.includes("U+2013"));
    assert.ok(hits[2].message.includes("U+2026"));
  });
  it("ignores plain punctuation", () => {
    assert.deepEqual(scan("a - b -- c ... d"), []);
  });
});

describe("isEnvFile", () => {
  it("flags .env and .env.*", () => {
    for (const f of [".env", ".env.local", ".env.production", "app/.env", "a\\b\\.env.dev"]) {
      assert.equal(isEnvFile(f), true, f);
    }
  });
  it("allows example, sample and template files and other names", () => {
    for (const f of [".env.example", ".env.sample", ".env.template", "x/.env.EXAMPLE", "env.txt", ".environment", "my.env", ".envrc"]) {
      assert.equal(isEnvFile(f), false, f);
    }
  });
});

describe("isPlaceholder", () => {
  it("recognises placeholders and rejects real-looking values", () => {
    assert.equal(isPlaceholder("<token>"), true);
    assert.equal(isPlaceholder("..."), true);
    assert.equal(isPlaceholder(fake.generic()), false);
  });
});
