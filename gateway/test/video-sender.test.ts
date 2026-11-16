import { test } from "node:test";
import assert from "node:assert/strict";
import { createVideoSender } from "../src/video-sender.ts";
import { decodeVideoHeader } from "../../shared/protocol.ts";

const pkt = (kind: "config" | "key" | "delta", tag: number) => ({
  config: kind === "config",
  key: kind === "key",
  data: Buffer.from([tag]),
  width: 864,
  height: 1920,
});

function fake(limitBytes?: number) {
  const f = { sent: [] as Buffer[], buffered: 0, keyRequests: 0 };
  const s = createVideoSender({ send: (b) => void f.sent.push(b), buffered: () => f.buffered, requestKey: () => void f.keyRequests++, limitBytes });
  const tags = () => f.sent.map((b) => b[20]);
  return { f, s, tags };
}

test("开始时丢掉 P 帧，直到关键帧；配置包总是发", () => {
  const { s, tags } = fake();
  s.push(pkt("delta", 1));
  s.push(pkt("config", 2));
  s.push(pkt("delta", 3));
  s.push(pkt("key", 4));
  s.push(pkt("delta", 5));
  assert.deepEqual(tags(), [2, 4, 5]);
  assert.equal(s.dropped(), 2);
});

test("积压超过阈值：丢掉这个包，请求一次关键帧，之后只发关键帧起的包", () => {
  const { f, s, tags } = fake(100);
  s.push(pkt("key", 1));
  f.buffered = 200;
  s.push(pkt("delta", 2));
  assert.equal(f.keyRequests, 1);
  f.buffered = 0;
  s.push(pkt("delta", 3));
  assert.equal(f.keyRequests, 1);
  s.push(pkt("key", 4));
  s.push(pkt("delta", 5));
  assert.deepEqual(tags(), [1, 4, 5]);
});

test("默认阈值是 4 MiB", () => {
  const { f, s, tags } = fake();
  s.push(pkt("key", 1));
  f.buffered = 4 * 2 ** 20 - 1;
  s.push(pkt("delta", 2));
  f.buffered = 4 * 2 ** 20 + 1;
  s.push(pkt("delta", 3));
  assert.deepEqual(tags(), [1, 2]);
});

test("reset 之后重新等关键帧，并请求一次关键帧", () => {
  const { f, s, tags } = fake();
  s.push(pkt("key", 1));
  s.reset();
  assert.equal(f.keyRequests, 1);
  s.push(pkt("delta", 2));
  s.push(pkt("key", 3));
  assert.deepEqual(tags(), [1, 3]);
});

test("seq 连续递增，头里带包的宽高和 config / key 标记", () => {
  const { f, s } = fake();
  s.push(pkt("config", 1));
  s.push(pkt("key", 2));
  const h = f.sent.map((b) => decodeVideoHeader(new Uint8Array(b)));
  assert.deepEqual(h, [
    { seq: 0, config: true, key: false, width: 864, height: 1920 },
    { seq: 1, config: false, key: true, width: 864, height: 1920 },
  ]);
  assert.equal(f.sent[1].length, 21);
});

test("积压中请求来的关键帧也被丢了：积压清掉后再请求一次", () => {
  const { f, s, tags } = fake(100);
  s.push(pkt("key", 1));
  f.buffered = 200;
  s.push(pkt("delta", 2));
  assert.equal(f.keyRequests, 1);
  s.push(pkt("key", 3));
  f.buffered = 0;
  s.push(pkt("delta", 4));
  assert.equal(f.keyRequests, 2);
  s.push(pkt("key", 5));
  assert.deepEqual(tags(), [1, 5]);
});
