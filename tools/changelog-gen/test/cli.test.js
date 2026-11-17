// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { run } from "../src/run.js";
import { CLI, cleanup, cli, commit, git as g, makeDir, makeRepo } from "./helpers.js";

const DATE = ["--date", "2026-03-04"];

test("--help and -V", () => {
  const dir = makeDir();
  try {
    const h = cli(dir, ["--help"]);
    assert.equal(h.code, 0);
    assert.match(h.stdout, /--version-label/);
    assert.match(h.stdout, /-V, --cli-version/);
    const v = cli(dir, ["-V"]);
    assert.equal(v.code, 0);
    assert.match(v.stdout, /^\d+\.\d+\.\d+\n$/);
    assert.equal(cli(dir, ["--cli-version"]).stdout, v.stdout);
  } finally {
    cleanup(dir);
  }
});

test("usage errors exit 2", () => {
  const dir = makeRepo();
  try {
    commit(dir, "feat: x");
    assert.equal(cli(dir, ["--nope"]).code, 2);
    assert.match(cli(dir, ["--nope"]).stderr, /unknown option/);
    assert.equal(cli(dir, ["--date", "x"]).code, 2);
    assert.equal(cli(dir, ["--from", "no-such-ref"]).code, 2);
    assert.equal(cli(dir, ["--to", "no-such-ref"]).code, 2);
  } finally {
    cleanup(dir);
  }
});

test("not a git repo exits 2", () => {
  const dir = makeDir();
  try {
    const r = cli(dir, []);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not a git repository/);
  } finally {
    cleanup(dir);
  }
});

test("git missing from PATH exits 2", () => {
  const dir = makeDir();
  try {
    const env = { ...process.env, PATH: dir, Path: dir };
    const r = spawnSync(process.execPath, [CLI], { cwd: dir, encoding: "utf8", env });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /git was not found/);
  } finally {
    cleanup(dir);
  }
});

test("empty repo exits 1 with a clear message", () => {
  const dir = makeRepo();
  try {
    const r = cli(dir, []);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no commits in range/);
  } finally {
    cleanup(dir);
  }
});

test("conventional commits, default v tag, whole history without a tag", () => {
  const dir = makeRepo();
  try {
    commit(dir, "feat: old feature");
    const noTag = cli(dir, [...DATE, "--no-hash"]);
    assert.equal(noTag.code, 0);
    assert.equal(noTag.stdout, "## Unreleased - 2026-03-04\n\n### Added\n\n- old feature\n");

    g(dir, ["tag", "v1.0.0"]);
    const empty = cli(dir, []);
    assert.equal(empty.code, 1);
    assert.match(empty.stderr, /no commits in range v1\.0\.0\.\.HEAD/);

    const s1 = commit(dir, "feat: new feature");
    const s2 = commit(dir, "fix: bug");
    commit(dir, "perf: faster");
    commit(dir, "refactor: tidy");
    commit(dir, "docs: readme");
    commit(dir, "revert: undo thing");
    commit(dir, "chore: deps");
    commit(dir, "test: more");
    commit(dir, "ci: pipeline");
    commit(dir, "build: bundler");
    commit(dir, "style: fmt");
    const r = cli(dir, [...DATE, "--version-label", "1.1.0"]);
    assert.equal(r.code, 0);
    const lines = r.stdout.split("\n");
    assert.equal(lines[0], "## 1.1.0 - 2026-03-04");
    assert.deepEqual(
      lines.filter((l) => l.startsWith("### ")),
      ["### Added", "### Changed", "### Fixed", "### Removed", "### Documentation"],
    );
    assert.ok(r.stdout.includes(`- new feature (${s1.slice(0, 7)})`));
    assert.ok(r.stdout.includes(`- bug (${s2.slice(0, 7)})`));
    assert.ok(!r.stdout.includes("old feature"));
    assert.ok(!/deps|pipeline|bundler|fmt|more/.test(r.stdout));

    const all = cli(dir, [...DATE, "--all", "--no-hash"]);
    for (const w of ["deps", "more", "pipeline", "bundler", "fmt"]) assert.ok(all.stdout.includes(`- ${w}`), w);
  } finally {
    cleanup(dir);
  }
});

