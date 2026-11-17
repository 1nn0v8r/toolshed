// @ts-check
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Run git in a directory and return stdout.
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {string}
 */
export function sh(cwd, args, env = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * @param {string} cwd
 * @param {string} who author name
 * @param {string} msg
 * @param {string} date ISO date
 * @param {string[]} [extra] extra git args placed before the subcommand
 */
export function commit(cwd, who, msg, date, extra = []) {
  sh(cwd, ["add", "-A"]);
  const mail = who.normalize("NFD").replace(/[^A-Za-z]/g, "").toLowerCase() + "@example.com";
  sh(cwd, ["-c", `user.name=${who}`, "-c", `user.email=${mail}`, "-c", "commit.gpgsign=false", ...extra, "commit", "-q", "-m", msg], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
}

/**
 * @param {string} dir
 * @param {string} rel
 * @param {string} content
 */
export function put(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Make an empty temp dir. */
export function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "git-history-mcp-"));
}

/** Make an initialised repo with no commits. */
export function emptyRepo() {
  const dir = tmp();
  sh(dir, ["init", "-q"]);
  sh(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  sh(dir, ["config", "core.autocrlf", "false"]);
  return dir;
}

/**
 * Build a repo with renames, unicode and spaced paths, several authors, a merge and a CRLF file.
 * @returns {{ dir: string, shas: Record<string, string> }}
 */
export function makeRepo() {
  const dir = emptyRepo();
  /** @type {Record<string, string>} */
  const shas = {};
  const head = () => sh(dir, ["rev-parse", "HEAD"]).trim();

  put(dir, "src/main.js", "line one\nline two\nline three\nline four\nline five\n");
  put(dir, "crlf.txt", "alpha\r\nbeta\r\ngamma\r\n");
  put(dir, "README.md", "# demo\n");
  commit(dir, "Alice Anders", "init project", "2026-01-10T10:00:00Z");
  shas.init = head();

  put(dir, "docs/my file.txt", "spaced\n");
  put(dir, "src/ünï.js", "export const u = 1;\n");
  commit(dir, "Bob Baker", "add docs and unicode file", "2026-02-10T10:00:00Z");
  shas.docs = head();

  put(dir, "src/main.js", "line one\nline two changed\nline three\nline four\nline five\n");
  commit(dir, "Alice Anders", "Change line two", "2026-03-10T10:00:00Z");
  shas.change = head();

  sh(dir, ["mv", "src/main.js", "src/app.js"]);
  commit(dir, "Alice Anders", "rename main to app", "2026-04-10T10:00:00Z");
  shas.rename = head();

  put(dir, "src/app.js", "line one\nline two changed\nline three by bob\nline four\nline five\n");
  commit(dir, "Bob Baker", "Tweak line three\n\nReviewed-by: Zed <zed@example.com>", "2026-05-01T10:00:00Z");
  shas.tweak = head();

  sh(dir, ["checkout", "-q", "-b", "feature"]);
  put(dir, "feature.txt", "feature work\n");
  commit(dir, "Zoë Müller", "feature work", "2026-05-05T10:00:00Z");
  shas.feature = head();
  sh(dir, ["checkout", "-q", "main"]);
  put(dir, "README.md", "# demo\nmore\n");
  commit(dir, "Alice Anders", "update readme", "2026-05-06T10:00:00Z");
  sh(dir, ["-c", "user.name=Alice Anders", "-c", "user.email=alice@example.com", "-c", "commit.gpgsign=false", "merge", "--no-ff", "-q", "-m", "Merge feature", "feature"], {
    GIT_AUTHOR_DATE: "2026-05-07T10:00:00Z",
    GIT_COMMITTER_DATE: "2026-05-07T10:00:00Z",
  });
  shas.merge = head();
  return { dir, shas };
}

/**
 * Remove a temp dir.
 * @param {string} dir
 */
export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;
