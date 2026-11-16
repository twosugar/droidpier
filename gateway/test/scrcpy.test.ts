import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIPBOARD_MAX_BYTES,
  createDeviceMessageParser,
  createVideoParser,
  injectKeycode,
  injectScroll,
  injectText,
  injectTouch,
  randomScid,
  RESET_VIDEO,
  serverArgs,
  setClipboard,
  type DeviceEvent,
  type VideoEvent,
} from "../src/scrcpy.ts";

// 按 scrcpy v5.0.1 视频连接的格式拼字节（2026-11-13 原型在 SM-G9910 上实测）
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
const CONFIG = 1n << 62n;
const KEY = 1n << 61n;
const stream = Buffer.concat([
  Buffer.from([0]),
  name,
  u32(0x68323634),
  session(864, 1920),
  packet(CONFIG, Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a])),
  packet(KEY | 1000n, Buffer.from([0, 0, 0, 1, 0x65, 1])),
  packet(2000n, Buffer.from([0, 0, 0, 1, 0x41, 2])),
]);

const collect = (chunks: Buffer[]) => {
  const ev: VideoEvent[] = [];
  const p = createVideoParser((e) => ev.push(e));
  for (const c of chunks) p.push(c);
  return ev;
};

const expected: VideoEvent[] = [
  { kind: "meta", name: "SM-G9910" },
  { kind: "codec", id: 0x68323634 },
  { kind: "session", width: 864, height: 1920 },
  { kind: "packet", config: true, key: false, data: Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a]) },
  { kind: "packet", config: false, key: true, data: Buffer.from([0, 0, 0, 1, 0x65, 1]) },
  { kind: "packet", config: false, key: false, data: Buffer.from([0, 0, 0, 1, 0x41, 2]) },
];

test("createVideoParser：按顺序给出设备名、编码、会话尺寸和三种包（哑字节由它自己吃掉）", () => {
  assert.deepEqual(collect([stream]), expected);
});

test("createVideoParser：任意切成 1 字节一块喂入，结果相同", () => {
  assert.deepEqual(collect([...stream].map((b) => Buffer.from([b]))), expected);
});

test("createVideoParser：中途的会话包（转屏）照样识别", () => {
  const ev = collect([stream, session(1920, 864)]);
  assert.deepEqual(ev.at(-1), { kind: "session", width: 1920, height: 864 });
});

test("serverArgs：版本号是 5.0.1，参数与原型一致", () => {
  const cmd = serverArgs("1a2b3c4d", "/data/local/tmp/droidpier-scrcpy-5.0.1.jar");
  assert.equal(cmd,
    "CLASSPATH=/data/local/tmp/droidpier-scrcpy-5.0.1.jar app_process / com.genymobile.scrcpy.Server 5.0.1 scid=1a2b3c4d " +
    "log_level=info audio=false control=true clipboard_autosync=true tunnel_forward=true video_codec=h264 max_size=1920 stay_awake=true power_on=true cleanup=true");
});

test("randomScid：8 位 16 进制且不超过 0x7fffffff", () => {
  for (let i = 0; i < 50; i++) {
    const s = randomScid();
    assert.match(s, /^[0-9a-f]{8}$/);
    assert.ok(parseInt(s, 16) <= 0x7fffffff);
  }
});

test("RESET_VIDEO 是单字节 17", () => assert.deepEqual([...RESET_VIDEO], [17]));

// 控制消息格式按 scrcpy v5.0.1 服务端 control/ControlMessageReader.java，多字节整数大端
const VIDEO = { width: 864, height: 1920 };

