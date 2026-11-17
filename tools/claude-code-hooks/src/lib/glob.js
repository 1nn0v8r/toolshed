// @ts-check

/**
 * Normalize a path for matching: forward slashes, collapsed separators,
 * no leading "./".
 * @param {string} p
 */
export function normalizePath(p) {
  let s = String(p).trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

/** @param {string} p */
export function baseName(p) {
  const n = normalizePath(p).replace(/\/+$/, "");
  const i = n.lastIndexOf("/");
  return i === -1 ? n : n.slice(i + 1);
}

/**
 * Convert a glob to a regular expression source (unanchored).
 * Supports *, **, ?, [abc], {a,b}.
 * @param {string} glob
 */
export function globToSource(glob) {
  let re = "";
  let braces = 0;
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 2;
        if (glob[i] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (c === "{") {
      braces++;
      re += "(?:";
      i++;
      continue;
    }
    if (c === "}" && braces > 0) {
      braces--;
      re += ")";
      i++;
      continue;
    }
    if (c === "," && braces > 0) {
      re += "|";
      i++;
      continue;
    }
    if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end !== -1) {
        let body = glob.slice(i + 1, end);
        if (body[0] === "!") body = "^" + body.slice(1);
        re += "[" + body.replace(/\\/g, "\\\\") + "]";
        i = end + 1;
        continue;
      }
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  while (braces-- > 0) re += ")";
  return re;
}

/**
 * Case-insensitive glob match. A glob without "/" matches the file name;
 * a relative glob with "/" matches any trailing run of path segments; an
 * absolute glob must match the whole path. A trailing "/" means "everything
 * below".
 * @param {string} glob
 * @param {string} filePath
 */
export function matchGlob(glob, filePath) {
  let g = normalizePath(glob);
  const p = normalizePath(filePath);
  if (!g || !p) return false;
  if (g.endsWith("/")) g += "**";
  const re = new RegExp("^" + globToSource(g) + "$", "i");
  if (!g.includes("/")) return re.test(baseName(p));
  if (g.startsWith("/") || /^[A-Za-z]:\//.test(g)) return re.test(p);
  const parts = p.split("/");
  for (let i = 0; i < parts.length; i++) {
    if (re.test(parts.slice(i).join("/"))) return true;
  }
  return false;
}

/**
 * @param {string[]} globs
 * @param {string} filePath
 */
export function matchesAny(globs, filePath) {
  return globs.some((g) => matchGlob(g, filePath));
}
