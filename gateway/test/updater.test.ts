import { test } from "node:test";
import assert from "node:assert/strict";
import { createAutoUpdater, downloadBase, installLayout, newerNotice, remoteNewer, updateOnce, DOWNLOAD_BASE, NEWER_LINE, type UpdaterDeps } from "../src/updater.ts";

const BIN = "/Users/someone/.local/bin/droidpier";
const STAMP = "/Users/someone/.local/share/droidpier/installed.sha256";
const BASE = "https://droid.devpier.dev/download";
const OLD = "a".repeat(64);
const NEW = "b".repeat(64);
const WORK = "/Users/someone/.local/bin/.droidpier-update";

/** 假的下载站 + 文件系统 + 命令：download 写进 files 的内容就是“压缩包”，它的 sha256 由 shaOf 决定。 */
function fake(o: { remote?: string; stamp?: string | null; archiveSha?: string; downloadFails?: boolean; shaFails?: boolean; busy?: () => string | null; versionOut?: string } = {}) {
  const files = new Map<string, string>();
  if (o.stamp !== null) files.set(STAMP, `${o.stamp ?? OLD}\n`);
  files.set(BIN, "old-binary");
  const urls: string[] = [];
  const execs: string[] = [];
  const log: string[] = [];
  const d: UpdaterDeps = {
    base: BASE,
    bin: BIN,
    stamp: STAMP,
    getText: async (url) => {
      urls.push(url);
      if (o.shaFails) throw new Error("HTTP 503");
      return `${o.remote ?? NEW}  droidpier-darwin-arm64.tar.xz\n`;
    },
    download: async (url, dest) => {
      urls.push(url);
      if (o.downloadFails) throw new Error("连接断开");
      files.set(dest, "archive");
    },
    sha256File: async (p) => {
      assert.ok(files.has(p), `${p} 不存在`);
      return o.archiveSha ?? o.remote ?? NEW;
    },
    readFile: async (p) => files.get(p) ?? null,
    writeFile: async (p, s) => void files.set(p, s),
    mkdir: async () => {},
    rm: async (p) => {
      for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k);
    },
    rename: async (a, b) => {
      assert.ok(files.has(a), `${a} 不存在`);
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    chmod: async () => {},
    exec: async (cmd, args) => {
      execs.push([cmd, ...args].join(" "));
      if (cmd === "/usr/bin/tar") {
        files.set(`${args[3]}/${args[4]}`, "new-binary");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "--version") return { code: 0, stdout: o.versionOut ?? "droidpier 2026-11-13T00:00:00.000Z\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    busy: o.busy ?? (() => null),
    log: (s) => void log.push(s),
  };
  return { d, files, urls, execs, log };
}

test("updateOnce：远端 sha256 和装过的一样时只取 .sha256，不下载、不动可执行文件", async () => {
  const f = fake({ remote: OLD });
  assert.deepEqual(await updateOnce(f.d), { kind: "latest" });
  assert.deepEqual(f.urls, [`${BASE}/droidpier-darwin-arm64.tar.xz.sha256`]);
  assert.equal(f.files.get(BIN), "old-binary");
});

test("updateOnce：有新版本时下载、先校验再解压、验过新程序能跑，再换上并记下 sha256", async () => {
  const f = fake();
  assert.deepEqual(await updateOnce(f.d), { kind: "updated" });
  assert.deepEqual(f.urls, [`${BASE}/droidpier-darwin-arm64.tar.xz.sha256`, `${BASE}/droidpier-darwin-arm64.tar.xz`]);
  assert.equal(f.files.get(BIN), "new-binary");
  assert.equal(f.files.get(STAMP)?.trim(), NEW);
  assert.deepEqual(f.execs, [
    `/usr/bin/tar -xJf ${WORK}/droidpier-darwin-arm64.tar.xz -C ${WORK} droidpier-darwin-arm64`,
    `/usr/bin/xattr -d com.apple.quarantine ${WORK}/droidpier-darwin-arm64`,
    `${WORK}/droidpier-darwin-arm64 --version`,
  ]);
  // 临时目录收拾干净
  assert.ok(![...f.files.keys()].some((k) => k.startsWith(WORK)));
});

test("updateOnce：没有装过的记录（stamp）也当作有新版本", async () => {
  const f = fake({ stamp: null });
  assert.deepEqual(await updateOnce(f.d), { kind: "updated" });
});

test("updateOnce：下载到的压缩包 sha256 不对时不解压、什么都不换", async () => {
  const f = fake({ archiveSha: "c".repeat(64) });
  const r = await updateOnce(f.d);
  assert.equal(r.kind, "failed");
  assert.match((r as { error: string }).error, /校验失败/);
  assert.deepEqual(f.execs, []);
  assert.equal(f.files.get(BIN), "old-binary");
  assert.equal(f.files.get(STAMP)?.trim(), OLD);
});

test("updateOnce：下载失败、取不到 .sha256 时留着旧版本接着跑", async () => {
  for (const o of [{ downloadFails: true }, { shaFails: true }]) {
    const f = fake(o);
    const r = await updateOnce(f.d);
    assert.equal(r.kind, "failed");
    assert.equal(f.files.get(BIN), "old-binary");
    assert.equal(f.files.get(STAMP)?.trim(), OLD);
  }
});

test("updateOnce：.sha256 内容不像 sha256 时不下载", async () => {
  const f = fake({ remote: "<html>not found</html>" });
  const r = await updateOnce(f.d);
  assert.equal(r.kind, "failed");
  assert.equal(f.urls.length, 1);
});

test("updateOnce：新程序跑不起来（--version 不对）时不换", async () => {
  const f = fake({ versionOut: "" });
  const r = await updateOnce(f.d);
  assert.equal(r.kind, "failed");
  assert.equal(f.files.get(BIN), "old-binary");
  assert.equal(f.files.get(STAMP)?.trim(), OLD);
});

test("updateOnce：正在安装、开机、删除时推迟，不下载；下载期间开始忙也不换", async () => {
  const f = fake({ busy: () => "正在安装 SDK" });
  assert.deepEqual(await updateOnce(f.d), { kind: "deferred", reason: "正在安装 SDK" });
  assert.equal(f.urls.length, 1, "只取了 .sha256");

  let n = 0;
  const g = fake({ busy: () => (n++ > 0 ? "正在删除设备" : null) });
  assert.deepEqual(await updateOnce(g.d), { kind: "deferred", reason: "正在删除设备" });
  assert.equal(g.files.get(BIN), "old-binary");
  assert.equal(g.files.get(STAMP)?.trim(), OLD);
});

test("remoteNewer：一样返回 null，不一样返回远端 sha256（前台运行只用它打印一行）", async () => {
  assert.equal(await remoteNewer(fake({ remote: OLD }).d), null);
  assert.equal(await remoteNewer(fake().d), NEW);
});

test("newerNotice：前台运行只打印一行（同一个新版本只打印一次），从不下载、不动可执行文件", async () => {
  const f = fake();
  const check = newerNotice(f.d);
  await check();
  await check();
  assert.deepEqual(f.log, [NEWER_LINE]);
  assert.ok(f.urls.every((u) => u.endsWith(".sha256")));
  assert.deepEqual(f.execs, []);
  assert.equal(f.files.get(BIN), "old-binary");
  const g = fake({ remote: OLD });
  await newerNotice(g.d)();
  assert.deepEqual(g.log, []);
});

test("downloadBase：默认固定地址；DROIDPIER_DOWNLOAD 只认 https 和测试用的 http://127.0.0.1", () => {
  assert.deepEqual(downloadBase({}), { base: DOWNLOAD_BASE });
  assert.deepEqual(downloadBase({ DROIDPIER_DOWNLOAD: "http://127.0.0.1:7399/" }), { base: "http://127.0.0.1:7399" });
  assert.deepEqual(downloadBase({ DROIDPIER_DOWNLOAD: "https://mirror.test/download" }), { base: "https://mirror.test/download" });
  for (const v of ["http://evil.test/download", "file:///tmp", "ftp://x", "http://127.0.0.1.evil.test/"]) assert.ok("error" in downloadBase({ DROIDPIER_DOWNLOAD: v }), v);
});

test("installLayout：只有安装命令装的单文件程序（<前缀>/bin/droidpier）才自动更新", () => {
  assert.deepEqual(installLayout(BIN, true), { bin: BIN, stamp: STAMP });
  assert.equal(installLayout(BIN, false), null, "从源码运行");
  assert.equal(installLayout("/repo/dist/droidpier-darwin-arm64", true), null);
  assert.equal(installLayout("/opt/droidpier", true), null);
});

/** 假的时钟和定时器。 */
function clock() {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return () => void timers.splice(timers.indexOf(t), 1);
    },
    advance: async (ms: number) => {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at > now) break;
        timers.splice(timers.indexOf(t), 1);
        t.fn();
        await new Promise((r) => setImmediate(r));
      }
    },
    pending: () => timers.length,
  };
}

