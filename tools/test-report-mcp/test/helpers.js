// @ts-check
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const SERVER = fileURLToPath(new URL("../src/server.js", import.meta.url));
export const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
export const ROOT_PLACEHOLDER = "/abs/path/to/project";

/** @param {string} name */
export const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

/**
 * Create a temp dir and register cleanup on the test context.
 * @param {import("node:test").TestContext | undefined} t
 */
export function tmpDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-report-mcp-")));
  t?.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* a child process may still hold the directory on Windows; the OS temp cleaner handles it */
    }
  });
  return dir;
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} content
 */
export function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

/**
 * A tiny node:test project with one passing, one failing and one skipped test.
 * @param {string} root
 */
export function makeNodeProject(root) {
  write(root, "package.json", JSON.stringify({ name: "fx", private: true, type: "module", scripts: { test: "node --test" } }));
  write(
    root,
    "test/sample.test.js",
    [
      "import test, { describe } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "describe('math', () => {",
      "  test('adds', () => { assert.equal(1 + 1, 2); });",
      "  test('subtracts wrongly', () => { assert.equal(3 - 1, 5); });",
      "});",
      "test('skipped one', { skip: true }, () => {});",
      "",
    ].join("\n"),
  );
}

/**
 * Install a fake CLI package whose bin copies a fixture to the requested output file.
 * @param {string} root
 * @param {string} pkg
 * @param {string} outputArg prefix such as "--outputFile=" or "output="
 * @param {string} fixtureName
 * @param {number} [exitCode]
 */
export function installFakeRunner(root, pkg, outputArg, fixtureName, exitCode = 1) {
  const dir = path.join(root, "node_modules", pkg);
  write(root, `node_modules/${pkg}/package.json`, JSON.stringify({ name: pkg, version: "0.0.0", bin: { [pkg]: "cli.js" } }));
  write(root, `node_modules/${pkg}/report.fixture`, fixture(fixtureName));
  write(
    root,
    `node_modules/${pkg}/cli.js`,
    [
      "const fs = require('node:fs'); const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "fs.writeFileSync(path.join(__dirname, 'argv.json'), JSON.stringify(args));",
      `const hit = args.find((a) => a.startsWith(${JSON.stringify(outputArg)}));`,
      `if (hit) fs.writeFileSync(hit.slice(${outputArg.length}), fs.readFileSync(path.join(__dirname, 'report.fixture')));`,
      `process.exit(${exitCode});`,
      "",
    ].join("\n"),
  );
  return {
    argv: () => JSON.parse(fs.readFileSync(path.join(dir, "argv.json"), "utf8")),
  };
}

/** @param {string} cmd @param {string[]} args */
export function hasCommand(cmd, args) {
  try {
    return spawnSync(cmd, args, { windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}

/** Characters that must never appear in tool output or source. */
export const BANNED = [String.fromCharCode(0x2014), String.fromCharCode(0x2013), String.fromCharCode(0x2026)];
