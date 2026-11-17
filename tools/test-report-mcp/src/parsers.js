// @ts-check
import { clean, relativize, splitStack, pickLocation } from "./util.js";

/**
 * @typedef {{name: string, kind: "failure" | "error", file?: string, line?: number, message: string, stack: string[]}} Failure
 * @typedef {{total: number, passed: number, failed: number, errors: number, skipped: number, durationMs?: number}} Summary
 * @typedef {{format: string, summary: Summary, failures: Failure[]}} Report
 * @typedef {{roots?: string[]}} ParseOptions
 */

/**
 * @param {string} s
 */
function trimBlankEdges(s) {
  return s.replace(/^\s*\n/, "").replace(/\s+$/, "");
}

/**
 * Remove the indentation shared by all non-blank lines.
 * @param {string} s
 */
function dedent(s) {
  const lead = (/** @type {string} */ l) => /^[ \t]*/.exec(l)?.[0].length ?? 0;
  const widths = s.split("\n").filter((l) => l.trim()).map(lead);
  const n = widths.length ? Math.min(...widths) : 0;
  return n ? s.split("\n").map((l) => l.slice(Math.min(n, lead(l)))).join("\n") : s;
}

/**
 * Build a normalised failure.
 * @param {{name: string, kind?: "failure" | "error", text?: string, message?: string, file?: string, line?: number, roots?: string[]}} p
 * @returns {Failure}
 */
export function buildFailure(p) {
  const roots = p.roots ?? [];
  const text = relativize(clean(p.text ?? ""), roots);
  const { message: msgLines, frames } = splitStack(text);
  let message =
    p.message !== undefined && p.message.trim() !== ""
      ? relativize(clean(p.message), roots)
      : msgLines.join("\n");
  message = dedent(trimBlankEdges(message));
  if (!message) message = "(no message)";
  const msgFrames = splitStack(message).frames;
  const allFrames = frames.length ? frames : msgFrames;
  const known = p.file ? relativize(p.file, roots) : undefined;
  const loc = pickLocation(allFrames, known);
  return {
    name: p.name,
    kind: p.kind ?? "failure",
    file: loc.file ?? known,
    line: loc.line ?? p.line,
    message,
    stack: allFrames,
  };
}

/**
 * @param {Partial<Summary>} s
 * @returns {Summary}
 */
function mkSummary(s) {
  const total = s.total ?? 0;
  const failed = s.failed ?? 0;
  const errors = s.errors ?? 0;
  const skipped = s.skipped ?? 0;
  return {
    total,
    failed,
    errors,
    skipped,
    passed: s.passed ?? Math.max(0, total - failed - errors - skipped),
    durationMs: s.durationMs,
  };
}

// ---------------------------------------------------------------- XML / JUnit

/** @typedef {{name: string, attrs: Record<string, string>, children: XmlNode[], text: string}} XmlNode */

/** @param {string} s */
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => {
    switch (e) {
      case "lt": return "<";
      case "gt": return ">";
      case "amp": return "&";
      case "quot": return '"';
      case "apos": return "'";
      default: {
        const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
    }
  });
}

/**
 * Minimal tolerant XML parser, enough for JUnit reports.
 * @param {string} xml
 * @returns {XmlNode}
 */
export function parseXml(xml) {
  /** @type {XmlNode} */
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const re =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/)?([A-Za-z_][\w:.-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/)?>|([^<]+)|</g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[3] !== undefined) {
      if (m[2]) {
        let i = stack.length - 1;
        while (i > 0 && stack[i].name !== m[3]) i--;
        if (i > 0) stack.length = i;
      } else {
        /** @type {Record<string, string>} */
        const attrs = {};
        const are = /([^\s=>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let a;
        while ((a = are.exec(m[4] ?? "")) !== null) attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? "");
        /** @type {XmlNode} */
        const node = { name: m[3], attrs, children: [], text: "" };
        top.children.push(node);
        if (!m[5]) stack.push(node);
      }
    } else if (m[6] !== undefined) {
      top.text += decodeEntities(m[6]);
    }
  }
  return root;
}

/** @param {string} s */
const looksLikeFile = (s) => /[\\/]/.test(s) || /\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|cs|php|rs)$/.test(s);

const GENERIC_SUITES = new Set(["pytest", "vitest tests", "jest tests", "mocha tests", "test", "tests", "root", "testsuites", "node"]);

