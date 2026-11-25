import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tarParts } from "../tar.ts";

const LONG = `A.app/Frameworks/${"VeryLongFrameworkName".repeat(5)}.framework/${"Resource".repeat(4)}.bundle/文件.json`;

test("tarParts：系统 tar 能解开，目录和文件都在、内容一致、都有执行权限；超过 100 字节的路径和中文名不出错", async () => {
  const entries = [
    { path: "A.app", dir: true as const },
    { path: "A.app/A", data: new Blob([new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3])]) },
    { path: "A.app/Info.plist", data: new Blob(["<plist/>"]) },
    { path: "A.app/empty", data: new Blob([]) },
    { path: LONG, data: new Blob(["{}"]) },
  ];
  const { parts, size } = tarParts(entries, 1_700_000_000);
  const blob = new Blob(parts);
  assert.equal(blob.size, size);
  assert.equal(size % 512, 0);
  const dir = await mkdtemp(join(tmpdir(), "tar-"));
  await writeFile(join(dir, "a.tar"), new Uint8Array(await blob.arrayBuffer()));
  execFileSync("/usr/bin/tar", ["-xf", "a.tar"], { cwd: dir });
  assert.deepEqual([...(await readFile(join(dir, "A.app/A")))], [0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
  assert.equal(await readFile(join(dir, "A.app/Info.plist"), "utf8"), "<plist/>");
  assert.equal((await readFile(join(dir, "A.app/empty"))).length, 0);
  assert.equal(await readFile(join(dir, LONG), "utf8"), "{}");
  assert.equal((await stat(join(dir, "A.app/A"))).mode & 0o777, 0o755);
  assert.ok((await stat(join(dir, "A.app"))).isDirectory());
});
