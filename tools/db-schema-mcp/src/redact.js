// @ts-check
// Helpers that keep credentials and secret-looking values out of any output.

const SECRET_COLUMN = /password|passwd|secret|token|api[_\-\s]?key|hash|salt|ssn|card|cvv|iban|otp|private/i;

/** @param {string} name */
export function isSecretColumn(name) {
  return SECRET_COLUMN.test(String(name));
}

export const REDACTED = "[redacted]";

/**
 * Replace credentials in any URL-looking text with "***@".
 * @param {string} text
 */
export function redactUrl(text) {
  return String(text).replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, "$1***@");
}

/**
 * @param {string} s
 */
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Remove URL credentials, the full connection URL and the known password from
 * an error message or other text.
 * @param {string} text
 * @param {{ url?: string }} [config]
 */
export function redactSecrets(text, config) {
  let out = String(text);
  const url = config && config.url;
  if (url) {
    out = out.split(url).join("[connection url]");
    try {
      const u = new URL(url);
      const secrets = new Set([u.password, safeDecode(u.password)]);
      for (const s of secrets) {
        if (s) out = out.split(s).join("***");
      }
    } catch {
      // Not parseable: the generic URL redaction below still applies.
    }
  }
  return redactUrl(out);
}
