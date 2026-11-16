import { test } from "node:test";
import assert from "node:assert/strict";
import { codecFromSps, createVideoPipe } from "../../host/src/video.ts";
import type { VideoHeader } from "../protocol.ts";

// 原型在 SM-G9910 上解出来的 codec 是 avc1.64002a：SPS 的 profile 0x64、constraint 0x00、level 0x2a
const SPS = new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a, 0xac, 0, 0, 0, 1, 0x68, 0xee]);
const SPS_LANDSCAPE = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f, 0, 0, 0, 1, 0x68, 0xce]);

test("codecFromSps：从原型抓到的 SPS 得到 avc1.64002a", () => {
  assert.equal(codecFromSps(SPS), "avc1.64002a");
});

test("codecFromSps：找不到 SPS 时用 avc1.42001f", () => {
  assert.equal(codecFromSps(new Uint8Array([0, 0, 0, 1, 0x65, 1])), "avc1.42001f");
});

const h = (seq: number, kind: "config" | "key" | "delta"): VideoHeader => ({ seq, config: kind === "config", key: kind === "key", width: 864, height: 1920 });

function fakeDecoders(queue = 0) {
  const made: Array<{ codec: string; decoded: Array<[boolean, number[]]>; closed: boolean }> = [];
  const pipe = createVideoPipe({
    makeDecoder(codec) {
      const d = { codec, decoded: [] as Array<[boolean, number[]]>, closed: false };
      made.push(d);
      return { decode: (key, data) => void d.decoded.push([key, [...data]]), close: () => void (d.closed = true), queueSize: () => queue };
    },
  });
  return { pipe, made };
}

test("createVideoPipe：配置包新建解码器，关键帧前拼上 SPS/PPS", () => {
  const { pipe, made } = fakeDecoders();
  pipe.push(h(0, "config"), SPS);
  pipe.push(h(1, "key"), new Uint8Array([0, 0, 0, 1, 0x65]));
  pipe.push(h(2, "delta"), new Uint8Array([0, 0, 0, 1, 0x41]));
  assert.equal(made.length, 1);
  assert.equal(made[0].codec, "avc1.64002a");
  assert.deepEqual(made[0].decoded, [[true, [...SPS, 0, 0, 0, 1, 0x65]], [false, [0, 0, 0, 1, 0x41]]]);
});

test("createVideoPipe：没等到关键帧时丢 P 帧", () => {
  const { pipe, made } = fakeDecoders();
  pipe.push(h(0, "delta"), new Uint8Array([9]));
  pipe.push(h(1, "config"), SPS);
  pipe.push(h(2, "delta"), new Uint8Array([9]));
  assert.deepEqual(made[0].decoded, []);
});

test("createVideoPipe：解码队列超过 8 时丢 P 帧，不丢关键帧", () => {
  const { pipe, made } = fakeDecoders(9);
  pipe.push(h(0, "config"), SPS);
  pipe.push(h(1, "key"), new Uint8Array([0x65]));
  pipe.push(h(2, "delta"), new Uint8Array([0x41]));
  assert.deepEqual(made[0].decoded.map((d) => d[0]), [true]);
});

test("createVideoPipe：新的配置包（转屏）关掉旧解码器、按新 codec 重建，并重新等关键帧", () => {
  const { pipe, made } = fakeDecoders();
  pipe.push(h(0, "config"), SPS);
  pipe.push(h(1, "key"), new Uint8Array([0x65]));
  pipe.push(h(2, "config"), SPS_LANDSCAPE);
  pipe.push(h(3, "delta"), new Uint8Array([0x41]));
  assert.equal(made.length, 2);
  assert.equal(made[0].closed, true);
  assert.equal(made[1].codec, "avc1.42001f");
  assert.deepEqual(made[1].decoded, []);
});

test("createVideoPipe：close 关掉解码器", () => {
  const { pipe, made } = fakeDecoders();
  pipe.push(h(0, "config"), SPS);
  pipe.close();
  assert.equal(made[0].closed, true);
});

test("createVideoPipe：队列超限丢过 P 帧后，队列回落也要等到关键帧才继续（否则花屏）", () => {
  let queue = 0;
  const made: Array<Array<[boolean, number[]]>> = [];
  const pipe = createVideoPipe({
    makeDecoder() {
      const d: Array<[boolean, number[]]> = [];
      made.push(d);
      return { decode: (key, data) => void d.push([key, [...data]]), close: () => {}, queueSize: () => queue };
    },
  });
  pipe.push(h(0, "config"), SPS);
  pipe.push(h(1, "key"), new Uint8Array([0x65]));
  queue = 9;
  pipe.push(h(2, "delta"), new Uint8Array([0x41]));
  queue = 0;
  pipe.push(h(3, "delta"), new Uint8Array([0x42]));
  pipe.push(h(4, "key"), new Uint8Array([0x66]));
  assert.deepEqual(made[0].map((x) => x[0]), [true, true]);
});

test("createVideoPipe：解码器出错后丢掉它、请求重来；新配置包到之前不再喂包", () => {
  const errs: Array<() => void> = [];
  const made: Array<{ decoded: number; closed: boolean }> = [];
  let restarts = 0;
  const pipe = createVideoPipe({
    makeDecoder(_codec, onError) {
      const d = { decoded: 0, closed: false };
      made.push(d);
      errs.push(onError);
      return { decode: () => void d.decoded++, close: () => void (d.closed = true), queueSize: () => 0 };
    },
    requestRestart: () => void restarts++,
  });
  pipe.push(h(0, "config"), SPS);
  pipe.push(h(1, "key"), new Uint8Array([0x65]));
  errs[0]();
  assert.equal(restarts, 1);
  assert.equal(made[0].closed, true);
  pipe.push(h(2, "key"), new Uint8Array([0x65]));
  assert.equal(made[0].decoded, 1);
  pipe.push(h(3, "config"), SPS);
  pipe.push(h(4, "key"), new Uint8Array([0x65]));
  assert.equal(made.length, 2);
  assert.equal(made[1].decoded, 1);
});
