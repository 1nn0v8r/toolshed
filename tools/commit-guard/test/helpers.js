// @ts-check
// Shared test helpers. Secret-looking values are assembled at runtime from pieces
// so that no source file contains a literal secret.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

export const EM = String.fromCharCode(0x2014);
export const EN = String.fromCharCode(0x2013);
export const ELL = String.fromCharCode(0x2026);

export const fake = {
  aws: () => "AKIA" + "Q7".repeat(8),
  awsSts: () => "ASIA" + "B3".repeat(8),
  ghp: () => "ghp_" + "aB3dE5gH7j".repeat(4),
  gho: () => "gho_" + "aB3dE5gH7j".repeat(4),
  ghu: () => "ghu_" + "aB3dE5gH7j".repeat(4),
  ghs: () => "ghs_" + "aB3dE5gH7j".repeat(4),
  ghr: () => "ghr_" + "aB3dE5gH7j".repeat(4),
  ghPat: () => "github_pat_" + "A1b2C3d4E5".repeat(3),
  privateKey: () => "-----BEGIN " + "RSA PRIVATE KEY" + "-----",
  privateKeyPlain: () => "-----BEGIN " + "PRIVATE KEY" + "-----",
  slack: () => "xox" + "b-" + "1234567890-abcdefghij",
  stripe: () => "sk_" + "live_" + "A1b2C3d4E5f6G7h8",
  stripeRestricted: () => "rk_" + "live_" + "A1b2C3d4E5f6G7h8",
  anthropic: () => "sk-" + "ant-" + "api03-" + "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2",
  openai: () => "sk-" + "A1b2C3d4E5f6G7h8I9j0K1",
  openaiProj: () => "sk-" + "proj-" + "A1b2C3d4E5f6G7h8I9j0",
  google: () => "AIza" + ("Sy" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5pQ6rS7").slice(0, 35),
  jwt: () => "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJ" + "zdWIiOiIxMjM0NTY3ODkw" + "." + "SflKxwRJSMeKKF2QT4fw",
  generic: () => "Zk3" + "pQ9wLm2Xv8Rt",
};

/**
 * Build a Windows-style home path at runtime.
 * @param {string} name
 * @param {string} [sep]
 */
export function winHome(name, sep = "\\") {
  return ["C:", "Users", name, "project"].join(sep);
}

/** @param {string} name @param {string} [root] */
export function unixHome(name, root = "home") {
  return ["", root, name, "project"].join("/");
}

const EMPTY_GITCONFIG = path.join(os.tmpdir(), "commit-guard-empty-gitconfig");
fs.writeFileSync(EMPTY_GITCONFIG, "");

/** Environment that isolates git from the machine's global and system config. */
export function isolatedEnv() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** @param {string} [prefix] */
export function tmpDir(prefix = "commit-guard-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** @param {string} dir */
export function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
export function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: isolatedEnv() });
  if (r.status !== 0 && process.env.CG_DEBUG) console.error(r.stderr);
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** Create an empty temp git repo. */
export function makeRepo() {
  const dir = tmpDir();
  const r = git(dir, ["init", "-q"]);
  if (r.status !== 0) throw new Error("git init failed: " + r.stderr);
  return dir;
}

/**
 * @param {string} dir
 * @param {string} rel
 * @param {string | Buffer} content
 */
export function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** @param {string} dir @param {...string} files */
export function stage(dir, ...files) {
  const r = git(dir, ["add", "--", ...files]);
  if (r.status !== 0) throw new Error("git add failed: " + r.stderr);
}

/** @param {string} dir @param {string} [msg] */
export function commit(dir, msg = "test") {
  return git(dir, [
    "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", msg,
  ]);
}

/**
 * Run the real CLI as a child process.
 * @param {string} cwd
 * @param {string[]} args
 */
export function runCli(cwd, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: isolatedEnv() });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}
