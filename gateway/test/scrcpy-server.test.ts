import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeScrcpyServer, SCRCPY_SHA256, scrcpyServerPath } from "../src/scrcpy-server.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test("随包的 scrcpy-server 与官方 v5.0.1 一致", async () => {
  const buf = await readFile(scrcpyServerPath(false));
  assert.equal(buf.length, 733930);
  assert.equal(sha(buf), SCRCPY_SHA256);
});

test("materializeScrcpyServer 写出真实文件，sha256 正确；第二次直接复用", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "emu-scrcpy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const p = await materializeScrcpyServer(scrcpyServerPath(false), dir);
  assert.equal(p, join(dir, "droidpier-scrcpy-5.0.1.jar"));
  assert.equal(sha(await readFile(p)), SCRCPY_SHA256);
  const before = (await stat(p)).mtimeMs;
  assert.equal(await materializeScrcpyServer(scrcpyServerPath(false), dir), p);
  assert.equal((await stat(p)).mtimeMs, before);
});

test("materializeScrcpyServer：源文件被改过时报错，不写出", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "emu-scrcpy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bad = join(dir, "bad.jar");
  await copyFile(scrcpyServerPath(false), bad);
  await writeFile(bad, Buffer.from("tampered"), { flag: "a" });
  await assert.rejects(materializeScrcpyServer(bad, dir), /sha256/);
  await assert.rejects(stat(join(dir, "droidpier-scrcpy-5.0.1.jar")));
});
