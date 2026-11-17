#!/usr/bin/env node
// @ts-check
import { allow, deny, isMain, runHook } from "../lib/io.js";
import { matchesAny } from "../lib/glob.js";
import { stringList } from "../lib/config.js";
import { findSecrets } from "../lib/secrets.js";

/**
 * Collect the new text a tool call would write.
 * @param {any} ti tool_input
 * @returns {string[]}
 */
export function newTexts(ti) {
  /** @type {string[]} */
  const out = [];
  if (!ti || typeof ti !== "object") return out;
  if (typeof ti.content === "string") out.push(ti.content);
  if (typeof ti.new_string === "string") out.push(ti.new_string);
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) {
      if (e && typeof e.new_string === "string") out.push(e.new_string);
    }
  }
  return out;
}

/**
 * @param {Record<string, any>} config
 * @returns {{ name: string, re: RegExp }[]}
 */
function extraPatterns(config) {
  const list = Array.isArray(config.extraPatterns) ? config.extraPatterns : [];
  /** @type {{ name: string, re: RegExp }[]} */
  const out = [];
  for (const item of list) {
    if (!item || typeof item.pattern !== "string") continue;
    try {
      out.push({ name: typeof item.name === "string" ? item.name : "Custom pattern", re: new RegExp(item.pattern, "g") });
    } catch {
      process.stderr.write("claude-code-hooks block-secrets: ignoring invalid extraPatterns entry\n");
    }
  }
  return out;
}

/**
 * @param {any} input hook payload
 * @param {Record<string, any>} [config]
 */
export function evaluate(input, config = {}) {
  const ti = input.tool_input;
  const file = ti && typeof ti.file_path === "string" ? ti.file_path : "";
  if (file && matchesAny(stringList(config, "allow"), file)) return allow();
  const texts = newTexts(ti);
  if (texts.length === 0) return allow();
  const extra = extraPatterns(config);
  const findings = findSecrets(texts.join("\n"), { extraPatterns: extra });
  if (findings.length === 0) return allow();
  const shown = findings
    .slice(0, 5)
    .map((f) => `${f.name} (${f.masked}) near line ${f.line}`)
    .join("; ");
  const more = findings.length > 5 ? `; and ${findings.length - 5} more` : "";
  return deny(
    `The new content appears to contain secrets: ${shown}${more}. Read the value from an environment variable or a secrets manager instead of writing it to a file. Add "claude-hooks:allow" on the line to silence a false positive.`,
  );
}

if (isMain(import.meta.url)) await runHook("block-secrets", evaluate);
