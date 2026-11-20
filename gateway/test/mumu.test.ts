import { test } from "node:test";
import assert from "node:assert/strict";
import { createMumuConnector, MUMU_ADB_PORTS } from "../src/mumu.ts";

function harness(o: { open?: number[]; connected?: string[]; connect?: (addr: string) => Promise<string> } = {}) {
  const h = { connects: [] as string[], logs: [] as string[], open: o.open ?? [], connected: o.connected ?? [] };
  const c = createMumuConnector({
    probe: async (port) => h.open.includes(port),
    connect: async (addr) => {
      h.connects.push(addr);
      return o.connect ? o.connect(addr) : `connected to ${addr}`;
    },
    connected: () => h.connected,
    log: (s) => h.logs.push(s),
  });
  return { h, c };
}

test("MuMu 的 adb 端口开着、adb 里还没有这台：替它 adb connect", async () => {
  const { h, c } = harness({ open: [16384] });
  await c.tick();
  assert.deepEqual(h.connects, ["127.0.0.1:16384"]);
  assert.ok(MUMU_ADB_PORTS.includes(16384));
});

test("已经连上的不再 connect", async () => {
  const { h, c } = harness({ open: [16384], connected: ["127.0.0.1:16384"] });
  await c.tick();
  assert.deepEqual(h.connects, []);
});

test("端口没开（MuMu 没开机）就什么都不做", async () => {
  const { h, c } = harness();
  await c.tick();
  assert.deepEqual(h.connects, []);
  assert.deepEqual(h.logs, []);
});

test("连上时记一条日志；连不上时同样的错误只记一次，下次连上后再失败照样记", async () => {
  let fail = true;
  const { h, c } = harness({ open: [16384], connect: async (addr) => (fail ? `failed to connect to ${addr}` : `connected to ${addr}`) });
  await c.tick();
  await c.tick();
  assert.equal(h.connects.length, 2);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /连不上 MuMu/);
  fail = false;
  await c.tick();
  assert.match(h.logs.at(-1)!, /已连上 MuMu/);
  fail = true;
  await c.tick();
  assert.match(h.logs.at(-1)!, /连不上 MuMu/);
});

test("adb connect 本身报错（超时等）也只记一次，不抛出", async () => {
  const { h, c } = harness({ open: [16384], connect: async () => { throw new Error("timeout"); } });
  await c.tick();
  await c.tick();
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /timeout/);
});

test("start 调两次也只跑一条循环：同一时刻只 connect 一次", async () => {
  const { h, c } = harness({ open: [16384] });
  c.start();
  c.start();
  await new Promise((r) => setTimeout(r, 20));
  c.stop();
  assert.equal(h.connects.length, 1);
});
