# Changelog

All notable changes to dep-check. Versions follow [Semantic Versioning](https://semver.org).

## Unreleased

### Changed
- Relicensed from MIT to GNU AGPL-3.0-only.

## 0.1.0 - 2026-11-20

### Added
- Scan JavaScript, TypeScript, JSX, TSX, Svelte, Vue, and Astro files for module imports and requires.
- Compare imported packages against declared dependencies, devDependencies, peerDependencies, and optionalDependencies in package.json.
- Detect missing dependencies imported in code but omitted from package.json.
- Detect unused production dependencies and unused devDependencies.
- Detect misplaced dependencies (devDependencies imported in production code, or production dependencies used only in tests).
- Support for ES modules, CommonJS require, dynamic imports, require.resolve, and test mocks (jest.mock, vi.mock).
- Automatic filtering for Node.js built-ins (including node:*), Bun, and Deno schemes.
- Configurable package ignore lists and globs via CLI options or .depcheckrc.json.
- Flexible exit codes for CI: --fail-on-unused, --fail-on-missing, --fail-on-misplaced, and --strict.
- Human-readable text and --json output modes.
