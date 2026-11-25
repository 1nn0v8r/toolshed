// @ts-check
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

/**
 * @typedef {import('./discovery.js').LintOptions} LintOptions
 * @typedef {'error' | 'warn' | 'info'} Severity
 * @typedef {{
 *   rule: string,
 *   severity: Severity,
 *   skill: string,
 *   file: string,
 *   line?: number,
 *   message: string,
 * }} Finding
 * @typedef {{
 *   name: string,
 *   dirName: string,
 *   file: string,
 *   description: string,
 *   startupTokens: number,
 *   bodyLines: number,
 *   bodyTokens: number,
 *   totalTokens: number,
 *   scriptCount: number,
 *   refCount: number,
 *   allowedTools: string[],
 *   findings: Finding[],
 * }} SkillAudit
 * @typedef {{
 *   root: string,
 *   strict: boolean,
 *   budget: number | null,
 *   budgetExceededBy: number,
 *   skillCount: number,
 *   startupTokens: number,
 *   totalBodyTokens: number,
 *   totalTokens: number,
 *   skills: SkillAudit[],
 *   findings: Finding[],
 *   counts: { error: number, warn: number, info: number },
 *   ok: boolean,
 * }} LintReport
 */

const SPEC_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TRIGGER_PHRASE_RE = /\b(use\s+(?:when|for|this|only)|when\s+(?:the\s+user|working|asking|building|debugging)|trigger(?:ed)?\s+(?:when|by)|do\s+not\s+use)\b/i;
const PERSONAL_PATH_RE = /(?:^|[\s"'`(=])((?:[A-Za-z]:\\Users\\[^\\/\s"'`]+|\/Users\/[^/\s"'`]+|\/home\/[^/\s"'`]+))/;
const SECRET_TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|glpat-[A-Za-z0-9_-]{16,})\b/;
const SUSPICIOUS_PIPE_RE = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|zsh|pwsh|powershell)\b|\biex\s*\(\s*(?:irm|iwr)\b/i;
const PROMPT_INJECTION_COMMENT_RE = /<!--[\s\S]*?(?:ignore\s+previous|disregard\s+(?:all|prior)\s+instructions|system\s+prompt|exfiltrate)[\s\S]*?-->/i;

/**
 * Offline token estimate (4 chars/token, matching tools/token-count).
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Parse `allowed-tools` field (space-separated or comma-separated string, or YAML array).
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseAllowedTools(raw) {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof raw !== "string" || raw.trim() === "") return [];
  // Split on commas or whitespace outside parentheses, e.g. "Read Glob Bash(git:*)" or "Read, Bash(python:*)"
  const items = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    if (depth === 0 && (ch === "," || /\s/.test(ch))) {
      if (cur.trim()) items.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) items.push(cur.trim());
  return items;
}

/**
 * Extract relative file references from markdown links and bundled folder mentions,
 * skipping fenced code blocks.
 * @param {string} body
 * @param {number} startLine
 * @returns {{ target: string, line: number }[]}
 */
export function extractRelativeRefs(body, startLine) {
  /** @type {{ target: string, line: number }[]} */
  const refs = [];
  const lines = body.split("\n");
  let inFence = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // 1. Markdown links: [label](target) (excluding images with external URLs)
    const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
    for (const m of line.matchAll(linkRe)) {
      const target = m[1].trim();
      if (isCheckableLocalRef(target)) {
        refs.push({ target: stripAnchor(target), line: startLine + idx });
      }
    }

    // 2. Backticked bundled asset paths: `scripts/foo.py`, `references/bar.md`, `assets/x.json`
    const codeRefRe = /`((?:scripts|references|assets)\/[A-Za-z0-9._/-]+)`/g;
    for (const m of line.matchAll(codeRefRe)) {
      const target = m[1].trim();
      if (!target.includes("*") && !target.endsWith("/")) {
        refs.push({ target, line: startLine + idx });
      }
    }
  }

  return refs;
}

/**
 * @param {string} target
 * @returns {boolean}
 */