test("all hidden commits exit 1 and hint at --all", () => {
  const dir = makeRepo();
  try {
    commit(dir, "chore: only chores");
    const r = cli(dir, []);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /use --all/);
  } finally {
    cleanup(dir);
  }
});

test("monorepo prefix tags, --path, and repo style subjects", () => {
  const dir = makeRepo();
  try {
    commit(dir, "repo-pack: Add first thing", "tools/repo-pack/a.txt");
    commit(dir, "other-tool: Add unrelated", "tools/other-tool/a.txt");
    g(dir, ["tag", "repo-pack@0.1.0"]);
    g(dir, ["tag", "other-tool@0.1.0"]);
    commit(dir, "repo-pack: Add shiny option", "tools/repo-pack/b.txt");
    commit(dir, "repo-pack: Fix crash on empty input", "tools/repo-pack/c.txt");
    commit(dir, "repo-pack: Remove legacy flag", "tools/repo-pack/d.txt");
    commit(dir, "repo-pack: Tweak output", "tools/repo-pack/e.txt");
    commit(dir, "other-tool: Add other thing", "tools/other-tool/b.txt");
    commit(dir, "feat: touches both\n\nCo-Authored-By: Someone <someone@example.com>\nSigned-off-by: Other <o@example.com>", "tools/repo-pack/f.txt");

    const r = cli(dir, ["--tag-prefix", "repo-pack@", "--path", "tools/repo-pack", ...DATE, "--no-hash", "--version-label", "0.2.0"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stdout,
      [
        "## 0.2.0 - 2026-03-04",
        "",
        "### Added",
        "",
        "- touches both",
        "- Add shiny option",
        "",
        "### Changed",
        "",
        "- Tweak output",
        "",
        "### Fixed",
        "",
        "- Fix crash on empty input",
        "",
        "### Removed",
        "",
        "- Remove legacy flag",
        "",
      ].join("\n"),
    );
    assert.ok(!r.stdout.includes("Co-Authored"));
    assert.ok(!r.stdout.includes("someone@example.com"));
    assert.ok(!r.stdout.includes("Signed-off"));

    // Without the matching folder name the prefix stays.
    const noStrip = cli(dir, ["--tag-prefix", "repo-pack@", ...DATE, "--no-hash"]);
    assert.ok(noStrip.stdout.includes("- other-tool: Add other thing"));
    assert.ok(noStrip.stdout.includes("- repo-pack: Add shiny option"));

    // --scope strips the prefix without --path.
    const scoped = cli(dir, ["--tag-prefix", "repo-pack@", "--scope", "other-tool", ...DATE, "--no-hash"]);
    assert.ok(scoped.stdout.includes("- Add other thing"));

    // --path . from inside the tool folder uses the folder name.
    const inside = cli(path.join(dir, "tools", "repo-pack"), ["--tag-prefix", "repo-pack@", "--path", ".", ...DATE, "--no-hash"]);
    assert.equal(inside.code, 0, inside.stderr);
    assert.ok(inside.stdout.includes("- Add shiny option"));
    assert.ok(!inside.stdout.includes("other"));

    // The other tool's tag gives a different range.
    const other = cli(dir, ["--tag-prefix", "other-tool@", "--path", "tools/other-tool", ...DATE, "--no-hash"]);
    assert.equal(other.stdout, "## Unreleased - 2026-03-04\n\n### Added\n\n- Add other thing\n");
  } finally {
    cleanup(dir);
  }
});

test("--from and --to override the tag range", () => {
  const dir = makeRepo();
  try {
    const a = commit(dir, "feat: a");
    const b = commit(dir, "feat: b");
    commit(dir, "feat: c");
    g(dir, ["tag", "v1.0.0", a]);
    const r = cli(dir, ["--from", a, "--to", b, ...DATE, "--no-hash"]);
    assert.equal(r.stdout, "## Unreleased - 2026-03-04\n\n### Added\n\n- b\n");
    const viaTag = cli(dir, ["--to", b, ...DATE, "--no-hash"]);
    assert.equal(viaTag.stdout, r.stdout);
    const fromTag = cli(dir, ["--from=v1.0.0", ...DATE, "--no-hash"]);
    assert.equal(fromTag.stdout, "## Unreleased - 2026-03-04\n\n### Added\n\n- c\n- b\n");
  } finally {
    cleanup(dir);
  }
});

test("breaking changes via bang and footer", () => {
  const dir = makeRepo();
  try {
    commit(dir, "feat!: drop the old API");
    commit(dir, "fix: tweak\n\nBREAKING CHANGE: config key renamed\nto newKey");
    commit(dir, "chore!: bump engines");
    const r = cli(dir, [...DATE, "--no-hash"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /### Breaking\n\n- bump engines\n- tweak: config key renamed to newKey\n- drop the old API\n$/);
    assert.match(r.stdout, /### Added\n\n- drop the old API/);
  } finally {
    cleanup(dir);
  }
});

test("merge commits skipped by default, kept with --include-merges", () => {
  const dir = makeRepo();
  try {
    commit(dir, "feat: base");
    const main = g(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    g(dir, ["switch", "-q", "-c", "side"]);
    commit(dir, "fix: side fix");
    g(dir, ["switch", "-q", main]);
    commit(dir, "feat: main feat");
    g(dir, ["merge", "--no-ff", "-q", "-m", "Merge branch side into main", "side"]);
    const r = cli(dir, [...DATE, "--no-hash"]);
    assert.ok(!r.stdout.includes("Merge branch"));
    const m = cli(dir, [...DATE, "--no-hash", "--include-merges"]);
    assert.ok(m.stdout.includes("- Merge branch side into main"));
  } finally {
    cleanup(dir);
  }
});

test("--json output", () => {
  const dir = makeRepo();
  try {
    commit(dir, "feat: a\n\nBREAKING CHANGE: gone");
    commit(dir, "fix: b");
    const r = cli(dir, ["--json", ...DATE, "--version-label", "2.0.0"]);
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.version, "2.0.0");
    assert.equal(j.date, "2026-03-04");
    assert.deepEqual(j.range, { from: null, to: "HEAD", tag: null });
    assert.equal(j.commits, 2);
    assert.equal(j.entries, 2);
    assert.equal(j.sections.Added[0].subject, "a");
    assert.equal(j.sections.Added[0].hash.length, 40);
    assert.equal(j.sections.Added[0].short.length, 7);
    assert.equal(j.sections.Fixed[0].subject, "b");
    assert.equal(j.sections.Breaking[0].breakingNote, "gone");
    assert.equal(j.sections.Changed, undefined);
    assert.equal(j.written, null);
    assert.ok(j.markdown.startsWith("## 2.0.0 - 2026-03-04"));
  } finally {
    cleanup(dir);
  }
});

test("--write inserts a new section and preserves the rest", () => {
  const dir = makeRepo();
  try {
    commit(dir, "feat: a");
    const file = path.join(dir, "CHANGELOG.md");
    const original = "# Changelog\n\nAll notable changes.\n\n## 0.1.0 - 2025-01-01\n\n- old\n";
    fs.writeFileSync(file, original);
    const r = cli(dir, ["--write", "CHANGELOG.md", "--no-hash", "--version-label", "0.2.0", ...DATE]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /inserted section "0\.2\.0" in CHANGELOG\.md/);
    assert.equal(
      fs.readFileSync(file, "utf8"),
      "# Changelog\n\nAll notable changes.\n\n## 0.2.0 - 2026-03-04\n\n### Added\n\n- a\n\n## 0.1.0 - 2025-01-01\n\n- old\n",
    );
  } finally {
    cleanup(dir);
  }
});

test("--write replaces Unreleased and is idempotent", () => {
  const dir = makeRepo();
  try {
    commit(dir, "feat: a");
    const file = path.join(dir, "CHANGELOG.md");
    fs.writeFileSync(file, "# Changelog\n\n## Unreleased\n\n- stale\n\n## 0.1.0 - 2025-01-01\n\n- old\n");
    const args = ["--write", "CHANGELOG.md", "--no-hash", ...DATE];
    assert.equal(cli(dir, args).code, 0);
    const once = fs.readFileSync(file, "utf8");
    assert.ok(!once.includes("stale"));
    assert.ok(once.includes("## Unreleased - 2026-03-04"));
    assert.equal(cli(dir, args).code, 0);
    assert.equal(fs.readFileSync(file, "utf8"), once);
  } finally {
    cleanup(dir);
  }
});

test("--write keeps CRLF files CRLF", () => {
  const dir = makeRepo();
  try {
    commit(dir, "feat: a");
    const file = path.join(dir, "CHANGELOG.md");
    fs.writeFileSync(file, "# Changelog\r\n\r\n## 0.1.0 - 2025-01-01\r\n\r\n- old\r\n");
    const r = cli(dir, ["--write", file, "--no-hash", "--version-label", "0.2.0", ...DATE]);
    assert.equal(r.code, 0, r.stderr);
    const out = fs.readFileSync(file, "utf8");
    assert.equal(out, "# Changelog\r\n\r\n## 0.2.0 - 2026-03-04\r\n\r\n### Added\r\n\r\n- a\r\n\r\n## 0.1.0 - 2025-01-01\r\n\r\n- old\r\n");
  } finally {
    cleanup(dir);
  }
});

test("--write creates a missing file; --write with --json reports it", () => {
  const dir = makeRepo();
  try {
    commit(dir, "feat: a");
    const r = cli(dir, ["--write", "NEW.md", "--json", "--no-hash", ...DATE]);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout).written, { file: "NEW.md", action: "created" });
    assert.equal(fs.readFileSync(path.join(dir, "NEW.md"), "utf8"), "# Changelog\n\n## Unreleased - 2026-03-04\n\n### Added\n\n- a\n");
  } finally {
    cleanup(dir);
  }
});

test("--write is not performed when there are no commits", () => {
  const dir = makeRepo();
  try {
    commit(dir, "feat: a");
    g(dir, ["tag", "v1.0.0"]);
    const r = cli(dir, ["--write", "CHANGELOG.md"]);
    assert.equal(r.code, 1);
    assert.ok(!fs.existsSync(path.join(dir, "CHANGELOG.md")));
  } finally {
    cleanup(dir);
  }
});

test("write failure exits 2", () => {
  const dir = makeRepo();
  try {
    commit(dir, "feat: a");
    const r = cli(dir, ["--write", "no-such-dir/CHANGELOG.md"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /ENOENT/);
  } finally {
    cleanup(dir);
  }
});

test("default date is today in UTC", async () => {
  const dir = makeRepo();
  try {
    commit(dir, "feat: a");
    /** @type {string[]} */
    const out = [];
    const code = await run([], {
      cwd: dir,
      stdout: (s) => out.push(s),
      stderr: () => {},
      now: () => new Date("2031-12-31T23:59:59Z"),
    });
    assert.equal(code, 0);
    assert.ok(out.join("").startsWith("## Unreleased - 2031-12-31"));
    const real = cli(dir, []);
    assert.match(real.stdout, new RegExp(`^## Unreleased - ${new Date().toISOString().slice(0, 4)}-`));
  } finally {
    cleanup(dir);
  }
});

test("unicode subjects and bodies round trip", () => {
  const dir = makeRepo();
  try {
    commit(dir, "feat: café 日本語 support");
    const r = cli(dir, [...DATE, "--no-hash"]);
    assert.ok(r.stdout.includes("- café 日本語 support"));
  } finally {
    cleanup(dir);
  }
});

test("many commits", () => {
  const dir = makeRepo();
  try {
    for (let i = 0; i < 300; i++) g(dir, ["commit", "--allow-empty", "-q", "-m", `feat: item ${i}`]);
    const r = cli(dir, [...DATE, "--no-hash"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.split("\n").filter((l) => l.startsWith("- ")).length, 300);
  } finally {
    cleanup(dir);
  }
});
