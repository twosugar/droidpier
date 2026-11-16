import { test } from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { connectPhone, type PhoneDeps } from "../src/phone-session.ts";
import type { AdbStreamHandlers } from "../src/adb.ts";
import type { VideoPacket } from "../src/emulator.ts";

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// scrcpy v5.0.1 视频连接的字节（格式见 gateway/test/scrcpy.test.ts）
const name = Buffer.alloc(64);
name.write("SM-G9910");
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const session = (w: number, h: number) => Buffer.concat([u32(0x80000000), u32(w), u32(h)]);
const packet = (ptsFlags: bigint, data: Buffer) => {
  const h = Buffer.alloc(12);
  h.writeBigUInt64BE(ptsFlags);
  h.writeUInt32BE(data.length, 8);
  return Buffer.concat([h, data]);
};
const CONFIG = packet(1n << 62n, Buffer.from([0, 0, 0, 1, 0x67]));
const KEY = packet((1n << 61n) | 1n, Buffer.from([0, 0, 0, 1, 0x65]));
const DELTA = packet(2n, Buffer.from([0, 0, 0, 1, 0x41]));
const HELLO = Buffer.concat([Buffer.from([0]), name, u32(0x68323634)]);

/** 假套接字：feed 模拟服务端发来的数据，written 记录网关写出的数据。 */
function sock() {
  const written: Buffer[] = [];
  const s = new Duplex({ read() {}, write(c, _e, cb) { written.push(Buffer.from(c)); cb(); } });
  return { s, written, feed: (b: Buffer) => s.push(b), end: () => s.push(null) };
}

/** 假依赖：connect 依次交出 sockets 里预先排好的套接字；video 连上后自动推 HELLO + 会话包。 */
function fakes(opts: { refusals?: number; firstSession?: [number, number]; never?: boolean } = {}) {
  const calls: string[] = [];
  const video = sock();
  const control = sock();
  let refusals = opts.refusals ?? 0;
  let server!: AdbStreamHandlers;
  let now = 0;
  const deps: PhoneDeps = {
    jarPath: async () => (calls.push("jarPath"), "/tmp/droidpier-scrcpy-5.0.1.jar"),
    push: async (l, r) => void calls.push(`push ${l} ${r}`),
    freePort: async () => (calls.push("freePort"), 27183),
    releasePort: (p) => void calls.push(`release ${p}`),
    forward: async (p, scid) => void calls.push(`forward ${p} ${/^[0-9a-f]{8}$/.test(scid) ? "scid" : scid}`),
    removeForward: async (p) => void calls.push(`removeForward ${p}`),
    startServer: (cmd, h) => {
      calls.push(`start ${cmd.includes("com.genymobile.scrcpy.Server 5.0.1") ? "ok" : cmd}`);
      server = h;
      return { stop: () => void calls.push("stopServer") };
    },
    connect: async () => {
      if (refusals > 0) {
        refusals--;
        const r = sock();
        setImmediate(r.end);
        return r.s;
      }
      if (!calls.includes("connect video")) {
        calls.push("connect video");
        if (!opts.never) setImmediate(() => { video.feed(HELLO); video.feed(session(...(opts.firstSession ?? [864, 1920]))); });
        return video.s;
      }
      calls.push("connect control");
      return control.s;
    },
    screencap: async () => Buffer.from("PNG"),
    now: () => now,
    log: () => {},
  };
  return { deps, calls, video, control, server: () => server, advance: (ms: number) => (now += ms) };
}

test("connectPhone：按顺序 push、forward、起服务端、连视频再连控制，device 是竖屏尺寸", async () => {
  const f = fakes({ firstSession: [1920, 864] });
  const s = await connectPhone("R5CR10WN52H", f.deps);
  assert.deepEqual(f.calls, [
    "jarPath",
    "push /tmp/droidpier-scrcpy-5.0.1.jar /data/local/tmp/droidpier-scrcpy-5.0.1.jar",
    "freePort",
    "forward 27183 scid",
    "start ok",
    "connect video",
    "connect control",
  ]);
  assert.equal(s.kind, "phone");
  assert.equal(s.id, "R5CR10WN52H");
  assert.equal(s.serial, 0);
  assert.deepEqual(s.device, { width: 864, height: 1920 });
  assert.equal(s.rotation, 90);
  assert.deepEqual(s.caps, { rotate: false, reboot: false, stop: false, clipboard: false, input: false });
});

