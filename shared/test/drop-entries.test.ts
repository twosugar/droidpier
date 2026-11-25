import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesFromDrop, type DropEntry } from "../../host/src/drop-entries.ts";

/** 假的 FileSystemEntry：目录分批（每批最多 2 个）交出子项，像浏览器那样要读到空批为止。 */
const fileEntry = (name: string, body: string): DropEntry => ({
  name, isFile: true, isDirectory: false,
  file: (ok) => ok(new File([body], name)),
});
const dirEntry = (name: string, children: DropEntry[]): DropEntry => ({
  name, isFile: false, isDirectory: true,
  createReader: () => {
    let i = 0;
    return { readEntries: (ok) => { const batch = children.slice(i, i + 2); i += batch.length; setTimeout(() => ok(batch), 0); } };
  },
});

test("filesFromDrop：.app 文件夹打成一个 .app.tar（子目录、分批读出的子项都在），普通文件原样；别的文件夹跳过并说明", async () => {
  const app = dirEntry("Demo.app", [
    fileEntry("Demo", "bin"),
    fileEntry("Info.plist", "<plist/>"),
    dirEntry("Frameworks", [dirEntry("X.framework", [fileEntry("X", "lib")])]),
    dirEntry("Empty", []),
  ]);
  const r = await filesFromDrop([app, fileEntry("notes.txt", "hi"), dirEntry("photos", [fileEntry("a.png", "p")])]);
  assert.deepEqual(r.files.map((f) => f.name), ["Demo.app.tar", "notes.txt"]);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /photos/);

  const dir = await mkdtemp(join(tmpdir(), "drop-"));
  await writeFile(join(dir, "a.tar"), new Uint8Array(await r.files[0].arrayBuffer()));
  execFileSync("/usr/bin/tar", ["-xf", "a.tar"], { cwd: dir });
  assert.equal(await readFile(join(dir, "Demo.app/Demo"), "utf8"), "bin");
  assert.equal(await readFile(join(dir, "Demo.app/Frameworks/X.framework/X"), "utf8"), "lib");
  assert.equal(await readFile(join(dir, "Demo.app/Info.plist"), "utf8"), "<plist/>");
  execFileSync("/bin/test", ["-d", join(dir, "Demo.app/Empty")]);
});
