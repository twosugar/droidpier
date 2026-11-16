import { test } from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { connectPhone, PASTE_GAP_MS, type PhoneDeps } from "../src/phone-session.ts";
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
  assert.deepEqual(s.caps, { rotate: false, reboot: false, stop: false, clipboard: true, input: true, scroll: true });
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

// 输入和剪贴板：读控制连接上写出的字节（格式见 gateway/test/scrcpy.test.ts）
async function connected(firstSession: [number, number] = [864, 1920]) {
  const f = fakes({ firstSession });
  const s = await connectPhone("R5CR10WN52H", f.deps);
  f.control.written.length = 0;
  const out = () => f.control.written.splice(0);
  return { f, s, out };
}
const touchOf = (b: Buffer) => ({ type: b[0], action: b[1], x: b.readInt32BE(10), y: b.readInt32BE(14), w: b.readUInt16BE(18), h: b.readUInt16BE(20) });

test("touch：按下 → 移动 → 抬起依次写 DOWN / MOVE / UP，坐标按视频尺寸", async () => {
  const { s, out } = await connected();
  await s.touch(100, 200, true);
  await s.touch(110, 220, true);
  await s.touch(120, 240, false);
  assert.deepEqual(out().map(touchOf), [
    { type: 2, action: 0, x: 100, y: 200, w: 864, h: 1920 },
    { type: 2, action: 2, x: 110, y: 220, w: 864, h: 1920 },
    { type: 2, action: 1, x: 120, y: 240, w: 864, h: 1920 },
  ]);
});

test("touch：没按着时的抬起不写", async () => {
  const { s, out } = await connected();
  await s.touch(1, 2, false);
  assert.deepEqual(out(), []);
});

test("横屏视频时 touch 坐标经 toVideo 换算", async () => {
  const { s, out } = await connected([1920, 864]);
  await s.touch(100, 200, true);
  assert.deepEqual(out().map(touchOf), [{ type: 2, action: 0, x: 1720, y: 100, w: 1920, h: 864 }]);
});

test("按着时视频尺寸变了：用新尺寸补一个 UP；之后到用户松手前的按下 / 移动都不写，松手后再按才是新的 DOWN", async () => {
  const { f, s, out } = await connected();
  await s.touch(100, 200, true);
  out();
  f.video.feed(session(1920, 864));
  await tick();
  assert.deepEqual(out().map(touchOf), [{ type: 2, action: 1, x: 1720, y: 100, w: 1920, h: 864 }]);
  // 页面还没收到新方向，这几次移动的坐标是按旧方向算的
  await s.touch(110, 220, true);
  await s.touch(120, 240, true);
  await s.touch(120, 240, false);
  assert.deepEqual(out(), []);
  await s.touch(100, 200, true);
  assert.equal(touchOf(out()[0]).action, 0);
});

test("key：GoBack keypress 写按下 + 抬起两条；单个字符 keypress 写 inject text", async () => {
  const { s, out } = await connected();
  await s.key("GoBack", "keypress");
  await s.key("a", "keypress");
  await s.key("Enter", "keydown");
  await s.key("Enter", "keyup");
  const w = out();
  assert.deepEqual(w.map((b) => [b[0], b[1], b.length === 14 ? b.readInt32BE(2) : -1]), [[0, 0, 4], [0, 1, 4], [1, 0, -1], [0, 0, 66], [0, 1, 66]]);
  assert.deepEqual([...w[2]], [1, 0, 0, 0, 1, 0x61]);
});

test("key：不认识的键名 reject「不认识的按键」，不写", async () => {
  const { s, out } = await connected();
  await assert.rejects(s.key("F5", "keydown"), /不认识的按键：F5/);
  assert.deepEqual(out(), []);
});

test("text：写 set clipboard 且 paste=1；之后 getClipboard 返回这段文字", async () => {
  const { s, out } = await connected();
  await s.text("中文 ab");
  const [b] = out();
  assert.deepEqual([b[0], b[9]], [9, 1]);
  assert.equal(b.subarray(14).toString("utf8"), "中文 ab");
  assert.equal(await s.getClipboard(), "中文 ab");
  await s.setClipboard("x");
  assert.deepEqual([out()[0][9]], [0]);
  assert.equal(await s.getClipboard(), "x");
});

test("text / setClipboard：超长 reject「文字太长」，会话不关", async () => {
  const { s, out } = await connected();
  let closed = 0;
  s.onClosed(() => closed++);
  await assert.rejects(s.text("a".repeat(262131)), /文字太长/);
  await assert.rejects(s.setClipboard("a".repeat(262131)), /文字太长/);
  assert.deepEqual(out(), []);
  assert.equal(closed, 0);
});

test("控制连接回传剪贴板 → onClipboard 回调、getClipboard 更新", async () => {
  const { f, s } = await connected();
  const got: string[] = [];
  s.onClipboard((t) => got.push(t));
  const t = Buffer.from("手机复制的", "utf8");
  const h = Buffer.alloc(5);
  h.writeUInt32BE(t.length, 1);
  const msg = Buffer.concat([h, t]);
  f.control.feed(msg.subarray(0, 7));
  f.control.feed(msg.subarray(7));
  await tick();
  assert.deepEqual(got, ["手机复制的"]);
  assert.equal(await s.getClipboard(), "手机复制的");
});

test("控制连接回传看不懂的消息 → 会话关闭", async () => {
  const { f, s } = await connected();
  let closed = 0;
  s.onClosed(() => closed++);
  f.control.feed(Buffer.from([9]));
  await tick();
  assert.equal(closed, 1);
});

test("scroll：往下滚 120px 写 vscroll 为负；坐标按视频尺寸", async () => {
  const { s, out } = await connected([1920, 864]);
  await s.scroll!(100, 200, 0, 120);
  const [b] = out();
  assert.deepEqual([b[0], b.readInt32BE(1), b.readInt32BE(5), b.readUInt16BE(9), b.readUInt16BE(11)], [3, 1720, 100, 1920, 864]);
  assert.equal(b.readInt16BE(13), 0);
  assert.equal(b.readInt16BE(15), Math.round((-1.2 / 16) * 0x8000));
});

test("会话关闭后 touch / key / text / scroll 都 resolve 且不写", async () => {
  const { s, out } = await connected();
  s.close();
  await s.touch(1, 2, true);
  await s.key("GoBack", "keypress");
  await s.text("x");
  await s.setClipboard("x");
  await s.scroll!(1, 2, 0, 10);
  assert.deepEqual(out(), []);
});

test("text：连续两次粘贴之间至少隔 PASTE_GAP_MS，后一次等前一次被 App 读走（手机上粘贴键是异步处理的）", async () => {
  const { s, out } = await connected();
  const t0 = Date.now();
  await s.text("长");
  await s.text("桥");
  const elapsed = Date.now() - t0;
  const w = out();
  assert.deepEqual(w.map((b) => b.subarray(14).toString("utf8")), ["长", "桥"]);
  assert.ok(elapsed >= PASTE_GAP_MS - 5, `两次粘贴只隔了 ${elapsed}ms`);
});

test("text：离上次粘贴已经够久时不等", async () => {
  const { s, out } = await connected();
  const t0 = Date.now();
  await s.text("长");
  assert.ok(Date.now() - t0 < 20);
  assert.equal(out().length, 1);
});
