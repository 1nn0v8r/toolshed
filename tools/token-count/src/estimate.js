// @ts-check

/**
 * Count characters as Unicode code points.
 * @param {string} text
 * @returns {number}
 */
export function countChars(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // skip the low half of a surrogate pair
    if (c >= 0xdc00 && c <= 0xdfff && i > 0) {
      const p = text.charCodeAt(i - 1);
      if (p >= 0xd800 && p <= 0xdbff) continue;
    }
    n++;
  }
  return n;
}

/**
 * Offline estimate: ceil(chars / 4).
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil(countChars(text) / 4);
}