test("connectPhone：服务端还没监听（连上就断）时重试", async () => {
  const f = fakes({ refusals: 2 });
  const s = await connectPhone("R5CR10WN52H", f.deps);
  assert.equal(s.kind, "phone");
});

test("video：新订阅者先收到缓存的配置包，再收到后续包；包里带当前尺寸", async () => {
  const f = fakes();
  const s = await connectPhone("R5CR10WN52H", f.deps);
  f.video.feed(CONFIG);
  f.video.feed(KEY);
  await tick();
  const got: VideoPacket[] = [];
  s.video!((p) => got.push(p));
  f.video.feed(DELTA);
  await tick();
  assert.deepEqual(got.map((p) => [p.config, p.key, p.width, p.height]), [[true, false, 864, 1920], [false, false, 864, 1920]]);
});

test("取消订阅后不再收到包", async () => {
  const f = fakes();
  const s = await connectPhone("R5CR10WN52H", f.deps);
  const got: VideoPacket[] = [];
  const off = s.video!((p) => got.push(p));
  off();
  f.video.feed(KEY);
  await tick();
  assert.equal(got.length, 0);
});

test("requestKeyFrame 向控制连接写 [17]，200ms 内只写一次", async () => {
  const f = fakes();
  const s = await connectPhone("R5CR10WN52H", f.deps);
  s.requestKeyFrame!();
  s.requestKeyFrame!();
  f.advance(250);
  s.requestKeyFrame!();
  await tick();
  assert.deepEqual(f.control.written.map((b) => [...b]), [[17], [17]]);
});

test("会话包宽高从竖变横时回调 onRotation(90)，device 不变", async () => {
  const f = fakes();
  const s = await connectPhone("R5CR10WN52H", f.deps);
  const rot: number[] = [];
  s.onRotation((r) => rot.push(r));
  f.video.feed(session(1920, 864));
  await tick();
  assert.deepEqual(rot, [90]);
  assert.equal(s.rotation, 90);
  assert.deepEqual(s.device, { width: 864, height: 1920 });
});

test("服务端退出 → onClosed 一次，移除 forward 并释放端口", async () => {
  const f = fakes();
  const s = await connectPhone("R5CR10WN52H", f.deps);
  let closed = 0;
  s.onClosed(() => closed++);
  f.server().onExit(1);
  await tick();
  assert.equal(closed, 1);
  assert.ok(f.calls.includes("removeForward 27183"));
  assert.ok(f.calls.includes("release 27183"));
});

test("视频连接断开 → 同样关闭；close() 之后再断开不重复回调", async () => {
  const f = fakes();
  const s = await connectPhone("R5CR10WN52H", f.deps);
  let closed = 0;
  s.onClosed(() => closed++);
  f.video.end();
  await tick();
  s.close();
  f.server().onExit(null);
  await tick();
  assert.equal(closed, 1);
  assert.equal(f.calls.filter((c) => c === "removeForward 27183").length, 1);
  assert.ok(f.calls.includes("stopServer"));
});

test("rotate / reboot 抛「这台设备不支持」；touch 不报错；screenshot 走 screencap", async () => {
  const f = fakes();
  const s = await connectPhone("R5CR10WN52H", f.deps);
  await assert.rejects(s.rotate(), /这台设备不支持/);
  await assert.rejects(s.reboot(), /这台设备不支持/);
  await s.touch(1, 2, true);
  assert.equal((await s.screenshot()).toString(), "PNG");
});

test("连不上服务端（一直收不到数据）→ reject，并移除 forward、停服务端", async () => {
  const f = fakes({ never: true });
  f.deps.connectTimeoutMs = 300;
  await assert.rejects(connectPhone("R5CR10WN52H", f.deps), /scrcpy/);
  await sleep(10);
  assert.ok(f.calls.includes("removeForward 27183"));
  assert.ok(f.calls.includes("stopServer"));
});
