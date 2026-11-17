#!/usr/bin/env node
// @ts-check
import fs from "node:fs";
import path from "node:path";
import { execFile, exec } from "node:child_process";
import { allow, isMain, runHook } from "../lib/io.js";
import { matchesAny } from "../lib/glob.js";
import { stringList } from "../lib/config.js";

/**
 * @typedef {{ file: string, args: string[], cwd: string, kind: "node" | "exe" }} Plan
 */

const PRETTIER_EXTS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".json", ".css", ".scss", ".less", ".md", ".mdx", ".yaml", ".yml",
]);
const PRETTIER_CONFIGS = [
  ".prettierrc", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml", ".prettierrc.json5",
  ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.toml",
  "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs", "prettier.config.ts",
];

/**
 * @param {string} p
 * @returns {any}
 */
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/** @param {string} p */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Find an executable on PATH without running a shell.
 * @param {string} name
 * @returns {string | null}
 */
export function which(name) {
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === "path");
  const dirs = (key ? process.env[key] || "" : "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const d of dirs) {
    for (const e of exts) {
      const candidate = path.join(d, name + e.toLowerCase());
      if (isFile(candidate)) return candidate;
      if (e && isFile(path.join(d, name + e))) return path.join(d, name + e);
    }
  }
  return null;
}

/**
 * Locate a project-local prettier that has a config or dependency entry.
 * @param {string} abs absolute file path
 * @returns {Plan | null}
 */
export function findPrettier(abs) {
  let dir = path.dirname(abs);
  for (;;) {
    const pkgPath = path.join(dir, "node_modules", "prettier", "package.json");
    if (isFile(pkgPath)) {
      const pkg = readJson(pkgPath);
      const bin = pkg && (typeof pkg.bin === "string" ? pkg.bin : pkg.bin && pkg.bin.prettier);
      if (typeof bin !== "string") return null;
      const root = readJson(path.join(dir, "package.json"));
      const declared =
        root && (root.prettier !== undefined || (root.dependencies && root.dependencies.prettier) || (root.devDependencies && root.devDependencies.prettier));
      const hasConfig = PRETTIER_CONFIGS.some((c) => isFile(path.join(dir, c)));
      if (!declared && !hasConfig) return null;
      return {
        file: path.join(dir, "node_modules", "prettier", bin),
        args: ["--write", "--ignore-unknown", abs],
        cwd: dir,
        kind: "node",
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Choose a formatter for a file, or null when none applies.
 * @param {string} abs
 * @returns {Plan | null}
 */
export function findFormatter(abs) {
  const ext = path.extname(abs).toLowerCase();
  const cwd = path.dirname(abs);
  if (PRETTIER_EXTS.has(ext)) return findPrettier(abs);
  if (ext === ".py") {
    const ruff = which("ruff");
    if (ruff) return { file: ruff, args: ["format", abs], cwd, kind: "exe" };
    const black = which("black");
    if (black) return { file: black, args: ["-q", abs], cwd, kind: "exe" };
    return null;
  }
  if (ext === ".go") {
    const g = which("gofmt");
    return g ? { file: g, args: ["-w", abs], cwd, kind: "exe" } : null;
  }
  if (ext === ".rs") {
    const r = which("rustfmt");
    return r ? { file: r, args: [abs], cwd, kind: "exe" } : null;
  }
  return null;
}

/**
 * Run a plan with a timeout. Always resolves; failures are ignored.
 * @param {Plan} plan
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
export function runPlan(plan, timeoutMs) {
  return new Promise((resolve) => {
    const done = () => resolve();
    if (plan.kind === "node") {
      execFile(process.execPath, [plan.file, ...plan.args], { cwd: plan.cwd, timeout: timeoutMs, windowsHide: true }, done);
      return;
    }
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(plan.file)) {
      // Windows cannot launch batch shims without a shell. Refuse arguments
      // that cmd.exe would interpret.
      const all = [plan.file, ...plan.args];
      if (all.some((a) => /["%&|<>^\r\n]/.test(a))) return done();
      exec(all.map((a) => `"${a}"`).join(" "), { cwd: plan.cwd, timeout: timeoutMs, windowsHide: true }, done);
      return;
    }
    execFile(plan.file, plan.args, { cwd: plan.cwd, timeout: timeoutMs, windowsHide: true }, done);
  });
}

/**
 * @param {any} input hook payload
 * @param {Record<string, any>} [config]
 */
export async function evaluate(input, config = {}) {
  if (config.disable === true) return allow();
  const ti = input.tool_input;
  const file = ti && typeof ti.file_path === "string" ? ti.file_path : "";
  if (!file) return allow();
  const abs = path.resolve(typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd(), file);
  if (!isFile(abs)) return allow();
  if (matchesAny(stringList(config, "ignore"), abs)) return allow();
  const plan = findFormatter(abs);
  if (!plan) return allow();
  const t = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? Math.min(config.timeoutMs, 20000) : 20000;
  await runPlan(plan, t);
  return allow();
}

if (isMain(import.meta.url)) await runHook("auto-format", evaluate, { preTool: false });
