// @ts-check

/**
 * @typedef {import("./scan.js").ImportOccurrence} ImportOccurrence
 * @typedef {import("./config.js").PackageJsonData} PackageJsonData
 * @typedef {import("./config.js").DepCheckConfig} DepCheckConfig
 */

/**
 * @typedef {Object} ScannedFile
 * @property {string} file
 * @property {"prod" | "dev"} category
 * @property {ImportOccurrence[]} imports
 */

/**
 * @typedef {Object} DependencyLocation
 * @property {string} file
 * @property {number} line
 */

/**
 * @typedef {Object} MissingDependency
 * @property {string} name
 * @property {DependencyLocation[]} occurrences
 */

/**
 * @typedef {Object} MisplacedDependency
 * @property {string} name
 * @property {"dev-in-prod" | "prod-in-dev-only"} reason
 * @property {DependencyLocation[]} occurrences
 */

/**
 * @typedef {Object} ComparisonResult
 * @property {string[]} unusedDependencies
 * @property {string[]} unusedDevDependencies
 * @property {MissingDependency[]} missingDependencies
 * @property {MisplacedDependency[]} misplacedDependencies
 * @property {number} scannedFilesCount
 * @property {number} totalImportsCount
 */

/**
 * Tests whether a package name matches an ignore rule.
 * Supports exact match and basic wildcard patterns (e.g. "@types/*").
 *
 * @param {string} pkgName
 * @param {string[]} ignorePatterns
 * @returns {boolean}
 */
export function isIgnored(pkgName, ignorePatterns) {
  for (const pattern of ignorePatterns) {
    if (pattern === pkgName) return true;
    if (pattern.includes("*")) {
      const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
      if (regex.test(pkgName)) return true;
    }
  }
  return false;
}

/**
 * Compares declared dependencies in package.json against scanned file imports.
 *
 * @param {PackageJsonData} pkgData
 * @param {ScannedFile[]} scannedFiles
 * @param {DepCheckConfig} config
 * @returns {ComparisonResult}
 */
export function compareDependencies(pkgData, scannedFiles, config) {
  const ignoreList = config.ignore || [];
  const prodDeclared = new Set(Object.keys(pkgData.dependencies || {}));
  const devDeclared = new Set(Object.keys(pkgData.devDependencies || {}));
  const peerDeclared = new Set(Object.keys(pkgData.peerDependencies || {}));
  const optionalDeclared = new Set(Object.keys(pkgData.optionalDependencies || {}));

  const allDeclared = new Set([
    ...prodDeclared,
    ...devDeclared,
    ...peerDeclared,
    ...optionalDeclared
  ]);

  /** @type {Map<string, DependencyLocation[]>} */
  const usedInProd = new Map();
  /** @type {Map<string, DependencyLocation[]>} */
  const usedInDev = new Map();
  /** @type {Set<string>} */
  const allUsed = new Set();

  let totalImportsCount = 0;

  for (const { file, category, imports } of scannedFiles) {
    for (const imp of imports) {
      totalImportsCount++;
      const pkg = imp.packageName;
      allUsed.add(pkg);

      const loc = { file, line: imp.line };
      if (category === "prod") {
        const list = usedInProd.get(pkg) || [];
        list.push(loc);
        usedInProd.set(pkg, list);
      } else {
        const list = usedInDev.get(pkg) || [];
        list.push(loc);
        usedInDev.set(pkg, list);
      }
    }
  }

  // 1. Missing dependencies: imported in code, but nowhere in package.json
  /** @type {MissingDependency[]} */
  const missingDependencies = [];
  for (const pkg of Array.from(allUsed).sort()) {
    if (!allDeclared.has(pkg) && !isIgnored(pkg, ignoreList)) {
      const occurrences = [
        ...(usedInProd.get(pkg) || []),
        ...(usedInDev.get(pkg) || [])
      ];
      missingDependencies.push({
        name: pkg,
        occurrences
      });
    }
  }

  // 2. Unused production dependencies: declared in dependencies, but not used anywhere
  /** @type {string[]} */
  const unusedDependencies = [];
  for (const pkg of Array.from(prodDeclared).sort()) {
    if (!allUsed.has(pkg) && !isIgnored(pkg, ignoreList)) {
      unusedDependencies.push(pkg);
    }
  }

  // 3. Unused devDependencies: declared in devDependencies, but not used anywhere
  /** @type {string[]} */
  const unusedDevDependencies = [];
  if (!config.ignoreDev) {
    for (const pkg of Array.from(devDeclared).sort()) {
      if (isIgnored(pkg, ignoreList)) continue;

      // Special check: if @types/pkg is declared and pkg is used, don't flag as unused
      if (pkg.startsWith("@types/")) {
        const basePkg = pkg.slice("@types/".length);
        if (allUsed.has(basePkg) || prodDeclared.has(basePkg)) {
          continue;
        }
      }

      if (!allUsed.has(pkg)) {
        unusedDevDependencies.push(pkg);
      }
    }
  }

  // 4. Misplaced dependencies:
  // a) devDependencies imported in production code
  // b) production dependencies only used in dev/test code
  /** @type {MisplacedDependency[]} */
  const misplacedDependencies = [];

  for (const pkg of Array.from(devDeclared).sort()) {
    if (usedInProd.has(pkg) && !isIgnored(pkg, ignoreList)) {
      misplacedDependencies.push({
        name: pkg,
        reason: "dev-in-prod",
        occurrences: usedInProd.get(pkg) || []
      });
    }
  }

  for (const pkg of Array.from(prodDeclared).sort()) {
    if (!usedInProd.has(pkg) && usedInDev.has(pkg) && !isIgnored(pkg, ignoreList)) {
      misplacedDependencies.push({
        name: pkg,
        reason: "prod-in-dev-only",
        occurrences: usedInDev.get(pkg) || []
      });
    }
  }

  return {
    unusedDependencies,
    unusedDevDependencies,
    missingDependencies,
    misplacedDependencies,
    scannedFilesCount: scannedFiles.length,
    totalImportsCount
  };
}
