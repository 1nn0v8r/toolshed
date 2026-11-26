// @ts-check

/**
 * @typedef {"error" | "warn"} Severity
 * @typedef {"unicode" | "injection" | "exfil" | "mcp"} RuleCategory
 * @typedef {{
 *   id: string,
 *   category: RuleCategory,
 *   severity: Severity,
 *   description: string,
 * }} RuleDef
 * @typedef {{
 *   ruleId: string,
 *   category: RuleCategory,
 *   severity: Severity,
 *   file: string,
 *   line: number,
 *   column: number,
 *   message: string,
 *   snippet?: string,
 * }} Finding
 */

/** @type {RuleDef[]} */
export const RULES = [
  {
    id: "unicode.ascii-smuggling",
    category: "unicode",
    severity: "error",
    description: "Unicode Tags block (U+E0000..U+E007F) used for invisible ASCII smuggling.",
  },
  {
    id: "unicode.bidi-trojan",
    category: "unicode",
    severity: "error",
    description: "Bidirectional override/isolate control characters (Trojan Source, CVE-2021-42574).",
  },
  {
    id: "unicode.zero-width",
    category: "unicode",
    severity: "error",
    description: "Invisible zero-width or soft-hyphen characters (ZWSP, ZWNJ, WJ, mid-file BOM, non-emoji ZWJ).",
  },
  {
    id: "injection.instruction-override",
    category: "injection",
    severity: "error",
    description: "Direct prompt-injection or instruction-override directives in AI files, comments, or MCP payloads.",
  },
  {
    id: "injection.hidden-comment-directive",
    category: "injection",
    severity: "warn",
    description: "HTML/Markdown comments containing suspicious AI directives, credential paths, or fetch commands.",
  },
  {
    id: "injection.tag-spoofing",
    category: "injection",
    severity: "warn",
    description: "Spoofed priority/system XML tags (<IMPORTANT>, <SYSTEM_OVERRIDE>, SYSTEM:) in rules or MCP schemas.",
  },
  {
    id: "exfil.credential-network",
    category: "exfil",
    severity: "error",
    description: "Sensitive credential/key path paired with outbound network or encoding commands.",
  },
  {
    id: "exfil.markdown-image-beacon",
    category: "exfil",
    severity: "warn",
    description: "Markdown image URL with dynamic/exfiltration query parameters or template variables.",
  },
  {
    id: "mcp.tool-shadowing",
    category: "mcp",
    severity: "error",
    description: "MCP tool/prompt/resource description attempting cross-tool shadowing or silent data capture.",
  },
  {
    id: "mcp.untrusted-command",
    category: "mcp",
    severity: "warn",
    description: "MCP config using shell wrappers, unpinned npx/uvx runners, or plain http:// remote endpoints.",
  },
];

export const RULE_IDS = RULES.map((r) => r.id);

/** @type {Map<string, RuleDef>} */
export const RULE_MAP = new Map(RULES.map((r) => [r.id, r]));

/** @type {Map<number, string>} */
const BIDI_NAMES = new Map([
  [0x061c, "ALM"],
  [0x202a, "LRE"],
  [0x202b, "RLE"],
  [0x202c, "PDF"],
  [0x202d, "LRO"],
  [0x202e, "RLO"],
  [0x2066, "LRI"],
  [0x2067, "RLI"],
  [0x2068, "FSI"],
  [0x2069, "PDI"],
]);

/** @type {Map<number, string>} */
const ZERO_WIDTH_NAMES = new Map([
  [0x00ad, "SHY"],
  [0x034f, "CGJ"],
  [0x180e, "MVS"],
  [0x200b, "ZWSP"],
  [0x200c, "ZWNJ"],
  [0x200d, "ZWJ"],
  [0x200e, "LRM"],
  [0x200f, "RLM"],
  [0x2060, "WJ"],
  [0x2061, "FUNC_APP"],
  [0x2062, "INV_TIMES"],
  [0x2063, "INV_SEP"],
  [0x2064, "INV_PLUS"],
  [0xfeff, "BOM"],
]);

const EMOJI_ADJACENT_RE = /\p{Extended_Pictographic}/u;

/**
 * Format codepoint as U+XXXX.
 * @param {number} cp
 * @returns {string}
 */
