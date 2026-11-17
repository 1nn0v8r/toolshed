#!/usr/bin/env node
// @ts-check
import { run } from "./run.js";

const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
process.exitCode = code;