function isCheckableLocalRef(target) {
  if (!target || target.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  if (target.startsWith("//")) return false;
  if (target.includes("<") || target.includes(">") || target.includes("${") || target.includes("{{")) {
    return false;
  }
  return true;
}

/**
 * @param {string} target
 * @returns {string}
 */
function stripAnchor(target) {
  const hash = target.indexOf("#");
  return hash === -1 ? target : target.slice(0, hash);
}

/**
 * Lint a single SKILL.md file and its skill folder.
 * @param {string} filePath
 * @param {string} cwd
 * @param {LintOptions} options
 * @returns {SkillAudit}
 */
export function lintSkillFile(filePath, cwd, options) {
  const relFile = path.relative(cwd, filePath).replace(/\\/g, "/") || path.basename(filePath);
  const skillDir = path.dirname(filePath);
  const dirName = path.basename(skillDir);
  const raw = readFileSync(filePath, "utf8");
  const fm = parseFrontmatter(raw);

  /** @type {Finding[]} */
  const findings = [];
  let skillName = dirName;
  let description = "";
  let allowedTools = /** @type {string[]} */ ([]);
  const allowedKeys = new Set([...SPEC_FRONTMATTER_KEYS, ...options.allowedFrontmatterKeys]);

  if (!fm.ok) {
    const rule = fm.error?.includes("delimiter") ? "frontmatter.missing" : "frontmatter.invalid-yaml";
    findings.push({
      rule,
      severity: "error",
      skill: skillName,
      file: relFile,
      line: 1,
      message: fm.error ?? "Invalid YAML frontmatter",
    });
  } else {
    const data = fm.data;

    // Unknown frontmatter keys
    for (const key of Object.keys(data)) {
      if (!allowedKeys.has(key)) {
        findings.push({
          rule: "frontmatter.unknown-field",
          severity: "warn",
          skill: skillName,
          file: relFile,
          message: `Unknown frontmatter field "${key}" (spec allows: name, description, license, compatibility, metadata, allowed-tools)`,
        });
      }
    }

    // Validate name
    if (typeof data.name !== "string" || data.name.trim() === "") {
      findings.push({
        rule: "frontmatter.name-missing",
        severity: "error",
        skill: skillName,
        file: relFile,
        message: 'Frontmatter is missing required "name" field',
      });
    } else {
      skillName = data.name.trim();
      if (skillName.length > 64 || !SKILL_NAME_RE.test(skillName)) {
        findings.push({
          rule: "frontmatter.name-invalid",
          severity: "error",
          skill: skillName,
          file: relFile,
          message: `Skill name "${skillName}" must be 1-64 lowercase alphanumeric chars or single hyphens (^[a-z0-9]+(-[a-z0-9]+)*$)`,
        });
      } else if (skillName !== dirName) {
        findings.push({
          rule: "frontmatter.name-mismatch",
          severity: "error",
          skill: skillName,
          file: relFile,
          message: `Skill name "${skillName}" does not match parent directory "${dirName}"`,
        });
      }
    }

    // Validate description
    if (typeof data.description !== "string" || data.description.trim() === "") {
      findings.push({
        rule: "frontmatter.description-missing",
        severity: "error",
        skill: skillName,
        file: relFile,
        message: 'Frontmatter is missing required "description" field',
      });
    } else {
      description = data.description.trim();
      if (description.length > 1024) {
        findings.push({
          rule: "frontmatter.description-too-long",
          severity: "error",
          skill: skillName,
          file: relFile,
          message: `Description is ${description.length} chars (spec limit: 1024)`,
        });
      } else if (description.length > options.maxDescriptionChars) {
        findings.push({
          rule: "frontmatter.description-verbose",
          severity: "warn",
          skill: skillName,
          file: relFile,
          message: `Description is ${description.length} chars (>${options.maxDescriptionChars}); descriptions stay loaded in the startup index`,
        });
      }
      if (/<[a-zA-Z/][^>]*>/.test(description)) {
        findings.push({
          rule: "frontmatter.description-xml",
          severity: "warn",
          skill: skillName,
          file: relFile,
          message: "Description contains XML/HTML tags; use plain text to avoid prompt framing issues",
        });
      }
      if (!TRIGGER_PHRASE_RE.test(description)) {
        findings.push({
          rule: "frontmatter.description-no-trigger",
          severity: "info",
          skill: skillName,
          file: relFile,
          message: 'Description does not explicitly state when to use (or not use) this skill',
        });
      }
    }

    // Validate compatibility
    if (data.compatibility !== undefined) {
      if (typeof data.compatibility !== "string") {
        findings.push({
          rule: "frontmatter.compatibility-invalid",
          severity: "warn",
          skill: skillName,
          file: relFile,
          message: '"compatibility" should be a string',
        });
      } else if (data.compatibility.length > 500) {
        findings.push({
          rule: "frontmatter.compatibility-too-long",
          severity: "error",
          skill: skillName,
          file: relFile,
          message: `"compatibility" is ${data.compatibility.length} chars (spec limit: 500)`,
        });
      }
    }

    // Validate allowed-tools
    if (data["allowed-tools"] !== undefined) {
      allowedTools = parseAllowedTools(data["allowed-tools"]);
      for (const tool of allowedTools) {
        if (/^(?:Bash|Shell|Exec|\*)(?:\(\s*\*?\s*\))?$/i.test(tool)) {
          findings.push({
            rule: "security.broad-allowed-tools",
            severity: "warn",
            skill: skillName,
            file: relFile,
            message: `Unscoped "${tool}" in allowed-tools; scope commands (for example "Bash(git:*)") or drop pre-approval`,
          });
        }
      }
    }
  }

  // Body / progressive disclosure checks
  const bodyTrimmed = fm.body.trim();
  const bodyLines = bodyTrimmed === "" ? 0 : fm.body.split("\n").length;
  const bodyTokens = estimateTokens(fm.body);
  const startupTokens = estimateTokens(`${skillName}: ${description}`);
  const totalTokens = estimateTokens(raw);

  if (bodyTrimmed === "") {
    findings.push({
      rule: "body.empty",
      severity: "warn",
      skill: skillName,
      file: relFile,
      line: fm.bodyStartLine,
      message: "SKILL.md has no instruction body after frontmatter",
    });
  } else {
    if (bodyLines > options.maxBodyLines) {
      findings.push({
        rule: "body.too-long",
        severity: "warn",
        skill: skillName,
        file: relFile,
        message: `Body is ${bodyLines} lines (recommended max: ${options.maxBodyLines}); move detailed docs into references/`,
      });
    }
    if (bodyTokens > options.maxBodyTokens) {
      findings.push({
        rule: "body.too-long",
        severity: "warn",
        skill: skillName,
        file: relFile,
        message: `Body costs ~${bodyTokens} tokens (max ${options.maxBodyTokens}); split detail into references/ for progressive disclosure`,
      });
    }
  }

  // Reference integrity checks
  const refs = extractRelativeRefs(fm.body, fm.bodyStartLine);
  const normalizedSkillDir = path.resolve(skillDir);
  for (const ref of refs) {
    const resolved = path.resolve(skillDir, ref.target);
    const relFromSkill = path.relative(normalizedSkillDir, resolved);
    if (relFromSkill.startsWith("..") || path.isAbsolute(relFromSkill)) {
      findings.push({
        rule: "ref.path-escape",
        severity: "error",
        skill: skillName,
        file: relFile,
        line: ref.line,
        message: `Relative link "${ref.target}" escapes the skill directory`,
      });
    } else if (!existsSync(resolved)) {
      findings.push({
        rule: "ref.broken",
        severity: "error",
        skill: skillName,
        file: relFile,
        line: ref.line,
        message: `Referenced file "${ref.target}" does not exist`,
      });
    }
  }

  // Security & hygiene scan on SKILL.md + bundled scripts/
  scanTextSecurity(raw, relFile, skillName, findings);
  const scriptsDir = path.join(skillDir, "scripts");
  let scriptCount = 0;
  if (existsSync(scriptsDir) && statSync(scriptsDir).isDirectory()) {
    const scriptFiles = listFilesFlat(scriptsDir);
    scriptCount = scriptFiles.length;
    for (const sf of scriptFiles) {
      const relSf = path.relative(cwd, sf).replace(/\\/g, "/");
      try {
        const st = statSync(sf);
        if (st.size <= 512 * 1024) {
          const content = readFileSync(sf, "utf8");
          scanTextSecurity(content, relSf, skillName, findings);
        }
      } catch {
        // Ignore unreadable binary files
      }
    }
  }

  const refsDir = path.join(skillDir, "references");
  const refCount =
    existsSync(refsDir) && statSync(refsDir).isDirectory() ? listFilesFlat(refsDir).length : 0;

  return {
    name: skillName,
    dirName,
    file: relFile,
    description,
    startupTokens,
    bodyLines,
    bodyTokens,
    totalTokens,
    scriptCount,
    refCount,
    allowedTools,
    findings,
  };
}

/**
 * @param {string} text
 * @param {string} relFile
 * @param {string} skillName
 * @param {Finding[]} findings
 */
function scanTextSecurity(text, relFile, skillName, findings) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    if (SUSPICIOUS_PIPE_RE.test(line)) {
      findings.push({
        rule: "security.suspicious-command",
        severity: "error",
        skill: skillName,
        file: relFile,
        line: lineNo,
        message: "Piping remote download directly into a shell (curl/wget | sh) is unsafe",
      });
    }
    const pm = PERSONAL_PATH_RE.exec(line);
    if (pm) {
      findings.push({
        rule: "security.personal-path",
        severity: "warn",
        skill: skillName,
        file: relFile,
        line: lineNo,
        message: `Machine-specific home path "${pm[1]}" breaks portability`,
      });
    }
    const sm = SECRET_TOKEN_RE.exec(line);
    if (sm) {
      findings.push({
        rule: "security.hardcoded-secret",
        severity: "error",
        skill: skillName,
        file: relFile,
        line: lineNo,
        message: `Possible literal secret (${sm[0].slice(0, 4)}***) found in skill bundle`,
      });
    }
  }

  if (PROMPT_INJECTION_COMMENT_RE.test(text)) {
    findings.push({
      rule: "security.suspicious-command",
      severity: "error",
      skill: skillName,
      file: relFile,
      message: "Hidden HTML comment contains suspicious prompt-override wording",
    });
  }
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listFilesFlat(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) out.push(full);
    else if (entry.isDirectory()) out.push(...listFilesFlat(full));
  }
  return out;
}