test("injectKeycode：14 字节，GoBack 按下", () => {
  assert.deepEqual([...injectKeycode(0, 4)], [0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("injectText：类型 1 + 长度 + UTF-8", () => {
  assert.deepEqual([...injectText("a")], [1, 0, 0, 0, 1, 0x61]);
});

test("injectTouch：32 字节，pointerId -2，按下压力 0xffff、抬起 0，带视频宽高", () => {
  const down = injectTouch(0, 100, 200, VIDEO);
  assert.equal(down.length, 32);
  assert.equal(down.readUInt8(0), 2);
  assert.equal(down.readUInt8(1), 0);
  assert.equal(down.readBigInt64BE(2), -2n);
  assert.deepEqual([down.readInt32BE(10), down.readInt32BE(14), down.readUInt16BE(18), down.readUInt16BE(20), down.readUInt16BE(22)], [100, 200, 864, 1920, 0xffff]);
  assert.deepEqual([down.readInt32BE(24), down.readInt32BE(28)], [0, 0]);
  const up = injectTouch(1, 100, 200, VIDEO);
  assert.equal(up.readUInt8(1), 1);
  assert.equal(up.readUInt16BE(22), 0);
  assert.equal(injectTouch(2, 1, 1, VIDEO).readUInt16BE(22), 0xffff);
});

test("injectScroll：21 字节，滚动量 /16 后编码，超出夹到 ±16", () => {
  const b = injectScroll(10, 20, VIDEO, 0.5, -1.2);
  assert.equal(b.length, 21);
  assert.equal(b.readUInt8(0), 3);
  assert.deepEqual([b.readInt32BE(1), b.readInt32BE(5), b.readUInt16BE(9), b.readUInt16BE(11)], [10, 20, 864, 1920]);
  assert.equal(b.readInt16BE(13), Math.round((0.5 / 16) * 0x8000));
  assert.equal(b.readInt16BE(15), Math.round((-1.2 / 16) * 0x8000));
  assert.equal(b.readInt32BE(17), 0);
  assert.equal(injectScroll(0, 0, VIDEO, 0, 99).readInt16BE(15), 0x7fff);
  assert.equal(injectScroll(0, 0, VIDEO, 0, -99).readInt16BE(15), -0x8000);
});

test("setClipboard：sequence 0、paste 标志、长度、UTF-8", () => {
  assert.deepEqual([...setClipboard("中", true)], [9, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 3, 0xe4, 0xb8, 0xad]);
  assert.equal(setClipboard("x", false).readUInt8(9), 0);
});

test("setClipboard：超过 262130 字节抛错，正好 262130 不抛", () => {
  assert.equal(CLIPBOARD_MAX_BYTES, 262130);
  assert.throws(() => setClipboard("a".repeat(CLIPBOARD_MAX_BYTES + 1), false), /文字太长/);
  assert.equal(setClipboard("a".repeat(CLIPBOARD_MAX_BYTES), false).length, CLIPBOARD_MAX_BYTES + 14);
});

const deviceClip = (text: string) => {
  const t = Buffer.from(text, "utf8");
  const h = Buffer.alloc(5);
  h.writeUInt32BE(t.length, 1);
  return Buffer.concat([h, t]);
};

test("设备消息：剪贴板文本被切在 UTF-8 字符中间也能完整还原", () => {
  const got: DeviceEvent[] = [];
  const p = createDeviceMessageParser((e) => got.push(e));
  for (const b of deviceClip("复制👍")) p.push(Buffer.from([b]));
  assert.deepEqual(got, [{ kind: "clipboard", text: "复制👍" }]);
});

test("设备消息：ack 和 UHID 输出不影响后面的剪贴板消息", () => {
  const got: DeviceEvent[] = [];
  const p = createDeviceMessageParser((e) => got.push(e));
  const ack = Buffer.alloc(9);
  ack.writeUInt8(1, 0);
  ack.writeBigUInt64BE(7n, 1);
  const uhid = Buffer.from([2, 0, 1, 0, 2, 0xaa, 0xbb]);
  p.push(Buffer.concat([ack, uhid, deviceClip("x")]));
  assert.deepEqual(got, [{ kind: "ack", sequence: 7n }, { kind: "clipboard", text: "x" }]);
});

test("设备消息：未知类型抛错", () => {
  const p = createDeviceMessageParser(() => {});
  assert.throws(() => p.push(Buffer.from([9])), /未知/);
});
