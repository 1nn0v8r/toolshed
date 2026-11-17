// @ts-check
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/** @returns {string} */
export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "token-count-"));
}

/** @param {string} dir */
export function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Write files (relative path to content) under dir.
 * @param {string} dir
 * @param {Record<string, string | Buffer>} files
 */
export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/**
 * @param {string} dir
 * @param {string[]} args
 */
export function git(dir, args) {
  return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Create a temp git repo with an initial commit of the given files.
 * @param {Record<string, string | Buffer>} files
 * @returns {string}
 */
export function makeRepo(files) {
  const dir = tmpDir();
  git(dir, ["init", "-q"]);
  writeFiles(dir, files);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/**
 * Run the CLI in-process and capture output.
 * @param {typeof import("../src/cli.js").run} run
 * @param {string[]} argv
 * @param {{cwd?: string, env?: Record<string, string | undefined>, stdin?: string}} [opts]
 */
export async function runCapture(run, argv, opts = {}) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    out: (s) => { stdout += s; },
    err: (s) => { stderr += s; },
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? {},
    readStdin: async () => opts.stdin ?? "",
  });
  return { code, stdout, stderr };
}

/**
 * Start a local mock HTTP server. The handler decides each response.
 * @param {(req: {method: string, url: string, headers: http.IncomingHttpHeaders, body: any}, n: number, res: http.ServerResponse) => void} handler
 * @returns {Promise<{url: string, requests: any[], close: () => Promise<void>}>}
 */
export function startMock(handler) {
  /** @type {any[]} */
  const requests = [];
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      requests.push(entry);
      handler(entry, requests.length, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} data
 */
export function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}