test("createAutoUpdater：启动时查一次，之后大约每 30 分钟（带随机偏移）查一次", async () => {
  const c = clock();
  let runs = 0;
  const u = createAutoUpdater({ check: async () => (runs++, { state: "latest" }), now: c.now, setTimer: c.setTimer, random: () => 0.5, intervalMs: 30 * 60_000, jitterMs: 5 * 60_000, pageGapMs: 60_000 });
  u.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 1);
  await c.advance(29 * 60_000);
  assert.equal(runs, 1);
  await c.advance(2 * 60_000);
  assert.equal(runs, 2);
  assert.deepEqual(u.last()?.report, { state: "latest" });
  u.stop();
  assert.equal(c.pending(), 0);
});

test("createAutoUpdater：页面触发的检查一分钟最多一次，期间返回上次的结果；同时只跑一个检查", async () => {
  const c = clock();
  let runs = 0;
  let release: () => void = () => {};
  const u = createAutoUpdater({
    check: () => (runs++, new Promise((r) => (release = () => r({ state: "deferred", message: "正在安装 SDK" })))),
    now: c.now, setTimer: c.setTimer, random: () => 0, intervalMs: 30 * 60_000, jitterMs: 0, pageGapMs: 60_000,
  });
  const a = u.request();
  const b = u.request();
  release();
  assert.deepEqual(await a, { state: "deferred", message: "正在安装 SDK" });
  assert.deepEqual(await b, { state: "deferred", message: "正在安装 SDK" });
  assert.equal(runs, 1);
  await c.advance(30_000);
  assert.deepEqual(await u.request(), { state: "deferred", message: "正在安装 SDK" });
  assert.equal(runs, 1, "一分钟内不再查");
  await c.advance(31_000);
  const d = u.request();
  release();
  await d;
  assert.equal(runs, 2);
});

test("createAutoUpdater：检查本身抛错时记成 failed，定时检查继续", async () => {
  const c = clock();
  let runs = 0;
  const u = createAutoUpdater({ check: async () => { runs++; throw new Error("boom"); }, now: c.now, setTimer: c.setTimer, random: () => 0, intervalMs: 1000, jitterMs: 0, pageGapMs: 0 });
  u.start();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(u.last()?.report, { state: "failed", message: "boom" });
  await c.advance(1000);
  assert.equal(runs, 2);
  u.stop();
});
