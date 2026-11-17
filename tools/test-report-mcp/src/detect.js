// @ts-check
import fs from "node:fs";
import path from "node:path";
import { buildInvocation } from "./runner.js";

/**
 * @typedef {{runner: string, source: string, command: string, confidence: "high" | "medium" | "low"}} Detected
 */

/** @param {string} p */
function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** @param {string} p */
function readJson(p) {
  try {
    return JSON.parse(readText(p));
  } catch {
    return null;
  }
}

/**
 * @param {string} dir
 * @param {RegExp} re
 */
function hasFileMatching(dir, re) {
  try {
    return fs.readdirSync(dir).some((f) => re.test(f));
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function hasNodeTestFiles(dir) {
  const re = /\.(test|spec)\.[cm]?js$|^test-.*\.[cm]?js$/;
  if (hasFileMatching(dir, re)) return true;
  for (const sub of ["test", "tests", "__tests__"]) {
    const d = path.join(dir, sub);
    if (fs.existsSync(d) && hasFileMatching(d, /\.[cm]?js$/)) return true;
  }
  return false;
}

/**
 * Inspect a directory and report the test runners found.
 * @param {string} dir
 * @param {string} root
 * @returns {Detected[]}
 */
export function detectRunners(dir, root) {
  /** @type {Detected[]} */
  const found = [];
  const reportPath = "<report>";
  /**
   * @param {string} runner
   * @param {string} source
   * @param {"high" | "medium" | "low"} confidence
   */
  const add = (runner, source, confidence) => {
    if (found.some((f) => f.runner === runner)) return;
    let command = runner;
    try {
      command = buildInvocation(runner, { root, dir, reportPath, dry: true }).display;
    } catch {
      /* keep the name */
    }
    found.push({ runner, source, command, confidence });
  };

  const pkg = readJson(path.join(dir, "package.json"));
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const scripts = Object.values(pkg.scripts ?? {}).filter((s) => typeof s === "string").join("\n");
    const testScript = String(pkg.scripts?.test ?? "");
    if (deps.vitest) add("vitest", "package.json dependency", "high");
    else if (/\bvitest\b/.test(scripts)) add("vitest", "package.json script", "medium");
    if (hasFileMatching(dir, /^vitest\.(config|workspace)\./)) add("vitest", "vitest config file", "high");

    if (deps.jest) add("jest", "package.json dependency", "high");
    else if (/\bjest\b/.test(scripts)) add("jest", "package.json script", "medium");
    if (pkg.jest || hasFileMatching(dir, /^jest\.config\./)) add("jest", "jest config", "high");

    if (deps.mocha) add("mocha", "package.json dependency", "high");
    else if (/\bmocha\b/.test(scripts)) add("mocha", "package.json script", "medium");
    if (hasFileMatching(dir, /^\.mocharc\./)) add("mocha", ".mocharc file", "high");

    if (/\bnode\b[^\n&|;]*--test\b/.test(testScript)) add("node:test", "package.json test script", "high");
    else if (/\bnode\b[^\n&|;]*--test\b/.test(scripts)) add("node:test", "package.json script", "medium");
  }

  const pyproject = readText(path.join(dir, "pyproject.toml"));
  const setupCfg = readText(path.join(dir, "setup.cfg"));
  const toxIni = readText(path.join(dir, "tox.ini"));
  if (fs.existsSync(path.join(dir, "pytest.ini"))) add("pytest", "pytest.ini", "high");
  else if (/\[tool\.pytest/.test(pyproject)) add("pytest", "pyproject.toml [tool.pytest]", "high");
  else if (/\[tool:pytest\]/.test(setupCfg)) add("pytest", "setup.cfg [tool:pytest]", "high");
  else if (/^\[pytest\]/m.test(toxIni)) add("pytest", "tox.ini [pytest]", "high");
  else if (fs.existsSync(path.join(dir, "conftest.py")) || fs.existsSync(path.join(dir, "tests", "conftest.py"))) add("pytest", "conftest.py", "medium");
  else if (/pytest/.test(pyproject) || /pytest/.test(readText(path.join(dir, "requirements-dev.txt"))) || /^pytest\b/m.test(readText(path.join(dir, "requirements.txt")))) add("pytest", "dependency list", "medium");

  if (fs.existsSync(path.join(dir, "go.mod"))) add("go", "go.mod", "high");

  if (!found.some((f) => ["vitest", "jest", "mocha", "node:test"].includes(f.runner)) && pkg && hasNodeTestFiles(dir)) {
    add("node:test", "test files with no other JS runner found", "low");
  }
  return found;
}
