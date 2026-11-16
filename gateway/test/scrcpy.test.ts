import { test } from "node:test";
import assert from "node:assert/strict";
import { createVideoParser, randomScid, RESET_VIDEO, serverArgs, type VideoEvent } from "../src/scrcpy.ts";

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
    "log_level=info audio=false control=true tunnel_forward=true video_codec=h264 max_size=1920 stay_awake=true power_on=true cleanup=true");
});

test("randomScid：8 位 16 进制且不超过 0x7fffffff", () => {
  for (let i = 0; i < 50; i++) {
    const s = randomScid();
    assert.match(s, /^[0-9a-f]{8}$/);
    assert.ok(parseInt(s, 16) <= 0x7fffffff);
  }
});

test("RESET_VIDEO 是单字节 17", () => assert.deepEqual([...RESET_VIDEO], [17]));
