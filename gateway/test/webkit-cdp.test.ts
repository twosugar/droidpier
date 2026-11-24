import { test } from "node:test";
import assert from "node:assert/strict";
import { webkitCdp } from "../src/webkit-cdp.ts";
import type { InspectorChannel } from "../src/ios-inspector.ts";

function fakeChannel() {
  const f = {
    sent: [] as any[],
    closed: 0,
    msgCb: null as ((m: string) => void) | null,
    closeCbs: [] as Array<() => void>,
    push: (m: object) => f.msgCb?.(JSON.stringify(m)),
    ch: null as unknown as InspectorChannel,
    /** 发给页面目标的最后一条命令（里层）。 */
    lastInner: () => {
      const o = f.sent.at(-1);
      return { targetId: o.params.targetId, ...JSON.parse(o.params.message) };
    },
    answer: (targetId: string, inner: object) => f.push({ method: "Target.dispatchMessageFromTarget", params: { targetId, message: JSON.stringify(inner) } }),
  };
  f.ch = {
    send: (m) => void f.sent.push(JSON.parse(m)),
    onMessage: (cb) => void (f.msgCb = cb),
    onClose: (cb) => void f.closeCbs.push(cb),
    close: () => void f.closed++,
  };
  return f;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const created = (targetId: string, isProvisional = false) => ({ method: "Target.targetCreated", params: { targetInfo: { targetId, type: "page", isProvisional } } });

test("命令等到页面目标出现再发，包进 Target.sendMessageToTarget；回话按编号交回，error 变成异常", async () => {
  const f = fakeChannel();
  const cdp = webkitCdp(f.ch);
  const p = cdp.send("Runtime.evaluate", { expression: "1+1" });
  await tick();
  assert.equal(f.sent.length, 0);
  f.push(created("page-1"));
  await tick();
  const sent = f.lastInner();
  assert.equal(sent.targetId, "page-1");
  assert.equal(sent.method, "Runtime.evaluate");
  assert.deepEqual(sent.params, { expression: "1+1" });
  f.answer("page-1", { id: sent.id, result: { result: { value: 2 } } });
  assert.deepEqual(await p, { result: { value: 2 } });
  const q = cdp.send("DOM.nope");
  await tick();
  f.answer("page-1", { id: f.lastInner().id, error: { message: "'DOM.nope' was not found" } });
  await assert.rejects(q, /DOM\.nope/);
});

test("事件交给 on 的监听；换页后命令发给新目标，之前开过的 enable 对新目标再发一遍", async () => {
  const f = fakeChannel();
  const cdp = webkitCdp(f.ch);
  const got: unknown[] = [];
  cdp.on("Console.messageAdded", (p) => got.push(p.message.text));
  f.push(created("page-1"));
  const en = cdp.send("Console.enable");
  await tick();
  f.answer("page-1", { id: f.lastInner().id, result: {} });
  await en;
  f.answer("page-1", { method: "Console.messageAdded", params: { message: { text: "a" } } });
  f.push(created("page-2", true));
  f.push({ method: "Target.didCommitProvisionalTarget", params: { oldTargetId: "page-1", newTargetId: "page-2" } });
  await tick();
  assert.deepEqual({ t: f.lastInner().targetId, m: f.lastInner().method }, { t: "page-2", m: "Console.enable" });
  f.answer("page-2", { method: "Console.messageAdded", params: { message: { text: "b" } } });
  assert.deepEqual(got, ["a", "b"]);
});

test("等不到回话按超时失败；通道关了未完成的命令失败、closed 完成", async () => {
  const f = fakeChannel();
  const cdp = webkitCdp(f.ch, 30);
  await assert.rejects(cdp.send("Runtime.evaluate"), /超时/);
  f.push(created("page-1"));
  const p = cdp.send("Runtime.evaluate");
  await tick();
  f.closeCbs.forEach((cb) => cb());
  await assert.rejects(p, /断开/);
  await cdp.closed;
  cdp.close();
  assert.equal(f.closed, 1);
});
