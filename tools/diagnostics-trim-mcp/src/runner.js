// @ts-check
import { spawn } from "node:child_process";

/**
 * Execute a command and capture its stdout and stderr.
 * @param {string} command
 * @param {string} cwd
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<{ exitCode: number, output: string }>}
 */
export function runCommand(command, cwd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let combined = "";

    const proc = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      proc.kill();
      resolve({ exitCode: 124, output: combined + "\n[Command timed out]" });
    }, timeoutMs);

    proc.stdout?.on("data", (chunk) => {
      combined += chunk.toString();
    });

    proc.stderr?.on("data", (chunk) => {
      combined += chunk.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, output: combined + `\n${err.message}` });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, output: combined });
    });
  });
}
