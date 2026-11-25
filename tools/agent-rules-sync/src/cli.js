#!/usr/bin/env node
// @ts-check
import { run } from "./main.js";

process.exitCode = await run(process.argv.slice(2));
