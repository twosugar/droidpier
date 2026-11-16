import { test } from "node:test";
import assert from "node:assert/strict";
import { browserView, createInspectInput, createInspectorSlot, inspectModeChange, liveValue, pickMapping, toPageCss } from "../src/inspect.ts";

const j = (o: object) => JSON.stringify(o);

test("inspectModeChange：前端发 setInspectMode searchForNode 是开、none 是关，页面发 inspectModeCanceled 是关", () => {
  assert.equal(inspectModeChange(true, j({ id: 7, method: "Overlay.setInspectMode", params: { mode: "searchForNode", highlightConfig: {} } })), true);
  assert.equal(inspectModeChange(true, j({ id: 8, method: "Overlay.setInspectMode", params: { mode: "searchForUAShadowDOM" } })), true);
  assert.equal(inspectModeChange(true, j({ id: 9, method: "Overlay.setInspectMode", params: { mode: "none" } })), false);
  assert.equal(inspectModeChange(false, j({ method: "Overlay.inspectModeCanceled", params: {} })), false);
});

test("inspectModeChange：别的消息、方向不对、坏 JSON 都是 null", () => {
  assert.equal(inspectModeChange(true, j({ id: 1, method: "DOM.getDocument" })), null);
  assert.equal(inspectModeChange(false, j({ method: "Overlay.setInspectMode", params: { mode: "none" } })), null);
  assert.equal(inspectModeChange(false, j({ method: "Overlay.inspectNodeRequested", params: { backendNodeId: 3 } })), null);
  assert.equal(inspectModeChange(true, j({ id: 2, method: "Overlay.setInspectMode", params: { mode: "captureAreaScreenshot" } })), false);
  assert.equal(inspectModeChange(true, "not json"), null);
  assert.equal(inspectModeChange(true, "null"), null);
});

// 1080x2340 的竖屏，WebView 在标题栏下面（实测的 description：screenY 258，1080x2016），dpr 2.75
const DEV = { width: 1080, height: 2340 };
const RECT = { x: 0, y: 258, width: 1080, height: 2016 };

test("toPageCss：竖屏时减去 WebView 的位置再除以 dpr", () => {
  assert.deepEqual(toPageCss({ x: 275, y: 258 + 550 }, DEV, 0, RECT, 2.75), { x: 100, y: 200 });
  assert.deepEqual(toPageCss({ x: 0, y: 258 }, DEV, 0, RECT, 2.75), { x: 0, y: 0 });
});

test("toPageCss：标题栏、导航栏上（WebView 外）返回 null；dpr 不对也返回 null", () => {
  assert.equal(toPageCss({ x: 500, y: 100 }, DEV, 0, RECT, 2.75), null);
  assert.equal(toPageCss({ x: 500, y: 258 + 2016 }, DEV, 0, RECT, 2.75), null);
  assert.equal(toPageCss({ x: 500, y: 500 }, DEV, 0, RECT, 0), null);
});

test("toPageCss：横屏时先把竖屏面板坐标转成人眼看到的屏幕坐标（toDevice 的逆）", () => {
  // 转 90 度后屏幕是 2340x1080；面板 (x, y) 对应屏幕 (2340 - y, x)
  const full = { x: 0, y: 0, width: 2340, height: 1080 };
  assert.deepEqual(toPageCss({ x: 100, y: 2340 - 200 }, DEV, 90, full, 1), { x: 200, y: 100 });
  assert.deepEqual(toPageCss({ x: 1080 - 100, y: 200 }, DEV, 270, full, 1), { x: 200, y: 100 });
  assert.deepEqual(toPageCss({ x: 1080 - 100, y: 2340 - 200 }, DEV, 180, { x: 0, y: 0, width: 1080, height: 2340 }, 1), { x: 100, y: 200 });
});

