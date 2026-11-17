import { test } from "node:test";
import assert from "node:assert/strict";
import { browserView, createInspectInput, createInspectorSlot, highlightBox, inspectModeChange, liveValue, parseWmSize, pickMapping, scaleRect, toPageCss, toPanel } from "../src/inspect.ts";

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

/** 记下发给页面的 inspectMode 和高亮，locate 由测试控制什么时候算完；会话按方法名回固定结果。 */
type TestMapping = { toCss: (p: { x: number; y: number }) => { x: number; y: number } | null; toPanel: (p: { x: number; y: number }) => { x: number; y: number } };
const ID: TestMapping = { toCss: (p) => p, toPanel: (p) => p };
function slotRig() {
  const modes: Array<[boolean, boolean]> = [];
  const boxes: unknown[] = [];
  const pending: Array<(m: TestMapping | null) => void> = [];
  const slot = createInspectorSlot({
    notify: (on, mapped) => modes.push([on, mapped]),
    notifyHighlight: (box) => boxes.push(box),
    locate: () => new Promise((r) => pending.push(r)),
  });
  const sent: string[] = [];
  const replies: Record<string, (params: any) => Promise<any>> = {
    "DOM.getBoxModel": async () => ({ model: MODEL }),
    "DOM.describeNode": async () => ({ node: { localName: "p" } }),
    "DOM.getNodeForLocation": async (p) => ({ backendNodeId: p.x * 100 + p.y }),
  };
  const session = { send: (method: string, params: any) => (sent.push(method === "Input.dispatchMouseEvent" ? `${method}:${params.type}` : `${method}:${JSON.stringify(params)}`), replies[method] ? replies[method](params) : Promise.resolve()) };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { slot, modes, boxes, pending, sent, session, replies, tick };
}

test("选择元素模式开了：算好位置后告诉页面 mapped，之后的指针变成鼠标事件；关了告诉页面", async () => {
  const { slot, modes, pending, sent, session, tick } = slotRig();
  const dt = slot.open(session);
  dt.mode(true);
  pending.shift()!(ID);
  await tick();
  slot.pointer({ kind: "move", x: 1, y: 1 });
  dt.mode(false);
  slot.pointer({ kind: "move", x: 2, y: 2 });
  assert.deepEqual(modes, [[true, true], [false, false]]);
  assert.deepEqual(sent.filter((m) => m.startsWith("Input.")), ["Input.dispatchMouseEvent:mouseMoved"]);
});