/**
 * @param {string} xml
 * @param {ParseOptions} [opts]
 * @returns {Report}
 */
export function parseJunit(xml, opts = {}) {
  const roots = opts.roots ?? [];
  const doc = parseXml(xml);
  /** @type {Failure[]} */
  const failures = [];
  let total = 0, skipped = 0, failed = 0, errors = 0, timeSec = 0;
  let rootTime = NaN;

  /**
   * @param {XmlNode} node
   * @param {string[]} suites
   */
  const walk = (node, suites) => {
    for (const child of node.children) {
      if (child.name === "testsuites" && child.attrs.time !== undefined) rootTime = Number(child.attrs.time);
      if (child.name === "testsuite") {
        walk(child, [...suites, child.attrs.name ?? ""]);
      } else if (child.name === "testcase") {
        total++;
        const t = Number(child.attrs.time);
        if (Number.isFinite(t)) timeSec += t;
        const fail = child.children.find((c) => c.name === "failure" || c.name === "error");
        const skip = child.children.find((c) => c.name === "skipped") || /^(skipped|disabled)$/i.test(child.attrs.status ?? "");
        if (fail) {
          const kind = fail.name === "error" ? "error" : "failure";
          if (kind === "error") errors++; else failed++;
          failures.push(junitFailure(child, fail, kind, suites, roots));
        } else if (skip) {
          skipped++;
        }
      } else {
        walk(child, suites);
      }
    }
  };
  walk(doc, []);
  const durationMs = Number.isFinite(rootTime) ? rootTime * 1000 : timeSec * 1000;
  return { format: "junit", summary: mkSummary({ total, failed, errors, skipped, durationMs: Math.round(durationMs) }), failures };
}

/**
 * @param {XmlNode} tc
 * @param {XmlNode} fail
 * @param {"failure" | "error"} kind
 * @param {string[]} suites
 * @param {string[]} roots
 * @returns {Failure}
 */
function junitFailure(tc, fail, kind, suites, roots) {
  const name = tc.attrs.name ?? "(unnamed)";
  const cls = tc.attrs.classname ?? "";
  const parts = suites.filter((s) => s && !looksLikeFile(s) && !GENERIC_SUITES.has(s.toLowerCase()) && s !== cls);
  if (cls && !looksLikeFile(cls) && !GENERIC_SUITES.has(cls.toLowerCase()) && !name.startsWith(cls)) parts.push(cls);
  parts.push(name);
  const fileCandidates = [tc.attrs.file, looksLikeFile(cls) ? cls : "", ...[...suites].reverse().filter(looksLikeFile)];
  const file = fileCandidates.find((f) => f);
  const body = clean(fail.text);
  let message = fail.attrs.message ?? "";
  const eLines = body.split("\n").filter((l) => /^E(\s|$)/.test(l)).map((l) => l.replace(/^E\s{0,3}/, ""));
  if (eLines.length && !message.includes("\n")) message = eLines.join("\n");
  if (!message.trim() && !body.trim()) message = fail.attrs.type ?? "";
  const line = tc.attrs.line && Number(tc.attrs.line) > 0 ? Number(tc.attrs.line) : undefined;
  return buildFailure({ name: parts.join(" > "), kind, text: body, message, file, line, roots });
}

// ----------------------------------------------------------------- Jest JSON

/**
 * @param {string} text
 * @param {ParseOptions} [opts]
 * @returns {Report}
 */
