// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { extractPackageName, scanImports, stripCommentsPreservingLines } from "../src/scan.js";

test("extractPackageName: resolves regular and scoped packages", () => {
  assert.equal(extractPackageName("lodash"), "lodash");
  assert.equal(extractPackageName("lodash/merge"), "lodash");
  assert.equal(extractPackageName("@scope/pkg"), "@scope/pkg");
  assert.equal(extractPackageName("@scope/pkg/subpath/file.js"), "@scope/pkg");
  assert.equal(extractPackageName("@types/node"), "@types/node");
});

test("extractPackageName: filters builtins, relative paths, and runtime schemes", () => {
  assert.equal(extractPackageName("fs"), null);
  assert.equal(extractPackageName("node:fs"), null);
  assert.equal(extractPackageName("path"), null);
  assert.equal(extractPackageName("node:path"), null);
  assert.equal(extractPackageName("test"), null);
  assert.equal(extractPackageName("node:test"), null);
  assert.equal(extractPackageName("bun:ffi"), null);
  assert.equal(extractPackageName("deno:std"), null);

  assert.equal(extractPackageName("./local.js"), null);
  assert.equal(extractPackageName("../parent.js"), null);
  assert.equal(extractPackageName("/absolute.js"), null);
  assert.equal(extractPackageName("C:\\path\\file.js"), null);
  assert.equal(extractPackageName("#internal/alias"), null);
});

test("stripCommentsPreservingLines: strips comments while maintaining line counts", () => {
  const code = [
    "import foo from 'foo';",
    "// import bar from 'bar';",
    "/* multi-line",
    "   comment */",
    "import baz from 'baz';"
  ].join("\n");

  const stripped = stripCommentsPreservingLines(code);
  const lines = stripped.split("\n");

  assert.equal(lines.length, 5);
  assert.match(lines[0], /import foo from 'foo'/);
  assert.doesNotMatch(lines[1], /import bar/);
  assert.doesNotMatch(lines[2], /multi-line/);
  assert.doesNotMatch(lines[3], /comment/);
  assert.match(lines[4], /import baz from 'baz'/);
});

test("stripCommentsPreservingLines: preserves comment-like characters in strings", () => {
  const code = 'const url = "https://example.com/api"; // comment\nconst quote = "/* not a comment */";';
  const stripped = stripCommentsPreservingLines(code);

  assert.match(stripped, /https:\/\/example\.com\/api/);
  assert.match(stripped, /\/\* not a comment \*\//);
  assert.doesNotMatch(stripped, /comment\n/);
});

test("scanImports: extracts ES import, export, dynamic import, and require", () => {
  const code = `
import React from 'react';
import { useState } from 'react';
import type { User } from './types';
import * as utils from 'custom-utils/helpers';
import 'side-effects-pkg';

export { Helper } from 'helper-pkg';
export * from '@org/shared-utils';

const lodash = require('lodash');
const dynamic = await import('dynamic-pkg');
require.resolve('resolve-pkg');
jest.mock('mocked-pkg');
vi.mock('@vitest/mock-pkg');

// require('commented-pkg')
/* import 'commented-block-pkg' */
`;

  const occurrences = scanImports(code);
  const pkgs = occurrences.map((o) => o.packageName);

  assert.ok(pkgs.includes("react"));
  assert.ok(pkgs.includes("custom-utils"));
  assert.ok(pkgs.includes("side-effects-pkg"));
  assert.ok(pkgs.includes("helper-pkg"));
  assert.ok(pkgs.includes("@org/shared-utils"));
  assert.ok(pkgs.includes("lodash"));
  assert.ok(pkgs.includes("dynamic-pkg"));
  assert.ok(pkgs.includes("resolve-pkg"));
  assert.ok(pkgs.includes("mocked-pkg"));
  assert.ok(pkgs.includes("@vitest/mock-pkg"));

  // Excluded:
  assert.ok(!pkgs.includes("commented-pkg"));
  assert.ok(!pkgs.includes("commented-block-pkg"));
  assert.ok(!pkgs.includes("./types"));
});
