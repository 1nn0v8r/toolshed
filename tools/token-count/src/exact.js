// @ts-check

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} [status]
   */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * @typedef {Object} ExactConfig
 * @property {string} apiKey
 * @property {string} model
 * @property {string} baseUrl
 * @property {number} [retries] retries after the first attempt (default 3)
 * @property {number} [baseDelayMs] first backoff delay (default 500)
 * @property {typeof fetch} [fetchImpl]
 */

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {number} status */
const retryable = (status) => status === 429 || status >= 500;

/**
 * Count tokens for one text with the Anthropic token counting API.
 * Retries 429 and 5xx responses, and network failures, with exponential backoff.
 * @param {string} text
 * @param {ExactConfig} cfg
 * @returns {Promise<number>}
 */
export async function countExact(text, cfg) {
  if (text === "") return 0;
  const retries = cfg.retries ?? 3;
  const baseDelay = cfg.baseDelayMs ?? 500;
  const doFetch = cfg.fetchImpl ?? fetch;
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/v1/messages/count_tokens`;
  const body = JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: text }] });
  /** @type {ApiError | null} */
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(baseDelay * 2 ** (attempt - 1));
    let res;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body,
      });
    } catch (e) {
      last = new ApiError(`network error calling ${url}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const raw = await res.text();
    if (res.ok) {
      /** @type {any} */
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new ApiError("API returned invalid JSON", res.status);
      }
      if (!data || typeof data.input_tokens !== "number") {
        throw new ApiError("API response had no input_tokens", res.status);
      }
      return data.input_tokens;
    }
    let detail = "";
    try {
      detail = JSON.parse(raw)?.error?.message ?? "";
    } catch {
      // not JSON
    }
    last = new ApiError(`API error ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
    if (!retryable(res.status)) throw last;
  }
  throw /** @type {ApiError} */ (last);
}

/**
 * Run async work over items with a concurrency limit. Stops scheduling after the first error.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