export function parseJestJson(text, opts = {}) {
  const roots = opts.roots ?? [];
  const data = JSON.parse(text.replace(/^﻿/, ""));
  /** @type {Failure[]} */
  const failures = [];
  let crashed = 0;
  let maxEnd = 0;
  for (const tr of data.testResults ?? []) {
    if (typeof tr.endTime === "number") maxEnd = Math.max(maxEnd, tr.endTime);
    const file = String(tr.name ?? "");
    const rel = relativize(file, roots);
    const asserts = tr.assertionResults ?? [];
    if (tr.status === "failed" && asserts.length === 0) {
      crashed++;
      failures.push(buildFailure({ name: rel || "(test suite)", kind: "error", text: String(tr.message ?? ""), file, roots }));
    }
    for (const a of asserts) {
      if (a.status !== "failed") continue;
      const name = [...(a.ancestorTitles ?? []), a.title].filter(Boolean).join(" > ") || a.fullName || "(unnamed)";
      const msgs = Array.isArray(a.failureMessages) ? a.failureMessages.join("\n") : "";
      const f = buildFailure({ name, text: msgs, file, roots });
      if (a.location && typeof a.location.line === "number") f.line = a.location.line;
      if (!f.file) f.file = rel;
      failures.push(f);
    }
  }
  const failedTests = failures.filter((f) => f.kind === "failure").length;
  const total = Number(data.numTotalTests ?? 0) + crashed;
  const skipped = Number(data.numPendingTests ?? 0) + Number(data.numTodoTests ?? 0);
  const durationMs = typeof data.startTime === "number" && maxEnd > data.startTime ? maxEnd - data.startTime : undefined;
  return {
    format: "jest-json",
    summary: mkSummary({
      total,
      failed: Math.max(failedTests, Number(data.numFailedTests ?? 0)),
      errors: crashed,
      skipped,
      passed: data.numPassedTests,
      durationMs,
    }),
    failures,
  };
}

// ---------------------------------------------------------------- Mocha JSON

/**
 * @param {string} text
 * @param {ParseOptions} [opts]
 * @returns {Report}
 */
export function parseMochaJson(text, opts = {}) {
  const roots = opts.roots ?? [];
  const data = JSON.parse(text.replace(/^﻿/, ""));
  const stats = data.stats ?? {};
  /** @type {Failure[]} */
  const failures = (data.failures ?? []).map((/** @type {any} */ t) =>
    buildFailure({
      name: String(t.fullTitle ?? t.title ?? "(unnamed)"),
      text: String(t.err?.stack ?? ""),
      message: String(t.err?.message ?? ""),
      file: t.file,
      roots,
    }),
  );
  return {
    format: "mocha-json",
    summary: mkSummary({
      total: Number(stats.tests ?? 0),
      failed: Number(stats.failures ?? failures.length),
      skipped: Number(stats.pending ?? 0),
      passed: stats.passes,
      durationMs: typeof stats.duration === "number" ? stats.duration : undefined,
    }),
    failures,
  };
}

// ----------------------------------------------------------------------- TAP

/**
 * Parse the small YAML subset used in TAP diagnostics.
 * @param {string[]} lines
 * @returns {Record<string, string>}
 */
export function parseTapYaml(lines) {
  const lead = (/** @type {string} */ l) => /^\s*/.exec(l)?.[0].length ?? 0;
  const indents = lines.filter((l) => l.trim()).map(lead);
  const base = indents.length ? Math.min(...indents) : 0;
  const ls = lines.map((l) => l.slice(Math.min(base, lead(l))));
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < ls.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(ls[i]);
    if (!m) continue;
    const [, key, rest] = m;
    if (/^[|>][+-]?$/.test(rest.trim())) {
      /** @type {string[]} */
      const block = [];
      while (i + 1 < ls.length && (/^\s+/.test(ls[i + 1]) || ls[i + 1] === "")) block.push(ls[++i]);
      const widths = block.filter((l) => l.trim()).map(lead);
      const bi = widths.length ? Math.min(...widths) : 0;
      out[key] = block.map((l) => l.slice(bi)).join("\n").replace(/\n+$/, "");
    } else if (rest.length >= 2 && rest.startsWith("'") && rest.endsWith("'")) {
      out[key] = rest.slice(1, -1).replace(/''/g, "'");
    } else if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) {
      try {
        out[key] = JSON.parse(rest);
      } catch {
        out[key] = rest.slice(1, -1);
      }
    } else {
      out[key] = rest;
    }
  }
  return out;
}

/**
 * @typedef {{indent: number, ok: boolean, name: string, skip: boolean, diag: Record<string, string>, children: TapNode[]}} TapNode
 */

/**
 * @param {string} text
 * @param {ParseOptions} [opts]
 * @returns {Report}
 */