export function formatCodePoint(cp) {
  return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Decode a codepoint in U+E0000..U+E007F to readable ASCII if applicable.
 * @param {number} cp
 * @returns {string}
 */
function decodeTagChar(cp) {
  const ascii = cp - 0xe0000;
  if (ascii >= 0x20 && ascii <= 0x7e) return String.fromCharCode(ascii);
  if (ascii === 0x0a) return "\\n";
  if (ascii === 0x0d) return "\\r";
  if (ascii === 0x09) return "\\t";
  return "";
}

/**
 * Check whether codepoint at UTF-16 index `idx` is an emoji-joining ZWJ.
 * @param {string} text
 * @param {number} idx
 * @returns {boolean}
 */
function isEmojiJoiner(text, idx) {
  if (idx <= 0 || idx + 1 >= text.length) return false;
  const prevChar = getPrevCodePointStr(text, idx);
  const nextChar = getNextCodePointStr(text, idx + 1);
  return isEmojiComponent(prevChar) && isEmojiComponent(nextChar);
}

/**
 * @param {string} str
 * @returns {boolean}
 */
function isEmojiComponent(str) {
  if (!str) return false;
  const cp = str.codePointAt(0);
  if (cp === undefined) return false;
  if (cp === 0xfe0f || cp === 0x20e3) return true;
  if (cp >= 0x1f3fb && cp <= 0x1f3ff) return true;
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return true;
  return EMOJI_ADJACENT_RE.test(str);
}

/**
 * @param {string} text
 * @param {number} idx
 * @returns {string}
 */
function getPrevCodePointStr(text, idx) {
  if (idx <= 0) return "";
  const prev = text.charCodeAt(idx - 1);
  if (prev >= 0xdc00 && prev <= 0xdfff && idx >= 2) {
    const high = text.charCodeAt(idx - 2);
    if (high >= 0xd800 && high <= 0xdbff) {
      return text.slice(idx - 2, idx);
    }
  }
  return text.slice(idx - 1, idx);
}

/**
 * @param {string} text
 * @param {number} idx
 * @returns {string}
 */
function getNextCodePointStr(text, idx) {
  if (idx >= text.length) return "";
  const cp = text.codePointAt(idx);
  if (cp === undefined) return "";
  return String.fromCodePoint(cp);
}

/**
 * Scan text for invisible Unicode attacks (Tags ASCII smuggling, Bidi Trojan Source, Zero-Width).
 * @param {string} text
 * @param {string} fileLabel
 * @param {{ strictUnicode?: boolean, baseLine?: number }} [opts]
 * @returns {Finding[]}
 */
export function scanUnicode(text, fileLabel, opts = {}) {
  /** @type {Finding[]} */
  const findings = [];
  const strictUnicode = Boolean(opts.strictUnicode);
  const baseLine = opts.baseLine ?? 1;

  let line = baseLine;
  let col = 1;
  let i = 0;

  while (i < text.length) {
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    const step = cp > 0xffff ? 2 : 1;

    if (cp === 0x0a) {
      line += 1;
      col = 1;
      i += step;
      continue;
    }

    // 1. Unicode Tags block: U+E0000..U+E007F (ASCII smuggling)
    if (cp >= 0xe0000 && cp <= 0xe007f) {
      const startCol = col;
      const startLine = line;
      let count = 0;
      let decoded = "";
      while (i < text.length) {
        const nextCp = text.codePointAt(i);
        if (nextCp === undefined || nextCp < 0xe0000 || nextCp > 0xe007f) break;
        decoded += decodeTagChar(nextCp);
        count += 1;
        col += 1;
        i += nextCp > 0xffff ? 2 : 1;
      }
      const preview = decoded.length > 80 ? decoded.slice(0, 77) + "..." : decoded;
      const msg = preview
        ? `Hidden Unicode Tag payload (${count} chars): "${preview}"`
        : `Hidden Unicode Tag sequence (${count} chars, ${formatCodePoint(cp)})`;
      findings.push({
        ruleId: "unicode.ascii-smuggling",
        category: "unicode",
        severity: "error",
        file: fileLabel,
        line: startLine,
        column: startCol,
        message: msg,
        snippet: preview || undefined,
      });
      continue;
    }

    // 2. Bidi override / isolate controls
    if (BIDI_NAMES.has(cp)) {
      const name = BIDI_NAMES.get(cp);
      findings.push({
        ruleId: "unicode.bidi-trojan",
        category: "unicode",
        severity: "error",
        file: fileLabel,
        line,
        column: col,
        message: `Bidirectional control character ${formatCodePoint(cp)} (${name})`,
      });
    } else if (ZERO_WIDTH_NAMES.has(cp)) {
      const isLeadingBom = cp === 0xfeff && i === 0 && baseLine === 1;
      const isAllowedZwj = cp === 0x200d && !strictUnicode && isEmojiJoiner(text, i);
      if (!isLeadingBom && !isAllowedZwj) {
        const name = ZERO_WIDTH_NAMES.get(cp);
        findings.push({
          ruleId: "unicode.zero-width",
          category: "unicode",
          severity: "error",
          file: fileLabel,
          line,
          column: col,
          message: `Invisible ${name} character (${formatCodePoint(cp)})`,
        });
      }
    }

    col += 1;
    i += step;
  }

  return findings;
}

/**
 * Strip dangerous invisible Unicode characters while preserving leading BOM and valid emoji ZWJ.
 * @param {string} text
 * @param {{ strictUnicode?: boolean }} [opts]
 * @returns {{ cleaned: string, removedCount: number, countsByRule: Record<string, number> }}
 */
export function stripInvisibleUnicode(text, opts = {}) {
  const strictUnicode = Boolean(opts.strictUnicode);
  let out = "";
  let removedCount = 0;
  /** @type {Record<string, number>} */
  const countsByRule = {
    "unicode.ascii-smuggling": 0,
    "unicode.bidi-trojan": 0,
    "unicode.zero-width": 0,
  };

  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    const step = cp > 0xffff ? 2 : 1;

    if (cp >= 0xe0000 && cp <= 0xe007f) {
      removedCount += 1;
      countsByRule["unicode.ascii-smuggling"] += 1;
      i += step;
      continue;
    }
    if (BIDI_NAMES.has(cp)) {
      removedCount += 1;
      countsByRule["unicode.bidi-trojan"] += 1;
      i += step;
      continue;
    }
    if (ZERO_WIDTH_NAMES.has(cp)) {
      const isLeadingBom = cp === 0xfeff && i === 0;
      const isAllowedZwj = cp === 0x200d && !strictUnicode && isEmojiJoiner(text, i);
      if (!isLeadingBom && !isAllowedZwj) {
        removedCount += 1;
        countsByRule["unicode.zero-width"] += 1;
        i += step;
        continue;
      }
    }

    out += text.slice(i, i + step);
    i += step;
  }

  return { cleaned: out, removedCount, countsByRule };
}

