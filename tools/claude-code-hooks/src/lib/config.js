// @ts-check
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Home directory, overridable for tests with CLAUDE_CODE_HOOKS_HOME. */
export function homeDir() {
  return process.env.CLAUDE_CODE_HOOKS_HOME || os.homedir();
}

/**
 * @param {string} file
 * @returns {any}
 */
function readJsonSafe(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    process.stderr.write(`claude-code-hooks: ignoring invalid JSON in ${file}\n`);
    return null;
  }
}

/**
 * Load the options for one hook from `<project>/.claude/hooks.config.json`
 * and `<home>/.claude/hooks.config.json`. Arrays are concatenated, other
 * values from the project file win.
 * @param {string} hookName
 * @param {string} [cwd]
 * @returns {Record<string, any>}
 */
export function loadConfig(hookName, cwd) {
  /** @type {string[]} */
  const roots = [];
  for (const r of [process.env.CLAUDE_PROJECT_DIR, cwd, process.cwd()]) {
    if (typeof r === "string" && r.length > 0) roots.push(r);
  }
  const files = roots.map((r) => path.join(r, ".claude", "hooks.config.json"));
  files.push(path.join(homeDir(), ".claude", "hooks.config.json"));
  const seen = new Set();
  /** @type {Record<string, any>} */
  const merged = {};
  for (const f of files) {
    const key = path.resolve(f).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const data = readJsonSafe(f);
    const section = data && typeof data === "object" ? data[hookName] : null;
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    for (const [k, v] of Object.entries(section)) {
      if (Array.isArray(v)) {
        merged[k] = (Array.isArray(merged[k]) ? merged[k] : []).concat(v);
      } else if (!(k in merged)) {
        merged[k] = v;
      }
    }
  }
  return merged;
}

/**
 * Return config[key] as an array of strings.
 * @param {Record<string, any> | undefined} config
 * @param {string} key
 * @returns {string[]}
 */
export function stringList(config, key) {
  const v = config ? config[key] : undefined;
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}
