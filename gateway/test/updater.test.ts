import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  checkPending, confirmStable, createAutoUpdater, downloadBase, installLayout, newerNotice, remoteNewer, updateOnce,
  DOWNLOAD_BASE, NEWER_LINE, UPDATE_PUBLIC_KEY, type UpdaterDeps,
} from "../src/updater.ts";
import { signManifest } from "../../scripts/sign-update.ts";

const BIN = "/Users/someone/.local/bin/droidpier";
const STAMP = "/Users/someone/.local/share/droidpier/installed.sha256";
const PENDING = "/Users/someone/.local/share/droidpier/update-pending";
const BAD = "/Users/someone/.local/share/droidpier/update-bad";
const BASE = "https://droid.devpier.dev/download";
const OLD = "a".repeat(64);
const NEW = "b".repeat(64);
const RUNNING = "2026-11-13T00:00:00.000Z";
const NEWER = "2026-11-14T00:00:00.000Z";
const MANIFEST = `${BASE}/droidpier-darwin-arm64.update.json`;

const keys = generateKeyPairSync("ed25519");
const PUB = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const PRIV = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const other = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const manifest = (o: { version?: string; sha256?: string; name?: string } = {}) =>
  Buffer.from(`${JSON.stringify({ name: o.name ?? "droidpier-darwin-arm64", version: o.version ?? NEWER, sha256: o.sha256 ?? NEW })}\n`);

/**
 * 假的下载站 + 文件系统 + 命令。remote 是下载站上的清单，sig 是它的签名（默认用测试私钥签）；
 * download 写进 files 的内容就是“压缩包”，它的 sha256 由 archiveSha 决定。
 */