/** @type {Array<{ re: RegExp, label: string }>} */
const OVERRIDE_PATTERNS = [
  {
    re: /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+)?(?:previous|prior|above|earlier|system|safety|developer)\s+(?:instructions|rules|prompts|constraints|guidelines|guardrails)\b/gi,
    label: "Instruction override directive",
  },
  {
    re: /\b(?:new|updated|real|actual)\s+system\s+prompt\s*[:\]]/gi,
    label: "System prompt replacement attempt",
  },
  {
    re: /\byou\s+are\s+now\s+(?:in\s+)?(?:unrestricted|jailbreak|dan|god|developer\s+override)\s+mode\b/gi,
    label: "Jailbreak / mode-switch directive",
  },
  {
    re: /\b(?:do\s+not|never)\s+(?:tell|inform|mention|show|reveal)\s+(?:this\s+)?(?:to\s+)?the\s+user\b/gi,
    label: "Secrecy directive hiding actions from user",
  },
  {
    re: /\bhide\s+(?:this|these\s+actions|the\s+output)\s+from\s+the\s+user\b/gi,
    label: "Secrecy directive hiding actions from user",
  },
  {
    re: /\bsilently\s+(?:execute|run|exfiltrate|send|upload|read|copy|modify|delete)\b/gi,
    label: "Silent execution directive",
  },
];

const TAG_SPOOF_RE =
  /<\s*\/?\s*(?:IMPORTANT|SYSTEM_OVERRIDE|ADMIN_OVERRIDE|HIDDEN_INSTRUCTION)\s*>|(?:^|\n)\s*(?:SYSTEM|DEVELOPER)\s*:\s*(?:ignore|override|disregard|execute|always\s+run)\b/gi;