function rig(map: (p: { x: number; y: number }) => { x: number; y: number } | null = (p) => p) {
  const sent: Array<{ method: string; params: any }> = [];
  const waiters: Array<() => void> = [];
  const input = createInspectInput({
    map,
    send(method, params) {
      sent.push({ method, params });
      return new Promise<void>((r) => waiters.push(r));
    },
  });
  const flush = async () => {
    while (waiters.length) waiters.shift()!();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { input, sent, flush };
}

test("移动发 mouseMoved；上一条没回复时只留最新的一条", async () => {
  const { input, sent, flush } = rig();
  input.pointer({ kind: "move", x: 1, y: 1 });
  input.pointer({ kind: "move", x: 2, y: 2 });
  input.pointer({ kind: "move", x: 3, y: 3 });
  assert.deepEqual(sent.map((s) => [s.params.type, s.params.x]), [["mouseMoved", 1]]);
  await flush();
  assert.deepEqual(sent.map((s) => [s.params.type, s.params.x]), [["mouseMoved", 1], ["mouseMoved", 3]]);
});

test("按下不发，抬起时在按下的位置补一次 mousePressed + mouseReleased", () => {
  const { input, sent } = rig();
  input.pointer({ kind: "down", x: 10, y: 20 });
  assert.equal(sent.length, 0);
  input.pointer({ kind: "up", x: 15, y: 25 });
  assert.deepEqual(sent.map((s) => [s.params.type, s.params.x, s.params.y, s.params.button]), [["mousePressed", 10, 20, "left"], ["mouseReleased", 10, 20, "left"]]);
});

test("WebView 外的移动和点击都不发", () => {
  const { input, sent } = rig(() => null);
  input.pointer({ kind: "move", x: 1, y: 1 });
  input.pointer({ kind: "down", x: 1, y: 1 });
  input.pointer({ kind: "up", x: 1, y: 1 });
  assert.equal(sent.length, 0);
});

test("stop 之后不再发：排着的最新一条移动、之后的移动和点击都丢掉", async () => {
  const { input, sent, flush } = rig();
  input.pointer({ kind: "move", x: 1, y: 1 });
  input.pointer({ kind: "move", x: 2, y: 2 });
  input.stop();
  await flush();
  input.pointer({ kind: "move", x: 3, y: 3 });
  input.pointer({ kind: "down", x: 3, y: 3 });
  input.pointer({ kind: "up", x: 3, y: 3 });
  assert.deepEqual(sent.map((s) => s.params.x), [1]);
});

test("pickMapping：页面给了 screen.orientation.angle 就按它（Android 的逆时针角度换成顺时针）", () => {
  // 物理上转了 90 度但 App 锁竖屏：显示方向还是 0
  assert.deepEqual(pickMapping({ rect: RECT, device: DEV, physical: 90, angle: 0, cssWidth: 392.7 }), { rotation: 0, scale: 1080 / 392.7 });
  // 自动旋转跟着转：顺时针 90 度时 Android 是 ROTATION_270
  const land = { x: 0, y: 0, width: 2340, height: 1080 };
  assert.equal(pickMapping({ rect: land, device: DEV, physical: 90, angle: 270, cssWidth: 851 })?.rotation, 90);
  assert.equal(pickMapping({ rect: land, device: DEV, physical: 270, angle: 90, cssWidth: 851 })?.rotation, 270);
});

test("pickMapping：拿不到角度时按物理方向；WebView 放不进那个方向的屏幕时不映射", () => {
  assert.equal(pickMapping({ rect: RECT, device: DEV, physical: 0, angle: undefined, cssWidth: 392.7 })?.rotation, 0);
  // 物理横过来了，WebView 却是竖屏的位置：方向判断不了，返回 null，页面照常发触摸
  assert.equal(pickMapping({ rect: RECT, device: DEV, physical: 90, angle: undefined, cssWidth: 392.7 }), null);
  assert.equal(pickMapping({ rect: RECT, device: DEV, physical: 0, angle: 0, cssWidth: 0 }), null);
});

/** 记下发给页面的 inspectMode，locate 由测试控制什么时候算完。 */
function slotRig() {
  const modes: Array<[boolean, boolean]> = [];
  const pending: Array<(m: ((p: { x: number; y: number }) => { x: number; y: number } | null) | null) => void> = [];
  const slot = createInspectorSlot({
    notify: (on, mapped) => modes.push([on, mapped]),
    locate: () => new Promise((r) => pending.push(r)),
  });
  const sent: string[] = [];
  const session = { send: (method: string, params: any) => (sent.push(`${method}:${params.type}`), Promise.resolve()) };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { slot, modes, pending, sent, session, tick };
}

test("选择元素模式开了：算好位置后告诉页面 mapped，之后的指针变成鼠标事件；关了告诉页面", async () => {
  const { slot, modes, pending, sent, session, tick } = slotRig();
  const dt = slot.open(session);
  dt.mode(true);
  pending.shift()!((p) => p);
  await tick();
  slot.pointer({ kind: "move", x: 1, y: 1 });
  dt.mode(false);
  slot.pointer({ kind: "move", x: 2, y: 2 });
  assert.deepEqual(modes, [[true, true], [false, false]]);
  assert.deepEqual(sent, ["Input.dispatchMouseEvent:mouseMoved"]);
});

test("新的 DevTools 连上时，上一个还开着选择元素模式：先告诉页面关了", async () => {
  const { slot, modes, pending, session, tick } = slotRig();
  slot.open(session).mode(true);
  pending.shift()!((p) => p);
  await tick();
  slot.open(session);
  assert.deepEqual(modes, [[true, true], [false, false]]);
});

test("DevTools 断开时模式开着：告诉页面关了；旧连接晚到的开关不再理", async () => {
  const { slot, modes, pending, session, tick } = slotRig();
  const a = slot.open(session);
  a.mode(true);
  pending.shift()!(null);
  await tick();
  a.close();
  a.mode(true);
  assert.deepEqual(modes, [[true, false], [false, false]]);
  assert.equal(pending.length, 0);
});

test("转屏后重新算位置：先告诉页面 mapped:false，算好再给 true；算的过程中模式关了就作废", async () => {
  const { slot, modes, pending, session, tick } = slotRig();
  const dt = slot.open(session);
  dt.mode(true);
  pending.shift()!((p) => p);
  await tick();
  slot.relocate();
  assert.deepEqual(modes.at(-1), [true, false]);
  pending.shift()!((p) => p);
  await tick();
  assert.deepEqual(modes.at(-1), [true, true]);
  slot.relocate();
  dt.mode(false);
  pending.shift()!((p) => p);
  await tick();
  assert.deepEqual(modes.slice(-2), [[true, false], [false, false]]);
});

test("liveValue：模式开着时缩放或位置变了，下一次取到的是新值；同一秒内不重复去问", async () => {
  let now = 0;
  let asked = 0;
  let next = 5.4;
  const s = liveValue(2.7, async () => (asked++, next), () => now);
  assert.equal(s.get(), 2.7);
  assert.equal(asked, 0);
  now = 1500;
  assert.equal(s.get(), 2.7); // 这次先用旧值，同时去问
  await new Promise((r) => setImmediate(r));
  assert.equal(asked, 1);
  assert.equal(s.get(), 5.4);
  now = 1800;
  s.get();
  await new Promise((r) => setImmediate(r));
  assert.equal(asked, 1);
});

test("liveValue：问不到或答 null 时保留原来的值", async () => {
  let now = 0;
  const s = liveValue(2.7, async () => { throw new Error("paused"); }, () => now);
  now = 2000;
  s.get();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.get(), 2.7);
  const z = liveValue(2.7, async () => null, () => now);
  now = 4000;
  z.get();
  await new Promise((r) => setImmediate(r));
  assert.equal(z.get(), 2.7);
});

