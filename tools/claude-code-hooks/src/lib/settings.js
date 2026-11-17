// @ts-check
import fs from "node:fs";
import path from "node:path";
import { homeDir } from "./config.js";
import { HOOKS, commandFor } from "./registry.js";

export const SCOPES = ["user", "project", "local"];

/**
 * Path of the settings file for a scope.
 * @param {string} scope
 * @param {string} projectDir
 */
export function settingsPath(scope, projectDir) {
  if (scope === "user") return path.join(homeDir(), ".claude", "settings.json");
  if (scope === "local") return path.join(projectDir, ".claude", "settings.local.json");
  return path.join(projectDir, ".claude", "settings.json");
}

/**
 * Read a settings file. `data` is null when the file does not exist.
 * Throws an Error with a readable message when the JSON is invalid.
 * @param {string} file
 * @returns {{ data: any, exists: boolean }}
 */
export function readSettings(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && /** @type {any} */ (e).code === "ENOENT") return { data: null, exists: false };
    throw e;
  }
  const trimmed = text.replace(/^﻿/, "");
  if (trimmed.trim() === "") return { data: {}, exists: true };
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}); fix it and try again`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return { data, exists: true };
}

/**
 * Write settings, backing up an existing file first.
 * @param {string} file
 * @param {any} data
 * @returns {string | null} backup path, if one was made
 */
export function writeSettings(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
    backup = `${file}.bak-${stamp}`;
    let n = 1;
    while (fs.existsSync(backup)) backup = `${file}.bak-${stamp}-${n++}`;
    fs.copyFileSync(file, backup);
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return backup;
}

/**
 * True when a hook command was added by this tool. Optionally restricted to one hook.
 * @param {unknown} command
 * @param {string} [name]
 */
export function isOurCommand(command, name) {
  if (typeof command !== "string") return false;
  const c = command.replace(/\\/g, "/");
  if (!c.includes("claude-code-hooks/src/hooks/")) return false;
  return name === undefined || c.includes(`claude-code-hooks/src/hooks/${name}.js`);
}

/**
 * @param {any} data
 * @param {string} event
 * @returns {any[]}
 */
function groupsOf(data, event) {
  const hooks = data && data.hooks;
  const list = hooks && hooks[event];
  return Array.isArray(list) ? list : [];
}

/**
 * Names of this tool's hooks present in a settings object.
 * @param {any} data
 * @returns {string[]}
 */
export function installedHooks(data) {
  if (!data) return [];
  return HOOKS.filter((h) =>
    groupsOf(data, h.event).some(
      (g) => g && Array.isArray(g.hooks) && g.hooks.some((/** @type {any} */ x) => isOurCommand(x && x.command, h.name)),
    ),
  ).map((h) => h.name);
}

/**
 * Add hooks to a settings object in place.
 * @param {any} data
 * @param {string[]} names
 * @returns {{ added: string[], updated: string[], unchanged: string[] }}
 */
export function installInto(data, names) {
  const result = { added: /** @type {string[]} */ ([]), updated: /** @type {string[]} */ ([]), unchanged: /** @type {string[]} */ ([]) };
  if (data.hooks === undefined) data.hooks = {};
  if (!data.hooks || typeof data.hooks !== "object" || Array.isArray(data.hooks)) {
    throw new Error('"hooks" in the settings file must be an object');
  }
  for (const hook of HOOKS.filter((h) => names.includes(h.name))) {
    if (data.hooks[hook.event] === undefined) data.hooks[hook.event] = [];
    if (!Array.isArray(data.hooks[hook.event])) {
      throw new Error(`"hooks.${hook.event}" in the settings file must be an array`);
    }
    const command = commandFor(hook);
    /** @type {any} */
    let found = null;
    for (const g of data.hooks[hook.event]) {
      if (!g || !Array.isArray(g.hooks)) continue;
      const h = g.hooks.find((/** @type {any} */ x) => isOurCommand(x && x.command, hook.name));
      if (h) {
        found = h;
        break;
      }
    }
    if (!found) {
      data.hooks[hook.event].push({ matcher: hook.matcher, hooks: [{ type: "command", command }] });
      result.added.push(hook.name);
    } else if (found.command !== command) {
      found.command = command;
      result.updated.push(hook.name);
    } else {
      result.unchanged.push(hook.name);
    }
  }
  return result;
}

/**
 * Remove this tool's hooks from a settings object in place.
 * @param {any} data
 * @param {string[]} names
 * @returns {string[]} names removed
 */
export function uninstallFrom(data, names) {
  /** @type {string[]} */
  const removed = [];
  if (!data || !data.hooks || typeof data.hooks !== "object") return removed;
  for (const hook of HOOKS.filter((h) => names.includes(h.name))) {
    const groups = data.hooks[hook.event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const before = g.hooks.length;
      g.hooks = g.hooks.filter((/** @type {any} */ x) => !isOurCommand(x && x.command, hook.name));
      if (g.hooks.length < before && !removed.includes(hook.name)) removed.push(hook.name);
      if (g.hooks.length > 0 || before === 0) kept.push(g);
    }
    if (kept.length > 0) data.hooks[hook.event] = kept;
    else delete data.hooks[hook.event];
  }
  if (Object.keys(data.hooks).length === 0) delete data.hooks;
  return removed;
}
