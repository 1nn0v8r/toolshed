#!/usr/bin/env node
// @ts-check
import { allow, deny, isMain, runHook } from "../lib/io.js";
import { baseName, matchesAny, normalizePath } from "../lib/glob.js";
import { stringList } from "../lib/config.js";
import { cmdName, parseCommand, unwrap } from "../lib/bash-parse.js";

/**
 * @typedef {{ reason: string, readOk: boolean }} Protection
 */

const TEMPLATE_SUFFIX = /\.(?:example|sample|template)$/i;

/** Commands that only read a file, so a write-only protection allows them. */
const READ_ONLY_CMDS = new Set([
  "cat", "less", "more", "head", "tail", "bat", "grep", "egrep", "fgrep", "rg", "type",
  "get-content", "gc", "view", "diff", "wc", "sort", "stat", "ls", "dir",
]);

/** Commands that never reveal file contents. */
const HARMLESS_CMDS = new Set(["ls", "dir", "stat", "echo", "printf", "test", "[", "[[", "which", "file", "pwd", "cd"]);

/**
 * Decide whether a path is protected.
 * @param {string} filePath
 * @param {Record<string, any>} [config]
 * @returns {Protection | null}
 */
export function classifyPath(filePath, config = {}) {
  if (typeof filePath !== "string" || filePath.trim() === "") return null;
  const p = normalizePath(filePath);
  if (matchesAny(stringList(config, "allow"), p)) return null;
  if (matchesAny(stringList(config, "extra"), p)) {
    return { reason: "matches an extra protected glob", readOk: false };
  }
  const base = baseName(p).toLowerCase();
  if (/^\.env(\..+)?$/.test(base) && !TEMPLATE_SUFFIX.test(base)) {
    return { reason: "environment file that usually holds secrets", readOk: false };
  }
  if (/\.(?:pem|key|p12|pfx)$/.test(base)) {
    return { reason: "private key or certificate file", readOk: false };
  }
  if (/^id_(?:rsa|ed25519|ecdsa|dsa)/.test(base) && !base.endsWith(".pub")) {
    return { reason: "SSH private key", readOk: false };
  }
  if (base === "credentials.json") {
    return { reason: "credentials file", readOk: false };
  }
  const lower = "/" + p.toLowerCase();
  if (lower.endsWith("/.aws/credentials")) {
    return { reason: "AWS credentials file", readOk: false };
  }
  if (lower.includes("/.ssh/")) {
    return { reason: "SSH directory", readOk: false };
  }
  if (base === ".npmrc" || base === ".pypirc") {
    return { reason: "package registry config that can hold auth tokens (writes are blocked)", readOk: true };
  }
  return null;
}

/**
 * @param {string} filePath
 * @param {Protection} prot
 * @param {string} verb
 */
function message(filePath, prot, verb) {
  return `Refusing to ${verb} ${filePath}: ${prot.reason}. If this is needed, ask the user to do it or to add an allow glob in .claude/hooks.config.json.`;
}

/**
 * Pull candidate paths out of a command word (handles --opt=value, VAR=value,
 * rev:path and host:path or src:dst forms).
 * @param {string} word
 * @returns {string[]}
 */
function candidatePaths(word) {
  let w = word;
  if (w.startsWith("-")) {
    const eq = w.indexOf("=");
    if (eq === -1) return [];
    w = w.slice(eq + 1);
  } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
    w = w.slice(w.indexOf("=") + 1);
  }
  /** @type {string[]} */
  const out = [w];
  if (!/^[A-Za-z]:[\/]/.test(w) && w.includes(":")) out.push(...w.split(":"));
  return out.filter((x) => x !== "");
}

/**
 * @param {string} command
 * @param {Record<string, any>} config
 */
function evaluateBash(command, config) {
  for (const level of parseCommand(command)) {
    for (const seg of level) {
      for (const r of seg.redirects) {
        const prot = classifyPath(r.target, config);
        if (!prot) continue;
        if (r.op.startsWith("<") && prot.readOk) continue;
        return deny(message(r.target, prot, r.op.startsWith("<") ? "read" : "write to"));
      }
      const words = unwrap(seg.words);
      if (words.length === 0) continue;
      const name = cmdName(words[0]);
      if (HARMLESS_CMDS.has(name)) continue;
      if (name === "git" && words.slice(1).includes("check-ignore")) continue;
      for (let i = 1; i < words.length; i++) {
        const w = words[i];
        if (w === "--env-file") {
          i++;
          continue;
        }
        if (w.startsWith("--env-file=")) continue;
        for (const cand of candidatePaths(w)) {
          const prot = classifyPath(cand, config);
          if (!prot) continue;
          if (prot.readOk && READ_ONLY_CMDS.has(name)) continue;
          return deny(message(cand, prot, prot.readOk ? "modify" : "access"));
        }
      }
    }
  }
  return allow();
}

/**
 * @param {any} input hook payload
 * @param {Record<string, any>} [config]
 */
export function evaluate(input, config = {}) {
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  if (tool === "Bash") {
    return typeof ti.command === "string" ? evaluateBash(ti.command, config) : allow();
  }
  const p = ti.file_path ?? ti.notebook_path ?? ti.path;
  if (typeof p !== "string" || p === "") return allow();
  const prot = classifyPath(p, config);
  if (!prot) return allow();
  if (tool === "Read" && prot.readOk) return allow();
  const verb = tool === "Read" ? "read" : "modify";
  return deny(message(p, prot, verb));
}

if (isMain(import.meta.url)) await runHook("protect-files", evaluate);