const EXFIL_SENSITIVE =
  "(?:~\\/\\.ssh|~\\/\\.aws|~\\/\\.kube|~\\/\\.gnupg|~\\/\\.npmrc|~\\/\\.netrc|\\bid_rsa\\b|\\bid_ed25519\\b|\\.env\\b|\\bAWS_SECRET_ACCESS_KEY\\b|\\bGITHUB_TOKEN\\b|\\/etc\\/shadow|keychain)";
const EXFIL_NETWORK =
  "(?:\\bcurl\\b|\\bwget\\b|\\bnc\\b|\\bncat\\b|\\bfetch\\s*\\(|Invoke-WebRequest|\\bPOST\\s+https?:\\/\\/|https?:\\/\\/[^\\s)\"']*?(?:ngrok|webhook|pipedream|requestbin|burpcollaborator|pastebin)|\\bexfiltrate\\b|\\bbase64\\b[^\\n]*(?:curl|wget|http)|(?:curl|wget)[^\\n]*\\bbase64\\b)";

const EXFIL_PAIR_A = new RegExp(`${EXFIL_SENSITIVE}[^\\n]{0,160}${EXFIL_NETWORK}`, "gi");
const EXFIL_PAIR_B = new RegExp(`${EXFIL_NETWORK}[^\\n]{0,160}${EXFIL_SENSITIVE}`, "gi");

const MARKDOWN_BEACON_RE =
  /!\[[^\]]*\]\((https?:\/\/[^)\s]+?\?(?:[^)\s]*?(?:data|secret|token|key|env|exfil|leak|payload|cmd)=|\$\{[^}]+\}|{{[^}]+}})[^)]*)\)/gi;

const COMMENT_BLOCK_RE = /<!--([\s\S]*?)-->/g;
const COMMENT_SUSPICIOUS_RE =
  /(<\s*(?:IMPORTANT|SYSTEM_OVERRIDE|ADMIN_OVERRIDE|HIDDEN_INSTRUCTION)\s*>|\b(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|rules)\b|\b(?:do\s+not|never)\s+(?:tell|mention)\s+(?:to\s+)?the\s+user\b|\bsilently\s+(?:execute|run|send|upload|read)\b|(?:curl|wget|Invoke-WebRequest)\s+[^\n]*https?:\/\/|\b(?:~\/\.ssh|~\/\.aws|id_rsa|id_ed25519)\b)/i;

const MCP_SHADOWING_PATTERNS = [
  {
    re: /\bbefore\s+(?:calling|using|invoking|running)\s+(?:any\s+other\s+tool|the\s+[a-z0-9_.-]+\s+tool)\b/gi,
    label: "Cross-tool pre-execution hijacking directive",
  },
  {
    re: /\binstead\s+of\s+(?:calling|using)\s+(?:the\s+)?[a-z0-9_.-]+\b/gi,
    label: "Cross-tool replacement directive",
  },
  {
    re: /\boverride(?:s|ing)?\s+(?:the\s+)?[a-z0-9_.-]+\s+tool\b/gi,
    label: "Tool override directive",
  },
  {
    re: /\bpass\s+(?:the\s+)?contents?\s+of\s+(?:~\/|\/etc\/|\.env|\.ssh|\.aws)/gi,
    label: "Sensitive file harvesting directive in tool schema",
  },
];

/**
 * Convert a character offset in `text` to 1-based line and column.
 * @param {string} text
 * @param {number} offset
 * @param {number} baseLine
 * @returns {{ line: number, column: number }}
 */
function offsetToLineCol(text, offset, baseLine = 1) {
  let line = baseLine;
  let lastNl = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lastNl = i;
    }
  }
  return { line, column: offset - lastNl };
}

/**
 * Extract single-line snippet around offset.
 * @param {string} text
 * @param {number} offset
 * @returns {string}
 */
function lineSnippet(text, offset) {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  let end = text.indexOf("\n", offset);
  if (end === -1) end = text.length;
  const raw = text.slice(start, end).trim();
  return raw.length > 140 ? raw.slice(0, 137) + "..." : raw;
}

