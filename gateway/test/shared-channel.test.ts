import { test } from "node:test";
import assert from "node:assert/strict";
import { createSharedChannel } from "../src/shared-channel.ts";
import type { InspectorChannel } from "../src/ios-inspector.ts";

/** 假的底层通道：记下发出去的消息，push 模拟页面发来的消息。 */
function fakeUnderlying() {
  const f = {
    opened: 0,
    closed: 0,
    sent: [] as any[],
    msgCb: null as ((m: string) => void) | null,
    closeCbs: [] as Array<() => void>,
    push: (m: object) => f.msgCb?.(JSON.stringify(m)),
    die: () => f.closeCbs.forEach((cb) => cb()),
    open: async (): Promise<InspectorChannel> => {
      f.opened++;
      return {
        send: (m) => void f.sent.push(JSON.parse(m)),
        onMessage: (cb) => void (f.msgCb = cb),
        onClose: (cb) => void f.closeCbs.push(cb),
        close: () => void f.closed++,
      };
    },
  };
  return f;
}
const inbox = (ch: InspectorChannel) => {
  const got: any[] = [];
  ch.onMessage((m) => got.push(JSON.parse(m)));
  return got;
};
const wrap = (id: number, targetId: string, inner: object) => ({ id, method: "Target.sendMessageToTarget", params: { targetId, message: JSON.stringify(inner) } });
const fromTarget = (targetId: string, inner: object) => ({ method: "Target.dispatchMessageFromTarget", params: { targetId, message: JSON.stringify(inner) } });
const created = (targetId: string, isProvisional = false) => ({ method: "Target.targetCreated", params: { targetInfo: { targetId, type: "page", isProvisional } } });

test("两个使用方共用一条底层通道：编号改写后发出，回复只回给发请求的那一方、编号还原", async () => {
  const u = fakeUnderlying();
  const shared = createSharedChannel(u.open);
  const a = await shared.attach();
  const b = await shared.attach();
  assert.equal(u.opened, 1);
  const ga = inbox(a);
  const gb = inbox(b);
  a.send(JSON.stringify(wrap(1, "t1", { id: 1, method: "Runtime.evaluate" })));
  b.send(JSON.stringify(wrap(1, "t1", { id: 1, method: "Runtime.evaluate" })));
  const [sa, sb] = u.sent;
  assert.notEqual(sa.id, sb.id);
  const ia = JSON.parse(sa.params.message).id;
  const ib = JSON.parse(sb.params.message).id;
  assert.notEqual(ia, ib);
  u.push({ id: sb.id, result: {} });
  u.push(fromTarget("t1", { id: ib, result: { value: "b" } }));
  u.push(fromTarget("t1", { id: ia, result: { value: "a" } }));
  assert.deepEqual(gb, [{ id: 1, result: {} }, fromTarget("t1", { id: 1, result: { value: "b" } })]);
  assert.deepEqual(ga, [fromTarget("t1", { id: 1, result: { value: "a" } })]);
});

test("事件发给所有使用方；后连上的使用方先补收还在的页面目标（换页时提交的目标顶替旧的）", async () => {
  const u = fakeUnderlying();
  const shared = createSharedChannel(u.open);
  const a = await shared.attach();
  const ga = inbox(a);
  u.push(created("t1"));
  u.push(created("t2", true));
  u.push({ method: "Target.didCommitProvisionalTarget", params: { oldTargetId: "t1", newTargetId: "t2" } });
  u.push(fromTarget("t2", { method: "Console.messageAdded", params: { message: { text: "hi" } } }));
  assert.equal(ga.length, 4);
  const b = await shared.attach();
  const gb = inbox(b);
  assert.deepEqual(gb, [{ method: "Target.targetCreated", params: { targetInfo: { targetId: "t2", type: "page", isProvisional: false } } }]);
  u.push({ method: "Target.targetDestroyed", params: { targetId: "t2" } });
  assert.equal(ga.length, 5);
  assert.equal(gb.length, 2);
  const c = await shared.attach();
  assert.deepEqual(inbox(c), []);
});

test("使用方都关了才关底层通道；底层断了每个使用方都收到关闭，下次 attach 重新打开", async () => {
  const u = fakeUnderlying();
  const shared = createSharedChannel(u.open);
  const a = await shared.attach();
  const b = await shared.attach();
  a.close();
  assert.equal(u.closed, 0);
  b.close();
  assert.equal(u.closed, 1);
  const c = await shared.attach();
  let closed = 0;
  c.onClose(() => closed++);
  assert.equal(u.opened, 2);
  u.die();
  assert.equal(closed, 1);
  await shared.attach();
  assert.equal(u.opened, 3);
});

test("同时 attach 排队、只打开一次底层通道；打开失败的那个失败，排在后面的重新打开", async () => {
  const u = fakeUnderlying();
  let fails = 1;
  const shared = createSharedChannel(async () => {
    if (fails-- > 0) throw new Error("页面正被别人调试");
    return u.open();
  });
  const results = await Promise.allSettled([shared.attach(), shared.attach()]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "fulfilled"]);
  const [x, y] = await Promise.all([shared.attach(), shared.attach()]);
  assert.ok(x && y);
  assert.equal(u.opened, 1);
});

test("调试界面加入时别的使用方还在：底层通道重开，调试界面拿到干净的初始状态；别的使用方先收到重置，再收到新通道的目标", async () => {
  const u = fakeUnderlying();
  const shared = createSharedChannel(u.open);
  const tool = await shared.attach();
  const got = inbox(tool);
  u.push(created("t1"));
  tool.send(JSON.stringify(wrap(1, "t1", { id: 1, method: "Runtime.evaluate" })));
  const fe = await shared.attach("frontend");
  assert.equal(u.opened, 2);
  assert.equal(u.closed, 1);
  const feGot = inbox(fe);
  assert.deepEqual(feGot, []);
  assert.deepEqual(got.map((m) => m.method), ["Target.targetCreated", "Droidpier.channelReset"]);
  // 旧通道上没回的请求作废：回话就算来了也不送
  u.push(created("t2"));
  assert.deepEqual(got.map((m) => m.method), ["Target.targetCreated", "Droidpier.channelReset", "Target.targetCreated"]);
  assert.deepEqual(feGot.map((m) => m.method), ["Target.targetCreated"]);
});

test("调试界面离开时别的使用方还在：底层通道重开，清掉调试界面留下的状态（启动时暂停、断点）；最后一方离开照旧直接关", async () => {
  const u = fakeUnderlying();
  const shared = createSharedChannel(u.open);
  const fe = await shared.attach("frontend");
  const tool = await shared.attach();
  const got = inbox(tool);
  assert.equal(u.opened, 1);
  fe.close();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(u.opened, 2);
  assert.equal(u.closed, 1);
  assert.deepEqual(got.map((m) => m.method), ["Droidpier.channelReset"]);
  tool.close();
  assert.equal(u.closed, 2);
  assert.equal(u.opened, 2);
});

test("底层通道断了：每一方等着的回话也清掉，之后同编号的回话不会送错", async () => {
  const u = fakeUnderlying();
  const shared = createSharedChannel(u.open);
  const a = await shared.attach();
  a.send(JSON.stringify({ id: 9, method: "Target.setPauseOnStart" }));
  const outerId = u.sent[0].id;
  u.die();
  const b = await shared.attach();
  const got = inbox(b);
  u.push({ id: outerId, result: {} });
  assert.deepEqual(got, []);
});
