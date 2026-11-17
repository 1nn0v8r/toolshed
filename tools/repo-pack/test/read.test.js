// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { addLineNumbers, readForPack } from "../src/read.js";
import { put, rmDir, tmpDir } from "./helpers.js";

test("reads text, normalizes CRLF to LF, strips BOM", async () => {
  const d = tmpDir();
  try {
    put(d, "a.txt", "one\r\ntwo\r\n");
    put(d, "bom.txt", "﻿hello");
    put(d, "uni.txt", "café 日本 😀\n");
    assert.deepEqual(await readForPack(path.join(d, "a.txt"), 1000), { kind: "ok", content: "one\ntwo\n" });
    assert.deepEqual(await readForPack(path.join(d, "bom.txt"), 1000), { kind: "ok", content: "hello" });
    assert.deepEqual(await readForPack(path.join(d, "uni.txt"), 1000), {
      kind: "ok",
      content: "café 日本 😀\n",
    });
  } finally {
    rmDir(d);
  }
});

test("empty file is ok", async () => {
  const d = tmpDir();
  try {
    put(d, "e.txt", "");
    assert.deepEqual(await readForPack(path.join(d, "e.txt"), 10), { kind: "ok", content: "" });
  } finally {
    rmDir(d);
  }
});

test("binary: NUL in the first 8 KB", async () => {
  const d = tmpDir();
  try {
    put(d, "b.bin", Buffer.from([0x41, 0x00, 0x42]));
    const late = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]);
    put(d, "late.txt", late);
    const r = await readForPack(path.join(d, "b.bin"), 1000);
    assert.equal(r.kind === "skip" && r.code, "binary");
    const l = await readForPack(path.join(d, "late.txt"), 100000);
    assert.equal(l.kind, "ok", "a NUL after the first 8 KB is not sniffed");
  } finally {
    rmDir(d);
  }
});

test("too large reports size and limit; boundary is inclusive", async () => {
  const d = tmpDir();
  try {
    put(d, "big.txt", "x".repeat(101));
    put(d, "edge.txt", "x".repeat(100));
    const r = await readForPack(path.join(d, "big.txt"), 100);
    assert.equal(r.kind, "skip");
    if (r.kind === "skip") {
      assert.equal(r.code, "too-large");
      assert.match(r.reason, /101 bytes, limit 100/);
    }
    assert.equal((await readForPack(path.join(d, "edge.txt"), 100)).kind, "ok");
  } finally {
    rmDir(d);
  }
});

test("invalid UTF-8 is skipped", async () => {
  const d = tmpDir();
  try {
    put(d, "latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    const r = await readForPack(path.join(d, "latin1.txt"), 100);
    assert.equal(r.kind === "skip" && r.code, "not-utf8");
  } finally {
    rmDir(d);
  }
});

test("missing file and directory", async () => {
  const d = tmpDir();
  try {
    const m = await readForPack(path.join(d, "nope.txt"), 100);
    assert.equal(m.kind === "skip" && m.code, "missing");
    fs.mkdirSync(path.join(d, "sub"));
    assert.deepEqual(await readForPack(path.join(d, "sub"), 100), { kind: "ignore" });
  } finally {
    rmDir(d);
  }
});

test("symlinks are skipped (when the OS allows creating them)", async (t) => {
  const d = tmpDir();
  try {
    put(d, "real.txt", "hi");
    try {
      fs.symlinkSync(path.join(d, "real.txt"), path.join(d, "link.txt"));
    } catch {
      t.skip("cannot create symlinks here");
      return;
    }
    const r = await readForPack(path.join(d, "link.txt"), 100);
    assert.equal(r.kind === "skip" && r.code, "symlink");
  } finally {
    rmDir(d);
  }
});

test("addLineNumbers", () => {
  assert.equal(addLineNumbers(""), "");
  assert.equal(addLineNumbers("a\nb\n"), "1 | a\n2 | b\n");
  assert.equal(addLineNumbers("a\nb"), "1 | a\n2 | b");
  assert.equal(addLineNumbers("\n"), "1 | \n");
  const ten = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");
  const lines = addLineNumbers(ten).split("\n");
  assert.equal(lines[0], " 1 | l1");
  assert.equal(lines[9], "10 | l10");
});
