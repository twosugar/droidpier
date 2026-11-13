import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupAll, exitHandler } from "../src/exit.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("清理完成后以 0 退出", async () => {
  const codes: number[] = [];
  const onSignal = exitHandler({ cleanup: async () => {}, exit: (c) => void codes.push(c), timeoutMs: 1000, log: () => {} });
  await onSignal();
  assert.deepEqual(codes, [0]);
});

test("清理卡住：到时限直接退出", async () => {
  const codes: number[] = [];
  const onSignal = exitHandler({ cleanup: () => new Promise(() => {}), exit: (c) => void codes.push(c), timeoutMs: 50, log: () => {} });
  const t0 = Date.now();
  await onSignal();
  assert.deepEqual(codes, [0]);
  assert.ok(Date.now() - t0 < 500);
});

test("清理抛错也退出", async () => {
  const codes: number[] = [];
  const onSignal = exitHandler({ cleanup: async () => { throw new Error("adb gone"); }, exit: (c) => void codes.push(c), timeoutMs: 1000, log: () => {} });
  await onSignal();
  assert.deepEqual(codes, [0]);
});

test("清理途中再收到信号：立即退出", async () => {
  const codes: number[] = [];
  const onSignal = exitHandler({ cleanup: () => sleep(200), exit: (c) => void codes.push(c), timeoutMs: 20_000, log: () => {} });
  void onSignal();
  await sleep(10);
  await onSignal();
  assert.deepEqual(codes, [1]);
});

test("cleanupAll：自动更新卡在不能中止的步骤时，照样马上停安装、关服务", async () => {
  const calls: string[] = [];
  const done = cleanupAll({
    stopUpdater: () => new Promise(() => {}),
    stopInstaller: () => void calls.push("installer"),
    closeServer: async () => void calls.push("server"),
  });
  await sleep(10);
  assert.deepEqual(calls, ["installer", "server"]);
  void done;
});

test("cleanupAll：等自动更新和关服务都结束才返回", async () => {
  let release: () => void = () => {};
  let finished = false;
  const done = cleanupAll({ stopUpdater: () => new Promise<void>((r) => (release = r)), stopInstaller: () => {}, closeServer: async () => {} }).then(() => (finished = true));
  await sleep(10);
  assert.equal(finished, false);
  release();
  await done;
  assert.equal(finished, true);
});

test("cleanupAll：自动更新出错时，照样等关服务结束再返回，不往外抛", async () => {
  let release: () => void = () => {};
  let finished = false;
  const done = cleanupAll({
    stopUpdater: () => Promise.reject(new Error("boom")),
    stopInstaller: () => {},
    closeServer: () => new Promise<void>((r) => (release = r)),
  }).then(() => (finished = true));
  await sleep(10);
  assert.equal(finished, false);
  release();
  await done;
  assert.equal(finished, true);
});
