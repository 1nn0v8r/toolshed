// @ts-check

/**
 * Rough token estimate: Math.ceil(characters / 4). This is a heuristic, not
 * the output of any real tokenizer. "Characters" are JavaScript string
 * length units. Real counts differ by model and content.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
