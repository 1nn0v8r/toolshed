// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { countChars, estimateTokens } from "../src/estimate.js";

test("empty text is zero tokens", () => {
  assert.equal(estimateTokens(""), 0);
});

test("rounds up", () => {
  assert.equal(estimateTokens("a"), 1);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("a".repeat(400)), 100);
});

test("CRLF counts both characters", () => {
  assert.equal(countChars("a\r\nb"), 4);
  assert.equal(estimateTokens("a\r\nb\r\n"), 2);
});

test("astral characters count once", () => {
  assert.equal(countChars("\u{1F600}"), 1);
  assert.equal(countChars("\u{1F600}\u{1F600}\u{1F600}\u{1F600}"), 4);
  assert.equal(estimateTokens("\u{1F600}".repeat(5)), 2);
  assert.equal(countChars("héllo"), 5);
});

test("lone surrogates still count", () => {
  assert.equal(countChars("\ude00"), 1);
  assert.equal(countChars("\ud83d"), 1);
});

test("huge input", () => {
  assert.equal(estimateTokens("x".repeat(5_000_000)), 1_250_000);
});