export function parseTap(text, opts = {}) {
  const roots = opts.roots ?? [];
  const lines = clean(text).split("\n");
  /** @type {TapNode[]} */
  let pending = [];
  /** @type {TapNode | null} */
  let last = null;
  let durationMs;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const d = /^#\s*duration_ms\s+([\d.]+)/.exec(line);
    if (d) durationMs = Math.round(Number(d[1]));
    const m = /^(\s*)(not ok|ok)\b\s*(?:\d+)?\s*(?:-\s*)?(.*)$/.exec(line);
    if (m) {
      let name = m[3];
      let skip = false;
      const dir = /\s+#\s*(SKIP|TODO)\b.*$/i.exec(name);
      if (dir) {
        skip = true;
        name = name.slice(0, dir.index);
      }
      const indent = m[1].length;
      const children = pending.filter((n) => n.indent > indent);
      pending = pending.filter((n) => n.indent <= indent);
      /** @type {TapNode} */
      const node = { indent, ok: m[2] === "ok", name: name.trim(), skip, diag: {}, children };
      pending.push(node);
      last = node;
      continue;
    }
    if (last && /^\s*---\s*$/.test(line)) {
      /** @type {string[]} */
      const block = [];
      while (i + 1 < lines.length && !/^\s*\.\.\.\s*$/.test(lines[i + 1])) block.push(lines[++i]);
      i++;
      last.diag = parseTapYaml(block);
    }
  }

  /** @param {TapNode} n @returns {boolean} */
  const hasFailure = (n) => (!n.ok && !n.skip) || n.children.some(hasFailure);

  /** @type {Failure[]} */
  const failures = [];
  let total = 0, skipped = 0, failed = 0;
  /**
   * @param {TapNode} n
   * @param {string[]} path
   */
  const visit = (n, path) => {
    const here = [...path, n.name];
    const failingKids = n.children.some(hasFailure);
    const descend =
      n.children.length > 0 &&
      ((failingKids && (n.diag.failureType === "subtestsFailed" || !n.diag.error)) || (!failingKids && n.ok));
    if (descend) {
      for (const c of n.children) visit(c, here);
      return;
    }
    total++;
    if (n.skip) {
      skipped++;
    } else if (!n.ok) {
      failed++;
      const diag = n.diag;
      let message = diag.error ?? diag.message ?? "";
      if (diag.expected !== undefined && diag.actual !== undefined && !message.includes(diag.actual)) {
        message += `\nexpected: ${diag.expected}\nactual: ${diag.actual}`;
      }
      const loc = /^(.*?):(\d+)(?::\d+)?$/.exec(relativize(diag.location ?? "", roots));
      const f = buildFailure({
        name: here.join(" > "),
        text: diag.stack ?? "",
        message: message || diag.name || "",
        file: loc ? loc[1] : undefined,
        roots,
      });
      if (!f.file && loc) f.file = loc[1];
      if (f.line === undefined && loc) f.line = Number(loc[2]);
      failures.push(f);
    }
  };
  for (const n of pending) visit(n, []);
  return { format: "tap", summary: mkSummary({ total, failed, skipped, durationMs }), failures };
}

// ------------------------------------------------------------------- go test

/**
 * @param {string} text
 * @param {ParseOptions} [opts]
 * @returns {Report}
 */
