// @ts-check
// Minimal gitignore-style glob to RegExp conversion.

/**
 * Convert a glob to a RegExp tested against forward-slash relative paths.
 * Patterns without a slash match any path segment name (like .gitignore).
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  let dirOnly = false;
  if (g.endsWith("/")) {
    dirOnly = true;
    g = g.slice(0, -1);
  }
  const anchored = g.startsWith("/") || g.includes("/");
  g = g.replace(/^\//, "");
  let body = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") {
          body += "(?:.*/)?";
          i += 2;
        } else {
          body += ".*";
          i += 1;
        }
      } else {
        body += "[^/]*";
      }
    } else if (c === "?") {
      body += "[^/]";
    } else {
      body += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const prefix = anchored ? "^" : "(?:^|/)";
  const suffix = dirOnly ? "/.*$" : "(?:/.*)?$";
  return new RegExp(prefix + body + suffix);
}

/**
 * @param {string[]} globs
 * @returns {(relPath: string) => boolean}
 */
export function makeMatcher(globs) {
  const res = globs.map(globToRegExp);
  return (relPath) => {
    const p = relPath.replace(/\\/g, "/");
    return res.some((re) => re.test(p));
  };
}
