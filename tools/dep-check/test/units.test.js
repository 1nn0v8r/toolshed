// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { compareDependencies, isIgnored } from "../src/compare.js";
import { categorizeFile, isSupportedSourceFile, restrictToPaths } from "../src/files.js";
import { formatJson, formatText } from "../src/report.js";

test("isIgnored: matches exact and glob patterns", () => {
  assert.equal(isIgnored("typescript", ["typescript", "eslint"]), true);
  assert.equal(isIgnored("@types/node", ["@types/*"]), true);
  assert.equal(isIgnored("@types/react", ["@types/*"]), true);
  assert.equal(isIgnored("react", ["@types/*"]), false);
  assert.equal(isIgnored("unknown", ["typescript"]), false);
});

test("categorizeFile: classifies dev files and prod files", () => {
  assert.equal(categorizeFile("src/index.js"), "prod");
  assert.equal(categorizeFile("lib/utils.ts"), "prod");
  assert.equal(categorizeFile("app/components/Button.tsx"), "prod");

  assert.equal(categorizeFile("test/index.test.js"), "dev");
  assert.equal(categorizeFile("tests/suite.js"), "dev");
  assert.equal(categorizeFile("src/__tests__/app.spec.ts"), "dev");
  assert.equal(categorizeFile("src/components/Button.test.tsx"), "dev");
  assert.equal(categorizeFile("scripts/build.mjs"), "dev");
  assert.equal(categorizeFile("vite.config.ts"), "dev");
});

test("isSupportedSourceFile: detects source extensions", () => {
  assert.equal(isSupportedSourceFile("file.js"), true);
  assert.equal(isSupportedSourceFile("file.ts"), true);
  assert.equal(isSupportedSourceFile("file.tsx"), true);
  assert.equal(isSupportedSourceFile("file.vue"), true);
  assert.equal(isSupportedSourceFile("file.json"), false);
  assert.equal(isSupportedSourceFile("file.md"), false);
});

test("restrictToPaths: filters by directory or file prefixes", () => {
  const files = ["src/a.js", "src/b.ts", "test/a.test.js", "docs/guide.md"];
  assert.deepEqual(restrictToPaths(files, ["src"]), ["src/a.js", "src/b.ts"]);
  assert.deepEqual(restrictToPaths(files, ["test/a.test.js"]), ["test/a.test.js"]);
  assert.deepEqual(restrictToPaths(files, []), files);
});

test("compareDependencies: identifies missing, unused, and misplaced dependencies", () => {
  const pkgData = {
    dependencies: {
      usedProd: "^1.0.0",
      unusedProd: "^1.0.0",
      prodInDevOnly: "^1.0.0"
    },
    devDependencies: {
      usedDev: "^1.0.0",
      unusedDev: "^1.0.0",
      devInProd: "^1.0.0",
      "@types/usedProd": "^1.0.0"
    }
  };

  /** @type {import("../src/compare.js").ScannedFile[]} */
  const scannedFiles = [
    {
      file: "src/main.js",
      category: "prod",
      imports: [
        { packageName: "usedProd", specifier: "usedProd", line: 1 },
        { packageName: "devInProd", specifier: "devInProd", line: 2 },
        { packageName: "missingPkg", specifier: "missingPkg", line: 3 }
      ]
    },
    {
      file: "test/main.test.js",
      category: "dev",
      imports: [
        { packageName: "usedDev", specifier: "usedDev", line: 1 },
        { packageName: "prodInDevOnly", specifier: "prodInDevOnly", line: 2 }
      ]
    }
  ];

  const result = compareDependencies(pkgData, scannedFiles, {
    ignore: [],
    ignoreDev: false
  });

  // Missing
  assert.equal(result.missingDependencies.length, 1);
  assert.equal(result.missingDependencies[0].name, "missingPkg");

  // Unused Prod
  assert.deepEqual(result.unusedDependencies, ["unusedProd"]);

  // Unused Dev (@types/usedProd is not flagged because usedProd is in dependencies)
  assert.deepEqual(result.unusedDevDependencies, ["unusedDev"]);

  // Misplaced: devInProd in prod, prodInDevOnly in dev only
  assert.equal(result.misplacedDependencies.length, 2);
  const devInProdItem = result.misplacedDependencies.find((m) => m.name === "devInProd");
  assert.ok(devInProdItem);
  assert.equal(devInProdItem.reason, "dev-in-prod");

  const prodInDevItem = result.misplacedDependencies.find((m) => m.name === "prodInDevOnly");
  assert.ok(prodInDevItem);
  assert.equal(prodInDevItem.reason, "prod-in-dev-only");
});

test("formatText and formatJson output", () => {
  const emptyResult = {
    unusedDependencies: [],
    unusedDevDependencies: [],
    missingDependencies: [],
    misplacedDependencies: [],
    scannedFilesCount: 5,
    totalImportsCount: 12
  };

  const cleanText = formatText(emptyResult);
  assert.match(cleanText, /all dependencies look clean/);

  const jsonStr = formatJson(emptyResult);
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.scannedFilesCount, 5);
});