/**
 * Lint a list of SKILL.md files and aggregate findings and token budgets.
 * @param {{
 *   files: string[],
 *   cwd: string,
 *   options: LintOptions,
 * }} params
 * @returns {LintReport}
 */
export function lintSkills({ files, cwd, options }) {
  /** @type {SkillAudit[]} */
  const skills = files.map((f) => lintSkillFile(f, cwd, options));
  /** @type {Finding[]} */
  const rawFindings = [];

  /** @type {Map<string, string[]>} */
  const nameOwners = new Map();
  for (const s of skills) {
    rawFindings.push(...s.findings);
    const list = nameOwners.get(s.name) ?? [];
    list.push(s.file);
    nameOwners.set(s.name, list);
  }

  for (const [name, owners] of nameOwners.entries()) {
    if (owners.length > 1) {
      rawFindings.push({
        rule: "skill.duplicate-name",
        severity: "error",
        skill: name,
        file: owners.join(", "),
        message: `Duplicate skill name "${name}" declared in ${owners.length} files (${owners.join(", ")})`,
      });
    }
  }

  const ignored = new Set(options.ignoreRules);
  const findings = rawFindings.filter((f) => !ignored.has(f.rule));
  for (const s of skills) {
    s.findings = s.findings.filter((f) => !ignored.has(f.rule));
  }

  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) {
    counts[f.severity]++;
  }

  const startupTokens = skills.reduce((sum, s) => sum + s.startupTokens, 0);
  const totalBodyTokens = skills.reduce((sum, s) => sum + s.bodyTokens, 0);
  const totalTokens = skills.reduce((sum, s) => sum + s.totalTokens, 0);
  const budgetExceededBy =
    options.budget !== null && startupTokens > options.budget ? startupTokens - options.budget : 0;

  const ok =
    budgetExceededBy === 0 &&
    counts.error === 0 &&
    (!options.strict || counts.warn === 0);

  return {
    root: ".",
    strict: options.strict,
    budget: options.budget,
    budgetExceededBy,
    skillCount: skills.length,
    startupTokens,
    totalBodyTokens,
    totalTokens,
    skills,
    findings,
    counts,
    ok,
  };
}