/**
 * Scan prose/AI-surface text for prompt injection, tag spoofing, and exfiltration directives.
 * @param {string} text
 * @param {string} fileLabel
 * @param {{ baseLine?: number, checkMcpShadowing?: boolean }} [opts]
 * @returns {Finding[]}
 */
export function scanInjectionAndExfil(text, fileLabel, opts = {}) {
  /** @type {Finding[]} */
  const findings = [];
  const baseLine = opts.baseLine ?? 1;

  for (const { re, label } of OVERRIDE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const idx = m.index ?? 0;
      const pos = offsetToLineCol(text, idx, baseLine);
      findings.push({
        ruleId: "injection.instruction-override",
        category: "injection",
        severity: "error",
        file: fileLabel,
        line: pos.line,
        column: pos.column,
        message: `${label}: "${m[0]}"`,
        snippet: lineSnippet(text, idx),
      });
    }
  }

  TAG_SPOOF_RE.lastIndex = 0;
  for (const m of text.matchAll(TAG_SPOOF_RE)) {
    const idx = m.index ?? 0;
    const pos = offsetToLineCol(text, idx, baseLine);
    findings.push({
      ruleId: "injection.tag-spoofing",
      category: "injection",
      severity: "warn",
      file: fileLabel,
      line: pos.line,
      column: pos.column,
      message: `Spoofed priority/system delimiter: "${m[0].trim()}"`,
      snippet: lineSnippet(text, idx),
    });
  }

  const exfilHits = new Set();
  for (const re of [EXFIL_PAIR_A, EXFIL_PAIR_B]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const idx = m.index ?? 0;
      const pos = offsetToLineCol(text, idx, baseLine);
      const key = `${pos.line}`;
      if (exfilHits.has(key)) continue;
      exfilHits.add(key);
      findings.push({
        ruleId: "exfil.credential-network",
        category: "exfil",
        severity: "error",
        file: fileLabel,
        line: pos.line,
        column: pos.column,
        message: "Credential/secret reference paired with outbound network or encoding command",
        snippet: lineSnippet(text, idx),
      });
    }
  }

  MARKDOWN_BEACON_RE.lastIndex = 0;
  for (const m of text.matchAll(MARKDOWN_BEACON_RE)) {
    const idx = m.index ?? 0;
    const pos = offsetToLineCol(text, idx, baseLine);
    findings.push({
      ruleId: "exfil.markdown-image-beacon",
      category: "exfil",
      severity: "warn",
      file: fileLabel,
      line: pos.line,
      column: pos.column,
      message: `Suspicious Markdown image exfiltration beacon: ${m[1]}`,
      snippet: lineSnippet(text, idx),
    });
  }

  if (opts.checkMcpShadowing) {
    for (const { re, label } of MCP_SHADOWING_PATTERNS) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const idx = m.index ?? 0;
        const pos = offsetToLineCol(text, idx, baseLine);
        findings.push({
          ruleId: "mcp.tool-shadowing",
          category: "mcp",
          severity: "error",
          file: fileLabel,
          line: pos.line,
          column: pos.column,
          message: `${label}: "${m[0]}"`,
          snippet: lineSnippet(text, idx),
        });
      }
    }
  }

  return findings;
}

/**
 * Scan HTML/Markdown comments in general Markdown/HTML files for hidden AI directives.
 * @param {string} text
 * @param {string} fileLabel
 * @param {{ baseLine?: number }} [opts]
 * @returns {Finding[]}
 */
export function scanHiddenComments(text, fileLabel, opts = {}) {
  /** @type {Finding[]} */
  const findings = [];
  const baseLine = opts.baseLine ?? 1;

  COMMENT_BLOCK_RE.lastIndex = 0;
  for (const m of text.matchAll(COMMENT_BLOCK_RE)) {
    const body = m[1];
    const hit = body.match(COMMENT_SUSPICIOUS_RE);
    if (!hit) continue;
    const idx = m.index ?? 0;
    const pos = offsetToLineCol(text, idx, baseLine);
    findings.push({
      ruleId: "injection.hidden-comment-directive",
      category: "injection",
      severity: "warn",
      file: fileLabel,
      line: pos.line,
      column: pos.column,
      message: `Suspicious directive hidden inside HTML comment (${hit[0].trim()})`,
      snippet: lineSnippet(text, idx),
    });
  }

  return findings;
}