// Chrome 113 实测：内容区 [0,136]-[1080,2274]，地址栏收起时视口 1081x2140，展开时矮 154（56dp × 2.75）
const APP = { x: 0, y: 136, width: 1080, height: 2138 };
const lm = (w: number, h: number, cssW: number) => ({ layoutViewport: { clientWidth: w, clientHeight: h }, cssVisualViewport: { clientWidth: cssW } });

test("browserView：标签页贴着内容区底边，地址栏收起和展开时顶边跟着变", () => {
  assert.deepEqual(browserView(APP, lm(1081, 2138, 393.09)), { rect: { x: 0, y: 136, width: 1080, height: 2138 }, scale: 1080 / 393.09 });
  const shown = browserView(APP, lm(1081, 1984, 393.09))!;
  assert.deepEqual(shown.rect, { x: 0, y: 290, width: 1080, height: 1984 });
  // 地址栏展开时点在屏幕 y=290 + 300*2.75，落在网页 CSS y≈300
  assert.deepEqual(toPageCss({ x: 540, y: 290 + 825 }, DEV, 0, shown.rect, shown.scale), { x: 196.5, y: 300.3 });
});

test("browserView：双指放大后按视觉视口算缩放；量不出来时 null", () => {
  assert.equal(browserView(APP, lm(1081, 2138, 196.5))!.scale, 1080 / 196.5);
  assert.equal(browserView(APP, {}), null);
  assert.equal(browserView(APP, lm(1081, 2138, 0)), null);
  assert.equal(browserView(APP, lm(0, 2138, 393)), null);
});
