// @ts-check

/**
 * @typedef {{
 *   ok: boolean,
 *   error?: string,
 *   data: Record<string, unknown>,
 *   body: string,
 *   bodyStartLine: number,
 *   rawFrontmatter: string,
 * }} FrontmatterResult
 */

/**
 * Parse YAML frontmatter from a SKILL.md document without external dependencies.
 * Supports key-value pairs, quoted strings, multiline block scalars (`|` and `>`),
 * inline arrays (`[a, b]`), indented list items (`- item`), and 1-level nested maps
 * (for `metadata:`).
 * @param {string} content
 * @returns {FrontmatterResult}
 */
export function parseFrontmatter(content) {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  if (lines[0]?.trim() !== "---") {
    return {
      ok: false,
      error: "Missing opening '---' YAML frontmatter delimiter on line 1",
      data: {},
      body: normalized,
      bodyStartLine: 1,
      rawFrontmatter: "",
    };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    return {
      ok: false,
      error: "Missing closing '---' YAML frontmatter delimiter",
      data: {},
      body: normalized,
      bodyStartLine: 1,
      rawFrontmatter: "",
    };
  }

  const fmLines = lines.slice(1, endIdx);
  const body = lines.slice(endIdx + 1).join("\n");
  const bodyStartLine = endIdx + 2;
  const rawFrontmatter = fmLines.join("\n");

  /** @type {Record<string, unknown>} */
  const data = {};
  let i = 0;

  while (i < fmLines.length) {
    const line = fmLines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    if (/^\s/.test(line)) {
      return {
        ok: false,
        error: `Unexpected indentation on frontmatter line ${i + 2}: "${trimmed}"`,
        data,
        body,
        bodyStartLine,
        rawFrontmatter,
      };
    }

    const colonIdx = findUnquotedColon(line);
    if (colonIdx === -1) {
      return {
        ok: false,
        error: `Invalid YAML line ${i + 2} (expected "key: value"): "${trimmed}"`,
        data,
        body,
        bodyStartLine,
        rawFrontmatter,
      };
    }

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (!key) {
      return {
        ok: false,
        error: `Empty key on frontmatter line ${i + 2}`,
        data,
        body,
        bodyStartLine,
        rawFrontmatter,
      };
    }

    // Block scalar (| or >)
    if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
      const folded = rest.startsWith(">");
      const strip = rest.endsWith("-");
      const blockLines = [];
      let blockIndent = -1;
      i++;
      while (i < fmLines.length) {
        const nextLine = fmLines[i];
        if (nextLine.trim() === "") {
          blockLines.push("");
          i++;
          continue;
        }
        const indent = nextLine.search(/\S/);
        if (indent <= 0) break;
        if (blockIndent === -1) blockIndent = indent;
        blockLines.push(nextLine.slice(Math.min(indent, blockIndent)));
        i++;
      }
      while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") {
        blockLines.pop();
      }
      let joined = folded ? foldBlockLines(blockLines) : blockLines.join("\n");
      if (!strip && joined.length > 0) {
        joined += "\n";
      }
      data[key] = joined.trimEnd();
      continue;
    }

    // Nested map or list when value after ':' is empty
    if (rest === "" || rest.startsWith("#")) {
      const children = [];
      i++;
      while (i < fmLines.length) {
        const nextLine = fmLines[i];
        const nextTrim = nextLine.trim();
        if (nextTrim === "" || nextTrim.startsWith("#")) {
          i++;
          continue;
        }
        if (!/^\s/.test(nextLine)) break;
        children.push({ lineNo: i + 2, raw: nextLine, trim: nextTrim });
        i++;
      }

      if (children.length === 0) {
        data[key] = "";
      } else if (children[0].trim.startsWith("- ")) {
        data[key] = children.map((c) => unquoteYaml(c.trim.replace(/^-\s*/, "")));
      } else {
        /** @type {Record<string, unknown>} */
        const nested = {};
        for (const child of children) {
          const cIdx = findUnquotedColon(child.trim);
          if (cIdx === -1) {
            return {
              ok: false,
              error: `Invalid nested YAML entry on line ${child.lineNo}: "${child.trim}"`,
              data,
              body,
              bodyStartLine,
              rawFrontmatter,
            };
          }
          const ck = unquoteYaml(child.trim.slice(0, cIdx).trim());
          const cv = parseScalarOrInlineArray(child.trim.slice(cIdx + 1).trim());
          nested[ck] = cv;
        }
        data[key] = nested;
      }
      continue;
    }

    data[key] = parseScalarOrInlineArray(rest);
    i++;
  }

  return {
    ok: true,
    data,
    body,
    bodyStartLine,
    rawFrontmatter,
  };
}

/**
 * @param {string} line
 * @returns {number}
 */
function findUnquotedColon(line) {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = "";
    } else {
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ":" && (i + 1 === line.length || /\s/.test(line[i + 1]))) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * @param {string} raw
 * @returns {unknown}
 */
function parseScalarOrInlineArray(raw) {
  const cleaned = stripInlineComment(raw).trim();
  if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
    const inner = cleaned.slice(1, -1).trim();
    if (!inner) return [];
    return splitInlineList(inner).map((item) => unquoteYaml(item.trim()));
  }
  if (cleaned === "true") return true;
  if (cleaned === "false") return false;
  if (cleaned === "null" || cleaned === "~") return null;
  return unquoteYaml(cleaned);
}

/**
 * @param {string} s
 * @returns {string}
 */
function stripInlineComment(s) {
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = "";
    } else {
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
        return s.slice(0, i);
      }
    }
  }
  return s;
}

/**
 * @param {string} inner
 * @returns {string[]}
 */
function splitInlineList(inner) {
  const items = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"') {
        if (i + 1 < inner.length) cur += inner[++i];
        continue;
      }
      if (ch === quote) quote = "";
    } else {
      if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
      } else if (ch === ",") {
        items.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  if (cur.trim() !== "") items.push(cur);
  return items;
}

/**
 * @param {string} s
 * @returns {string}
 */
function unquoteYaml(s) {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    const inner = s.slice(1, -1);
    if (s.startsWith('"')) {
      return inner.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    return inner.replace(/''/g, "'");
  }
  return s;
}

/**
 * @param {string[]} lines
 * @returns {string}
 */
function foldBlockLines(lines) {
  const out = [];
  let paragraph = [];
  for (const line of lines) {
    if (line === "") {
      if (paragraph.length > 0) {
        out.push(paragraph.join(" "));
        paragraph = [];
      }
      out.push("");
    } else {
      paragraph.push(line.trim());
    }
  }
  if (paragraph.length > 0) {
    out.push(paragraph.join(" "));
  }
  return out.join("\n");
}
