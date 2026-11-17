// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, countExact, mapLimit } from "../src/exact.js";
import { sendJson, startMock } from "./helpers.js";

const KEY = ["test", "key", "value"].join("-");

test("sends the documented request and returns input_tokens", async () => {
  const mock = await startMock((_req, _n, res) => sendJson(res, 200, { input_tokens: 42 }));
  try {
    const n = await countExact("hello", { apiKey: KEY, model: "m-1", baseUrl: mock.url });
    assert.equal(n, 42);
    const r = mock.requests[0];
    assert.equal(r.method, "POST");
    assert.equal(r.url, "/v1/messages/count_tokens");
    assert.equal(r.headers["x-api-key"], KEY);
    assert.equal(r.headers["anthropic-version"], "2023-06-01");
    assert.equal(r.headers["content-type"], "application/json");
    assert.deepEqual(r.body, { model: "m-1", messages: [{ role: "user", content: "hello" }] });
  } finally {
    await mock.close();
  }
});

test("trailing slash on base url is tolerated", async () => {
  const mock = await startMock((_req, _n, res) => sendJson(res, 200, { input_tokens: 1 }));
  try {
    await countExact("x", { apiKey: KEY, model: "m", baseUrl: `${mock.url}//` });
    assert.equal(mock.requests[0].url, "/v1/messages/count_tokens");
  } finally {
    await mock.close();
  }
});

test("empty text is zero without a request", async () => {
  const mock = await startMock((_req, _n, res) => sendJson(res, 200, { input_tokens: 9 }));
  try {
    assert.equal(await countExact("", { apiKey: KEY, model: "m", baseUrl: mock.url }), 0);
    assert.equal(mock.requests.length, 0);
  } finally {
    await mock.close();
  }
});

test("retries 429 then succeeds", async () => {
  const mock = await startMock((_req, n, res) => {
    if (n === 1) sendJson(res, 429, { error: { message: "slow down" } });
    else sendJson(res, 200, { input_tokens: 7 });
  });
  try {
    assert.equal(await countExact("x", { apiKey: KEY, model: "m", baseUrl: mock.url, baseDelayMs: 1 }), 7);
    assert.equal(mock.requests.length, 2);
  } finally {
    await mock.close();
  }
});

test("retries 5xx then succeeds", async () => {
  const mock = await startMock((_req, n, res) => {
    if (n < 3) sendJson(res, 503, {});
    else sendJson(res, 200, { input_tokens: 3 });
  });
  try {
    assert.equal(await countExact("x", { apiKey: KEY, model: "m", baseUrl: mock.url, baseDelayMs: 1 }), 3);
    assert.equal(mock.requests.length, 3);
  } finally {
    await mock.close();
  }
});

test("gives up after the retry budget", async () => {
  const mock = await startMock((_req, _n, res) => sendJson(res, 429, { error: { message: "rate limited" } }));
  try {
    await assert.rejects(
      countExact("x", { apiKey: KEY, model: "m", baseUrl: mock.url, baseDelayMs: 1, retries: 2 }),
      (e) => e instanceof ApiError && e.status === 429 && /rate limited/.test(e.message),
    );
    assert.equal(mock.requests.length, 3);
  } finally {
    await mock.close();
  }
});

test("401 fails immediately with the API message and does not leak the key", async () => {
  const mock = await startMock((_req, _n, res) => sendJson(res, 401, { error: { type: "authentication_error", message: "invalid x-api-key" } }));
  try {
    await assert.rejects(
      countExact("x", { apiKey: KEY, model: "m", baseUrl: mock.url, baseDelayMs: 1 }),
      (e) => e instanceof ApiError && e.status === 401 && /401/.test(e.message) && !e.message.includes(KEY),
    );
    assert.equal(mock.requests.length, 1);
  } finally {
    await mock.close();
  }
});

test("non-JSON error body still yields a status message", async () => {
  const mock = await startMock((_req, _n, res) => { res.writeHead(400); res.end("bad"); });
  try {
    await assert.rejects(countExact("x", { apiKey: KEY, model: "m", baseUrl: mock.url }), /API error 400$/);
  } finally {
    await mock.close();
  }
});

test("invalid success bodies are errors", async () => {
  const bad = await startMock((_req, _n, res) => { res.writeHead(200); res.end("not json"); });
  const missing = await startMock((_req, _n, res) => sendJson(res, 200, { nope: 1 }));
  try {
    await assert.rejects(countExact("x", { apiKey: KEY, model: "m", baseUrl: bad.url }), /invalid JSON/);
    await assert.rejects(countExact("x", { apiKey: KEY, model: "m", baseUrl: missing.url }), /no input_tokens/);
  } finally {
    await bad.close();
    await missing.close();
  }
});

test("network failures are retried then reported", async () => {
  let calls = 0;
  /** @type {typeof fetch} */
  const failing = async () => { calls++; throw new Error("connection refused"); };
  await assert.rejects(
    countExact("x", { apiKey: KEY, model: "m", baseUrl: "http://127.0.0.1:1", fetchImpl: failing, baseDelayMs: 1, retries: 1 }),
    /network error.*connection refused/,
  );
  assert.equal(calls, 2);
});

test("network failure can recover on retry", async () => {
  let calls = 0;
  /** @type {typeof fetch} */
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new Error("reset");
    return new Response(JSON.stringify({ input_tokens: 5 }), { status: 200 });
  };
  assert.equal(await countExact("x", { apiKey: KEY, model: "m", baseUrl: "http://x", fetchImpl: flaky, baseDelayMs: 1 }), 5);
});

test("non-Error thrown values are stringified", async () => {
  /** @type {typeof fetch} */
  const weird = async () => { throw "boom"; };
  await assert.rejects(countExact("x", { apiKey: KEY, model: "m", baseUrl: "http://x", fetchImpl: weird, retries: 0 }), /boom/);
});

test("mapLimit preserves order and respects the concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const out = await mapLimit(items, 4, async (i) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return i * 2;
  });
  assert.deepEqual(out, items.map((i) => i * 2));
  assert.equal(peak, 4);
});

test("mapLimit handles empty input and stops after an error", async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  let started = 0;
  await assert.rejects(
    mapLimit(Array.from({ length: 50 }, (_, i) => i), 2, async (i) => {
      started++;
      await new Promise((r) => setTimeout(r, 2));
      if (i === 1) throw new Error("stop");
      return i;
    }),
    /stop/,
  );
  assert.ok(started < 50);
});
