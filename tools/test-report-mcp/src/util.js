// @ts-check
import fs from "node:fs";
import path from "node:path";

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/**
 * Remove ANSI escape sequences.
 * @param {string} text
 */
export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_RE, "");
}

/**
 * Normalise line endings to \n and strip ANSI.
 * @param {string} text
 */
export function clean(text) {
  return stripAnsi(text).replace(/\r\n?/g, "\n");
}

/**
 * @param {string} text
 * @param {number} n
 */
export function tailLines(text, n) {
  const lines = clean(text).replace(/\n+$/, "").split("\n");
  return lines.slice(-n);
}

/**
 * Keep the last `max` characters, noting the clip.
 * @param {string} text
 * @param {number} max
 */
export function clipEnd(text, max) {
  if (text.length <= max) return text;
  return `[clipped ${text.length - max} chars from the start]\n${text.slice(text.length - max)}`;
}

/**
 * @param {string} text
 * @param {number} max
 */
export function clipLine(text, max = 400) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * Nearest git root above `start`, else `start`.
 * @param {string} start
 */
export function detectRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

/** Root: REPO_ROOT env, else nearest git root, else cwd. */
export function resolveRoot() {
  const env = process.env.REPO_ROOT;
  return env ? path.resolve(env) : detectRoot(process.cwd());
}

/**
 * @param {string} root
 * @param {string} target
 */
export function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * @param {string} p
 */
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve an optional relative dir inside root. Throws on escape.
 * @param {string} root
 * @param {unknown} cwd
 */
export function resolveDir(root, cwd) {
  const raw = typeof cwd === "string" ? cwd.trim() : "";
  const dir = raw ? path.resolve(root, raw) : root;
  if (!isInside(root, dir) || !isInside(real(root), real(dir))) {
    throw new Error("Invalid path: outside repo root.");
  }
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    throw new Error(`Directory not found: ${raw || "."}`);
  }
  if (!st.isDirectory()) throw new Error(`Not a directory: ${raw}`);
  return dir;
}

/**
 * Resolve a file path (relative to dir) that must stay inside root.
 * @param {string} root
 * @param {string} dir
 * @param {string} file
 */
export function resolveFileInRoot(root, dir, file) {
  const abs = path.resolve(dir, file);
  if (!isInside(root, abs) || !isInside(real(root), real(abs))) {
    throw new Error("Invalid path: outside repo root.");
  }
  return abs;
}

/**
 * Convert file URLs to paths and drop the project root prefix, using forward slashes.
 * @param {string} text
 * @param {string[]} roots
 */
export function relativize(text, roots) {
  // Node's reporters percent-encode "~" in file paths (Windows 8.3 names such as
  // RUNNER~1), so decode it before matching the root.
  let out = text.replace(/file:\/\/(\/(?=[A-Za-z]:))?/g, "").replace(/%7E/gi, "~");
  const flags = process.platform === "win32" ? "gi" : "g";
  const seen = new Set();
  for (const r of roots) {
    for (const v of [r, r.replace(/\\/g, "/"), r.replace(/\//g, "\\")]) {
      const base = v.replace(/[\\/]+$/, "");
      if (!base || seen.has(base)) continue;
      seen.add(base);
      const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`${esc}[\\\\/]?`, flags), "");
    }
  }
  return out;
}

const FRAME_RES = [
  /^\s*at\s+\S/,
  /^\s*[\u276F\u203A]\s+\S+:\d+/,
  /^\s*File\s+".+",\s+line\s+\d+/,
  /^[\w./\\:-]+\.pyi?:\d+:/,
  /^\s+\S+\.go:\d+(\s|$)/,
  /^\s*[\w$.<>[\] ]+\s\(.+:\d+:\d+\)\s*$/,
];

/** @param {string} line */
export function isFrame(line) {
  return FRAME_RES.some((re) => re.test(line));
}

const NOISE_RE =
  /node_modules|node:internal|\(node:|[\\/]internal[\\/]|site-packages|[\\/]lib[\\/]python[\d.]*[\\/]|\(<anonymous>\)|\(index \d+\)|[\\/]go[\\/]src[\\/](runtime|testing)[\\/]|[\\/]_pytest[\\/]|[\\/]pluggy[\\/]/;

/** @param {string} line */
export function isNoiseFrame(line) {
  return NOISE_RE.test(line);
}

/**
 * Parse "file:line" out of a stack frame line.
 * @param {string} frame
 * @returns {{file: string, line: number} | null}
 */
export function locFromFrame(frame) {
  let m = /File\s+"(.+?)",\s+line\s+(\d+)/.exec(frame);
  if (m) return { file: m[1], line: Number(m[2]) };
  m = /(?:\(|\s|^)((?:[A-Za-z]:)?[^\s():]+):(\d+)(?::\d+)?\)?:?(?:\s|$)/.exec(frame);
  if (m) return { file: m[1], line: Number(m[2]) };
  return null;
}

/**
 * Split text into non-frame message lines and kept frames (noise dropped).
 * @param {string} text
 * @param {number} [maxFrames]
 */
export function splitStack(text, maxFrames = 8) {
  /** @type {string[]} */
  const message = [];
  /** @type {string[]} */
  const frames = [];
  for (const raw of text.split("\n")) {
    if (isFrame(raw)) {
      if (!isNoiseFrame(raw)) frames.push(raw.trim());
    } else {
      message.push(raw);
    }
  }
  return { message, frames: frames.slice(0, maxFrames), allFrames: frames };
}

/**
 * Prefer a frame in `knownFile`, else the first kept frame.
 * @param {string[]} frames
 * @param {string} [knownFile]
 * @returns {{file?: string, line?: number}}
 */
export function pickLocation(frames, knownFile) {
  const locs = frames.map(locFromFrame).filter(/** @returns {l is {file:string,line:number}} */ (l) => l !== null);
  const norm = (/** @type {string} */ s) => s.replace(/\\/g, "/");
  if (knownFile) {
    const k = norm(knownFile);
    const hit = locs.find((l) => norm(l.file).endsWith(k) || k.endsWith(norm(l.file)));
    if (hit) return { file: norm(hit.file), line: hit.line };
  }
  if (locs[0]) return { file: norm(locs[0].file), line: locs[0].line };
  return knownFile ? { file: norm(knownFile) } : {};
}