test("新的 DevTools 连上时，上一个还开着选择元素模式：先告诉页面关了", async () => {
  const { slot, modes, pending, session, tick } = slotRig();
  slot.open(session).mode(true);
  pending.shift()!(ID);
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
  pending.shift()!(ID);
  await tick();
  slot.relocate();
  assert.deepEqual(modes.at(-1), [true, false]);
  pending.shift()!(ID);
  await tick();
  assert.deepEqual(modes.at(-1), [true, true]);
  slot.relocate();
  dt.mode(false);
  pending.shift()!(ID);
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

test("toPanel：toPageCss 的逆运算，4 个方向往返一致", () => {
  const device = { width: 1080, height: 2400 };
  for (const rotation of [0, 90, 180, 270] as const) {
    const rect = rotation % 180 ? { x: 120, y: 30, width: 2000, height: 1000 } : { x: 0, y: 248, width: 1080, height: 1858 };
    const p = { x: 300, y: 700 };
    const css = toPageCss(p, device, rotation, rect, 3)!;
    assert.ok(css, `rotation ${rotation}`);
    const back = toPanel(css, device, rotation, rect, 3);
    assert.ok(Math.abs(back.x - p.x) <= 1 && Math.abs(back.y - p.y) <= 1, `rotation ${rotation}: ${JSON.stringify(back)}`);
  }
});

const MODEL = {
  margin: [0, 0, 100, 0, 100, 60, 0, 60],
  border: [0, 10, 100, 10, 100, 50, 0, 50],
  padding: [2, 12, 98, 12, 98, 48, 2, 48],
  content: [4, 14, 96, 14, 96, 46, 4, 46],
  width: 100,
  height: 40.4,
};
const twice = (p: { x: number; y: number }) => ({ x: p.x * 2, y: p.y * 2 });

test("highlightBox：四层从外到内都发（页面要按里面一层挖空），坐标换到面板，颜色用 highlightConfig，没给的层透明", () => {
  const box = highlightBox(MODEL, { localName: "p" }, { showInfo: true, contentColor: { r: 1, g: 2, b: 3, a: 0.5 }, marginColor: { r: 4, g: 5, b: 6 } }, twice);
  assert.deepEqual(box.quads.map((q) => q.color), ["rgba(4,5,6,1)", "rgba(0,0,0,0)", "rgba(0,0,0,0)", "rgba(1,2,3,0.5)"]);
  assert.deepEqual(box.quads[0].points, [0, 0, 200, 0, 200, 120, 0, 120]);
  assert.deepEqual(box.quads[3].points, [8, 28, 192, 28, 192, 92, 8, 92]);
  assert.equal(box.label, "p");
  assert.equal(box.size, "100 × 40");
});

test("highlightBox：没给任何颜色时用 Chrome 默认四色；标注带 id 和 class；showInfo false 不要标注", () => {
  const box = highlightBox(MODEL, { localName: "div", attributes: ["id", "a", "class", "x  y", "style", "c"] }, undefined, twice);
  assert.deepEqual(box.quads.map((q) => q.color), ["rgba(246,178,107,0.66)", "rgba(255,229,153,0.66)", "rgba(147,196,125,0.55)", "rgba(111,168,220,0.66)"]);
  assert.equal(box.label, "div#a.x.y");
  assert.equal(highlightBox(MODEL, { nodeName: "SPAN" }, { showInfo: false, contentColor: { r: 0, g: 0, b: 0, a: 1 } }, twice).label, null);
  assert.equal(highlightBox(MODEL, { localName: "a".repeat(80) }, undefined, twice).label!.length, 60);
});

test("高亮：取盒模型和节点名，换成面板坐标发给页面；hideHighlight 时清掉", async () => {
  const { slot, boxes, pending, sent, session, tick } = slotRig();
  const dt = slot.open(session);
  dt.highlight({ nodeId: 5, config: { showInfo: true } });
  pending.shift()!(ID);
  await tick(); await tick();
  assert.ok(sent.includes('DOM.getBoxModel:{"nodeId":5}'));
  assert.ok(sent.includes('DOM.describeNode:{"nodeId":5}'));
  assert.equal(boxes.length, 1);
  assert.equal((boxes[0] as any).label, "p");
  assert.deepEqual((boxes[0] as any).quads[3].points, MODEL.content);
  dt.highlight(null);
  assert.deepEqual(boxes, [boxes[0], null]);
});

test("高亮：上一次还没取回时连发几次，只处理最新的；中途 hideHighlight 的话晚到的结果不再画", async () => {
  const { slot, boxes, pending, sent, session, replies, tick } = slotRig();
  const dt = slot.open(session);
  const gates: Array<() => void> = [];
  replies["DOM.getBoxModel"] = () => new Promise((r) => gates.push(() => r({ model: MODEL })));
  dt.highlight({ nodeId: 1 });
  pending.shift()!(ID);
  await tick();
  dt.highlight({ nodeId: 2 });
  dt.highlight({ nodeId: 3 });
  gates.shift()!();
  await tick(); await tick();
  gates.shift()!();
  await tick(); await tick();
  assert.deepEqual(sent.filter((m) => m.startsWith("DOM.getBoxModel")), ['DOM.getBoxModel:{"nodeId":1}', 'DOM.getBoxModel:{"nodeId":3}']);
  assert.equal(boxes.length, 2);
  dt.highlight({ nodeId: 4 });
  await tick();
  dt.highlight(null);
  gates.shift()!();
  await tick(); await tick();
  assert.deepEqual(boxes.at(-1), null);
  assert.equal(boxes.length, 3);
});

test("高亮：取不到盒模型或位置算不出时清掉，不报错", async () => {
  const { slot, boxes, pending, session, replies, tick } = slotRig();
  const dt = slot.open(session);
  dt.highlight({ nodeId: 1 });
  pending.shift()!(ID);
  await tick(); await tick();
  assert.equal(boxes.length, 1);
  replies["DOM.getBoxModel"] = () => Promise.reject(new Error("Could not compute box model."));
  dt.highlight({ nodeId: 2 });
  await tick(); await tick();
  assert.deepEqual(boxes, [boxes[0], null]);
  dt.highlight({ nodeId: 3 });
  await tick(); await tick();
  assert.equal(boxes.length, 2, "没画着时不重复发 null");
  const { slot: s2, boxes: b2, pending: p2, session: ss2, tick: t2 } = slotRig();
  s2.open(ss2).highlight({ nodeId: 1 });
  p2.shift()!(null);
  await t2(); await t2();
  assert.deepEqual(b2, []);
});

test("高亮：DevTools 关掉、转屏、新 DevTools 连上时清掉已画的；位置只算一次，转屏后重算", async () => {
  const { slot, boxes, pending, session, tick } = slotRig();
  const dt = slot.open(session);
  dt.highlight({ nodeId: 1 });
  pending.shift()!(ID);
  await tick(); await tick();
  dt.highlight({ nodeId: 2 });
  await tick(); await tick();
  assert.equal(pending.length, 0);
  assert.equal(boxes.length, 2);
  slot.relocate();
  assert.deepEqual(boxes.at(-1), null);
  dt.highlight({ nodeId: 3 });
  await tick();
  assert.equal(pending.length, 1);
  pending.shift()!(ID);
  await tick(); await tick();
  dt.close();
  assert.deepEqual(boxes.at(-1), null);
});

test("选择元素模式：鼠标移动后取鼠标下的节点并高亮；模式关掉时清掉", async () => {
  const { slot, boxes, pending, sent, session, tick } = slotRig();
  const dt = slot.open(session);
  dt.mode(true);
  pending.shift()!(ID);
  await tick();
  slot.pointer({ kind: "move", x: 3, y: 4 });
  await tick(); await tick(); await tick();
  assert.ok(sent.includes('DOM.getNodeForLocation:{"x":3,"y":4,"ignorePointerEventsNone":true}'));
  assert.ok(sent.includes('DOM.getBoxModel:{"backendNodeId":304}'));
  assert.equal(boxes.length, 1);
  dt.mode(false);
  assert.deepEqual(boxes.at(-1), null);
});

test("parseWmSize：有 Override size 时用它，否则用 Physical size；读不出时 null", () => {
  assert.deepEqual(parseWmSize("Physical size: 1080x2400\n"), { width: 1080, height: 2400 });
  assert.deepEqual(parseWmSize("Physical size: 1440x3200\r\nOverride size: 1080x2400\r\n"), { width: 1080, height: 2400 });
  assert.equal(parseWmSize("error: no devices"), null);
});

test("scaleRect：真机的 WebView 位置是屏幕像素，视频按比例缩小过，位置要跟着缩到视频像素；尺寸相同时不变", () => {
  // 1080x2400 的屏幕，scrcpy 视频长边 1920 → 864x1920，比例 0.8（2026-11-17 三星 SM-G9910 实测 /json：screenY 248，1080x1858）
  assert.deepEqual(scaleRect({ x: 0, y: 248, width: 1080, height: 1858 }, { width: 864, height: 1920 }, { width: 1080, height: 2400 }), { x: 0, y: 198.4, width: 864, height: 1486.4 });
  const r = { x: 0, y: 258, width: 1080, height: 2016 };
  assert.deepEqual(scaleRect(r, { width: 1080, height: 2340 }, { width: 1080, height: 2340 }), r);
  assert.deepEqual(scaleRect(r, { width: 1080, height: 2340 }, null), r);
  // 横屏时 wm size 仍给自然方向（竖屏）的宽高，按短边算比例
  assert.deepEqual(scaleRect({ x: 248, y: 0, width: 1858, height: 1080 }, { width: 864, height: 1920 }, { width: 2400, height: 1080 }), { x: 198.4, y: 0, width: 1486.4, height: 864 });
});

test("scaleRect 之后 pickMapping 能放进视频尺寸的屏幕（没缩放时放不进，返回 null）", () => {
  const rect = { x: 0, y: 248, width: 1080, height: 1858 };
  const device = { width: 864, height: 1920 };
  assert.equal(pickMapping({ rect, device, physical: 0, angle: 0, cssWidth: 360 }), null);
  const scaled = scaleRect(rect, device, { width: 1080, height: 2400 });
  assert.deepEqual(pickMapping({ rect: scaled, device, physical: 0, angle: 0, cssWidth: 360 }), { rotation: 0, scale: 2.4 });
});

test("高亮：第一次算不出位置不缓存，下一次划过时重新算并画出来", async () => {
  const { slot, boxes, pending, session, tick } = slotRig();
  const dt = slot.open(session);
  dt.highlight({ nodeId: 1 });
  pending.shift()!(null);
  await tick(); await tick();
  assert.deepEqual(boxes, []);
  dt.highlight({ nodeId: 2 });
  await tick();
  assert.equal(pending.length, 1, "没有缓存 null，重新去算");
  pending.shift()!(ID);
  await tick(); await tick();
  assert.equal(boxes.length, 1);
});

test("高亮：鼠标离开元素树（hideHighlight）后丢掉位置，下一轮划过重新算，WebView 挪了位置也画在新位置", async () => {
  const { slot, boxes, pending, session, tick } = slotRig();
  const dt = slot.open(session);
  dt.highlight({ nodeId: 1 });
  pending.shift()!(ID);
  await tick(); await tick();
  dt.highlight({ nodeId: 2 });
  await tick(); await tick();
  assert.equal(pending.length, 0, "同一轮划过只算一次");
  dt.highlight(null);
  dt.highlight({ nodeId: 3 });
  await tick();
  assert.equal(pending.length, 1);
  pending.shift()!({ toCss: (p) => p, toPanel: (p) => ({ x: p.x + 1000, y: p.y }) });
  await tick(); await tick();
  assert.equal((boxes.at(-1) as any).quads[0].points[0], 1000);
});