export function parseGoJson(text, opts = {}) {
  const roots = opts.roots ?? [];
  /** @type {Map<string, {pkg: string, test: string, action: string, out: string[]}>} */
  const tests = new Map();
  /** @type {Map<string, {action: string, out: string[]}>} */
  const pkgs = new Map();
  /** @type {Map<string, string[]>} */
  const buildOut = new Map();
  let elapsed = 0;
  for (const raw of clean(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    /** @type {any} */
    let ev = null;
    if (line.startsWith("{")) {
      try {
        ev = JSON.parse(line);
      } catch {
        ev = null;
      }
    }
    if (!ev || typeof ev.Action !== "string") {
      const p = pkgs.get("(build)") ?? { action: "", out: [] };
      p.out.push(raw);
      pkgs.set("(build)", p);
      continue;
    }
    if (ev.Action === "build-output" || ev.Action === "build-fail") {
      if (ev.Action === "build-output") {
        const key = String(ev.ImportPath ?? "");
        const arr = buildOut.get(key) ?? [];
        arr.push(String(ev.Output ?? "").replace(/\n$/, ""));
        buildOut.set(key, arr);
      }
      continue;
    }
    const pkg = String(ev.Package ?? "");
    if (!ev.Test) {
      const p = pkgs.get(pkg) ?? { action: "", out: [] };
      if (ev.Action === "output") p.out.push(String(ev.Output ?? "").replace(/\n$/, ""));
      if (["pass", "fail", "skip"].includes(ev.Action)) {
        p.action = ev.Action;
        if (ev.FailedBuild && buildOut.has(String(ev.FailedBuild))) p.out.push(...(buildOut.get(String(ev.FailedBuild)) ?? []));
        if (typeof ev.Elapsed === "number") elapsed += ev.Elapsed;
      }
      pkgs.set(pkg, p);
      continue;
    }
    const key = `${pkg}\u0000${ev.Test}`;
    const t = tests.get(key) ?? { pkg, test: String(ev.Test), action: "", out: [] };
    if (ev.Action === "output") t.out.push(String(ev.Output ?? "").replace(/\n$/, ""));
    if (["pass", "fail", "skip"].includes(ev.Action)) t.action = ev.Action;
    tests.set(key, t);
  }

  const all = [...tests.values()];
  const isParent = (/** @type {{pkg: string, test: string}} */ t) =>
    all.some((o) => o.pkg === t.pkg && o.test.startsWith(`${t.test}/`));
  /** @type {Failure[]} */
  const failures = [];
  let total = 0, passed = 0, skipped = 0, failed = 0, errors = 0;
  for (const t of all) {
    if (isParent(t) || !t.action) continue;
    total++;
    if (t.action === "pass") passed++;
    else if (t.action === "skip") skipped++;
    else if (t.action === "fail") {
      failed++;
      const body = t.out
        .filter((l) => !/^\s*(=== (RUN|PAUSE|CONT|NAME)|--- (FAIL|PASS|SKIP)|FAIL(\s|$))/.test(l))
        .join("\n");
      const first = body.split("\n").find((l) => /\S+\.go:\d+/.test(l));
      const lm = first ? /(\S+\.go):(\d+)/.exec(first) : null;
      const f = buildFailure({ name: `${t.test} (${t.pkg})`, text: body, roots });
      if (lm) {
        f.file = relativize(lm[1], roots).replace(/\\/g, "/");
        f.line = Number(lm[2]);
      }
      failures.push(f);
    }
  }
  for (const [pkg, p] of pkgs) {
    const hasTestFail = all.some((t) => t.pkg === pkg && t.action === "fail");
    if (p.action === "fail" && !hasTestFail) {
      errors++;
      total++;
      failures.push(buildFailure({ name: `package ${pkg}`, kind: "error", text: p.out.join("\n"), roots }));
    } else if (pkg === "(build)" && failures.length === 0 && p.out.some((l) => /\.go:\d+/.test(l))) {
      errors++;
      total++;
      failures.push(buildFailure({ name: "go build output", kind: "error", text: p.out.join("\n"), roots }));
    }
  }
  return {
    format: "go-json",
    summary: mkSummary({ total, passed, failed, errors, skipped, durationMs: Math.round(elapsed * 1000) }),
    failures,
  };
}

// ---------------------------------------------------------------- dispatcher

export const FORMATS = ["junit", "jest-json", "tap", "go-json", "mocha-json"];

/**
 * Guess a report format from its content.
 * @param {string} text
 * @returns {string | null}
 */
export function detectFormat(text) {
  const t = text.replace(/^﻿/, "").trimStart();
  if (t.startsWith("<")) return "junit";
  if (/^\{"(Time|Action)"/.test(t)) return "go-json";
  if (t.startsWith("{")) {
    try {
      const d = JSON.parse(t);
      if (d && Array.isArray(d.testResults)) return "jest-json";
      if (d && d.stats && Array.isArray(d.failures)) return "mocha-json";
    } catch {
      /* fall through */
    }
    return null;
  }
  if (/^TAP version|^\s*(not ok|ok)\b/m.test(t.slice(0, 8000))) return "tap";
  return null;
}

/**
 * @param {string} format
 * @param {string} text
 * @param {ParseOptions} [opts]
 * @returns {Report}
 */
export function parseByFormat(format, text, opts = {}) {
  switch (format) {
    case "junit": return parseJunit(text, opts);
    case "jest-json": return parseJestJson(text, opts);
    case "tap": return parseTap(text, opts);
    case "go-json": return parseGoJson(text, opts);
    case "mocha-json": return parseMochaJson(text, opts);
    default: throw new Error(`Unknown format: ${format}. Use one of ${FORMATS.join(", ")}.`);
  }
}