function fake(o: {
  remote?: Buffer | null; sig?: string | null; stamp?: string | null; archiveSha?: string; downloadFails?: boolean; netFails?: boolean;
  busy?: () => string | null; versionOut?: string; extracted?: { isFile: boolean; size: number }; writable?: boolean;
} = {}) {
  const files = new Map<string, string>();
  if (o.stamp !== null) files.set(STAMP, `${o.stamp ?? OLD}\n`);
  files.set(BIN, "old-binary");
  const remote = o.remote === undefined ? manifest() : o.remote;
  const sig = o.sig === undefined ? (remote ? signManifest(remote, PRIV) : null) : o.sig;
  const urls: string[] = [];
  const execs: string[] = [];
  const log: string[] = [];
  const dirs: string[] = [];
  let n = 0;
  const d: UpdaterDeps = {
    base: BASE,
    bin: BIN,
    stamp: STAMP,
    version: RUNNING,
    publicKey: PUB,
    getSmall: async (url, max) => {
      urls.push(url);
      if (o.netFails) throw new Error("HTTP 503");
      const body = url === MANIFEST ? remote : url === `${MANIFEST}.sig` ? (sig === null ? null : Buffer.from(sig)) : null;
      if (body && body.length > max) throw new Error("too big");
      return body;
    },
    download: async (url, dest) => {
      urls.push(url);
      if (o.downloadFails) throw new Error("连接断开");
      files.set(dest, "archive");
    },
    sha256File: async (p) => {
      assert.ok(files.has(p), `${p} 不存在`);
      return o.archiveSha ?? NEW;
    },
    readFile: async (p) => files.get(p) ?? null,
    writeFile: async (p, s) => void files.set(p, s),
    copyFile: async (a, b) => {
      assert.ok(files.has(a), `${a} 不存在`);
      files.set(b, files.get(a)!);
    },
    mkdir: async () => {},
    mkdtemp: async (prefix) => {
      const dir = `${prefix}${++n}`;
      dirs.push(dir);
      return dir;
    },
    rm: async (p) => {
      for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k);
    },
    rename: async (a, b) => {
      assert.ok(files.has(a), `${a} 不存在`);
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    chmod: async () => {},
    lstat: async (p) => (files.has(p) ? o.extracted ?? { isFile: true, size: 60 * 2 ** 20 } : null),
    writable: async () => o.writable ?? true,
    exec: async (cmd, args) => {
      execs.push([cmd, ...args].join(" "));
      if (cmd === "/usr/bin/tar") {
        files.set(`${args[3]}/${args[4]}`, "new-binary");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "--version") return { code: 0, stdout: o.versionOut ?? `droidpier ${NEWER}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    busy: o.busy ?? (() => null),
    log: (s) => void log.push(s),
  };
  return { d, files, urls, execs, log, dirs };
}

const unchanged = (f: ReturnType<typeof fake>) => {
  assert.equal(f.files.get(BIN), "old-binary");
  assert.equal(f.files.get(STAMP)?.trim(), OLD);
  assert.equal(f.files.has(PENDING), false);
};

test("updateOnce：清单里的版本和装过的一样（sha256 相同）时不下载、不动可执行文件", async () => {
  const f = fake({ remote: manifest({ sha256: OLD }) });
  assert.deepEqual(await updateOnce(f.d), { kind: "latest" });
  assert.deepEqual(f.urls, [MANIFEST, `${MANIFEST}.sig`]);
  unchanged(f);
});

test("updateOnce：有签名对、版本更新的新版本时下载、先校验再解压、验过新程序，留一份旧的再换上", async () => {
  const f = fake();
  assert.deepEqual(await updateOnce(f.d), { kind: "updated" });
  assert.deepEqual(f.urls, [MANIFEST, `${MANIFEST}.sig`, `${BASE}/droidpier-darwin-arm64.tar.xz`]);
  assert.equal(f.files.get(BIN), "new-binary");
  assert.equal(f.files.get(STAMP)?.trim(), NEW);
  // 回退用：旧的可执行文件和 stamp 各留一份，等新版本稳定运行后确认
  assert.equal(f.files.get(`${BIN}.prev`), "old-binary");
  assert.equal(f.files.get(`${STAMP}.prev`)?.trim(), OLD);
  assert.equal(f.files.get(PENDING), "0");
  const work = f.dirs[0];
  assert.ok(work.startsWith("/Users/someone/.local/bin/.droidpier-update-"), "临时目录在可执行文件旁边，每次新建");
  assert.deepEqual(f.execs, [
    `/usr/bin/tar -xJf ${work}/droidpier-darwin-arm64.tar.xz -C ${work} droidpier-darwin-arm64`,
    `/usr/bin/xattr -d com.apple.quarantine ${work}/droidpier-darwin-arm64`,
    `${work}/droidpier-darwin-arm64 --version`,
  ]);
  assert.ok(![...f.files.keys()].some((k) => k.startsWith(work)), "临时目录收拾干净");
});

test("updateOnce：没有签名、签名不对（别的私钥签的、签的是别的内容）时拒绝，什么都不下载", async () => {
  const cases: [Parameters<typeof fake>[0], string][] = [
    [{ sig: null }, "unsigned"],
    [{ sig: signManifest(manifest(), other) }, "signature"],
    [{ sig: signManifest(manifest({ version: "2026-11-15T00:00:00.000Z" }), PRIV) }, "signature"],
    [{ sig: "not base64 at all!" }, "signature"],
  ];
  for (const [o, reason] of cases) {
    const f = fake(o);
    const r = await updateOnce(f.d);
    assert.equal(r.kind, "failed");
    assert.equal((r as { reason: string }).reason, reason);
    assert.equal(f.urls.length, 2, "只取了清单和签名");
    unchanged(f);
  }
});

test("updateOnce：清单里的版本不比正在运行的新（回滚攻击、旧包）时不换", async () => {
  for (const version of [RUNNING, "2026-11-01T00:00:00.000Z"]) {
    const f = fake({ remote: manifest({ version }) });
    assert.deepEqual(await updateOnce(f.d), { kind: "latest" });
    assert.equal(f.urls.length, 2);
    unchanged(f);
  }
});

test("updateOnce：清单格式不对（名字、sha256、版本）时不下载", async () => {
  for (const m of [manifest({ name: "other" }), manifest({ sha256: "xyz" }), manifest({ version: "yesterday" }), Buffer.from("not json")]) {
    const f = fake({ remote: m });
    const r = await updateOnce(f.d);
    assert.equal((r as { reason?: string }).reason, "manifest");
    unchanged(f);
  }
  const g = fake({ remote: null });
  assert.equal((await updateOnce(g.d) as { reason?: string }).reason, "manifest");
});

test("updateOnce：新程序报的版本和清单不一样时不换（防止拿旧包冒充新版本）", async () => {
  const f = fake({ versionOut: `droidpier ${RUNNING}\n` });
  const r = await updateOnce(f.d);
  assert.equal((r as { reason: string }).reason, "bad-binary");
  unchanged(f);
});

test("updateOnce：压缩包 sha256 不对时不解压、什么都不换", async () => {
  const f = fake({ archiveSha: "c".repeat(64) });
  const r = await updateOnce(f.d);
  assert.equal((r as { reason: string }).reason, "checksum");
  assert.deepEqual(f.execs, []);
  unchanged(f);
});

test("updateOnce：解压出来的不是普通文件或大小不像时不执行它", async () => {
  for (const extracted of [{ isFile: false, size: 60 * 2 ** 20 }, { isFile: true, size: 10 }, { isFile: true, size: 2 ** 31 }]) {
    const f = fake({ extracted });
    const r = await updateOnce(f.d);
    assert.equal((r as { reason: string }).reason, "unpack");
    assert.ok(!f.execs.some((e) => e.endsWith("--version")));
    unchanged(f);
  }
});

test("updateOnce：下载失败、连不上时留着旧版本接着跑；失败结果只给类别", async () => {
  const f = fake({ downloadFails: true });
  assert.deepEqual(await updateOnce(f.d), { kind: "failed", reason: "network", error: "连接断开" });
  unchanged(f);
  const g = fake({ netFails: true });
  assert.equal((await updateOnce(g.d) as { reason: string }).reason, "network");
  unchanged(g);
});

test("updateOnce：安装目录写不了时不下载", async () => {
  const f = fake({ writable: false });
  assert.equal((await updateOnce(f.d) as { reason: string }).reason, "not-writable");
  assert.equal(f.urls.length, 2);
  unchanged(f);
});

test("updateOnce：启动失败退回过的版本不再换上", async () => {
  const f = fake();
  f.files.set(BAD, `${NEW}\n`);
  assert.deepEqual(await updateOnce(f.d), { kind: "latest" });
  unchanged(f);
});

test("updateOnce：正在安装、开机、删除时推迟，不下载；下载期间开始忙也不换", async () => {
  const f = fake({ busy: () => "正在安装 SDK" });
  assert.deepEqual(await updateOnce(f.d), { kind: "deferred", reason: "正在安装 SDK" });
  assert.equal(f.urls.length, 2);

  let n = 0;
  const g = fake({ busy: () => (n++ > 0 ? "正在删除设备" : null) });
  assert.deepEqual(await updateOnce(g.d), { kind: "deferred", reason: "正在删除设备" });
  unchanged(g);
});

test("checkPending：刚换上新版本后每次启动加一，超过 3 次就换回旧版本和 stamp，记下坏版本", async () => {
  const f = fake();
  await updateOnce(f.d);
  for (let i = 1; i <= 3; i++) {
    assert.equal(await checkPending(f.d), "counting");
    assert.equal(f.files.get(PENDING), String(i));
  }
  assert.equal(await checkPending(f.d), "rolled-back");
  assert.equal(f.files.get(BIN), "old-binary");
  assert.equal(f.files.get(STAMP)?.trim(), OLD);
  assert.equal(f.files.get(BAD)?.trim(), NEW);
  assert.equal(f.files.has(PENDING), false);
  // 退回后不会再换上同一个坏版本
  assert.deepEqual(await updateOnce(f.d), { kind: "latest" });
});

test("checkPending / confirmStable：新版本稳定运行后删掉计数，之后的重启不算", async () => {
  const f = fake();
  await updateOnce(f.d);
  assert.equal(await checkPending(f.d), "counting");
  await confirmStable(f.d);
  assert.equal(f.files.has(PENDING), false);
  for (let i = 0; i < 5; i++) assert.equal(await checkPending(f.d), "none");
  assert.equal(f.files.get(BIN), "new-binary");
});

test("remoteNewer：没有新版本返回 null，有就返回清单（前台运行只用它打印一行）", async () => {
  assert.equal(await remoteNewer(fake({ remote: manifest({ sha256: OLD }) }).d), null);
  assert.equal((await remoteNewer(fake().d))?.version, NEWER);
});

test("newerNotice：前台运行只打印一行（同一个新版本只打印一次），从不下载、不动可执行文件", async () => {
  const f = fake();
  const check = newerNotice(f.d);
  await check();
  await check();
  assert.deepEqual(f.log, [NEWER_LINE]);
  assert.ok(f.urls.every((u) => u.startsWith(MANIFEST)));
  assert.deepEqual(f.execs, []);
  unchanged(f);
  const g = fake({ sig: null });
  await newerNotice(g.d)().catch(() => {});
  assert.deepEqual(g.log, [], "没签名的不提示");
});

test("downloadBase：默认固定地址；DROIDPIER_DOWNLOAD 只在允许时认，且只认 https 和 http://127.0.0.1", () => {
  const env = { DROIDPIER_DOWNLOAD: "http://127.0.0.1:7399/" };
  assert.deepEqual(downloadBase({}, true), { base: DOWNLOAD_BASE });
  assert.deepEqual(downloadBase(env, false), { base: DOWNLOAD_BASE }, "正式后台服务不认");
  assert.deepEqual(downloadBase(env, true), { base: "http://127.0.0.1:7399" });
  assert.deepEqual(downloadBase({ DROIDPIER_DOWNLOAD: "https://mirror.test/download" }, true), { base: "https://mirror.test/download" });
  for (const v of ["http://evil.test/download", "file:///tmp", "ftp://x", "http://127.0.0.1.evil.test/"]) assert.ok("error" in downloadBase({ DROIDPIER_DOWNLOAD: v }, true), v);
});

test("installLayout：只有安装命令装的单文件程序（<前缀>/bin/droidpier）才自动更新", () => {
  assert.deepEqual(installLayout(BIN, true), { bin: BIN, stamp: STAMP });
  assert.equal(installLayout(BIN, false), null, "从源码运行");
  assert.equal(installLayout("/repo/dist/droidpier-darwin-arm64", true), null);
  assert.equal(installLayout("/opt/droidpier", true), null);
});

test("UPDATE_PUBLIC_KEY 是一把 ed25519 公钥", async () => {
  const { createPublicKey } = await import("node:crypto");
  assert.equal(createPublicKey(UPDATE_PUBLIC_KEY).asymmetricKeyType, "ed25519");
  void sign;
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

test("createAutoUpdater：start 先查一次（返回结果），之后大约每 30 分钟（带随机偏移）查一次", async () => {
  const c = clock();
  let runs = 0;
  const u = createAutoUpdater({ check: async () => (runs++, { state: "latest" }), now: c.now, setTimer: c.setTimer, random: () => 0.5, intervalMs: 30 * 60_000, jitterMs: 5 * 60_000, pageGapMs: 60_000 });
  assert.deepEqual(await u.start(), { state: "latest" });
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

test("createAutoUpdater：连续失败时间隔加倍（最多 8 倍），成功后恢复", async () => {
  const c = clock();
  let fail = true;
  let runs = 0;
  const u = createAutoUpdater({ check: async () => (runs++, fail ? { state: "failed", message: "network" } : { state: "latest" }), now: c.now, setTimer: c.setTimer, random: () => 0.5, intervalMs: 1000, jitterMs: 0, pageGapMs: 0 });
  await u.start();
  await new Promise((r) => setImmediate(r));
  await c.advance(1999);
  assert.equal(runs, 1, "失败一次后等 2 倍");
  await c.advance(1);
  assert.equal(runs, 2);
  await c.advance(4000);
  assert.equal(runs, 3, "再失败等 4 倍");
  fail = false;
  await c.advance(8000);
  assert.equal(runs, 4);
  await c.advance(1000);
  assert.equal(runs, 5, "成功后回到正常间隔");
  u.stop();
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

test("createAutoUpdater：检查本身抛错时记成 failed（不带原始错误），定时检查继续", async () => {
  const c = clock();
  let runs = 0;
  const u = createAutoUpdater({ check: async () => { runs++; throw new Error("boom /Users/someone/x"); }, now: c.now, setTimer: c.setTimer, random: () => 0, intervalMs: 1000, jitterMs: 0, pageGapMs: 0 });
  await u.start();
  assert.deepEqual(u.last()?.report, { state: "failed", message: "network" });
  await c.advance(2000);
  assert.equal(runs, 2);
  u.stop();
});
