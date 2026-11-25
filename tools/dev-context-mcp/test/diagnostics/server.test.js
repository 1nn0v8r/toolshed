// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { handleTool } from "../../modules/diagnostics/server.js";

test("handleTool trim_diagnostics processes text input", async () => {
  const text = "src/main.ts(1,1): error TS2304: Cannot find name 'foo'.";
  const res = await handleTool("trim_diagnostics", { text, includeSnippets: false });

  assert.equal(res.isError, true);
  assert.equal(res.content.length, 1);
  assert.ok(res.content[0].text.includes("[TS2304] src/main.ts:1:1"));
});

test("handleTool check_diagnostics runs echo command", async () => {
  const res = await handleTool("check_diagnostics", {
    command: "node -e \"console.log('src/foo.ts:10:2: error: test error')\"",
    preset: "python",
    includeSnippets: false,
  });

  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes("src/foo.ts:10:2"));
});
