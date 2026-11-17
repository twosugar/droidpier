import { test } from "node:test";
import assert from "node:assert/strict";
import { createTools, formatLogLines, shotToDevice, swipeSteps, type ToolDeps } from "../../host/src/webmcp.ts";
import type { ClientMsg, DeviceCaps, PhoneInfo, Rotation } from "../protocol.ts";
import type { LogFilter, LogLine } from "../logcat.ts";

const DEVICE = { width: 1080, height: 2400 };

const ALL_CAPS: DeviceCaps = { rotate: true, reboot: true, stop: true, clipboard: true, input: true, scroll: false };
const PHONE_CAPS: DeviceCaps = { rotate: false, reboot: false, stop: false, clipboard: true, input: true, scroll: true };
const LINE: LogLine = { n: 1, time: "11-16 18:00:52.531", pid: 100, tid: 101, level: "E", tag: "App", msg: "boom" };

function harness(o: {
  connected?: boolean; rotation?: Rotation; shot?: { width: number; height: number }; allow?: boolean;
  phones?: PhoneInfo[] | null; current?: { kind: "emulator" | "phone"; deviceId: string } | null; caps?: DeviceCaps | null;
  logcatSupported?: boolean; readLogcat?: (f: LogFilter, limit: number) => Promise<{ lines: LogLine[]; error?: string }>;
} = {}) {
  const h = { sent: [] as ClientMsg[], controls: [] as ClientMsg[], asked: [] as string[], rotation: o.rotation ?? 0 as Rotation, reads: [] as unknown[] };
  const shot = o.shot ?? { width: 540, height: 1200 };
  const deps: ToolDeps = {
    connected: () => o.connected ?? true,
    device: () => DEVICE,
    rotation: () => h.rotation,
    snapshot: async () => ({ ...shot, jpeg: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }) }),
    send: (m) => (h.sent.push(m), true),
    control: (m) => (h.controls.push(m), true),
    avds: async () => [{ name: "Pixel", running: "no" }, { name: "Busy", running: "no-grpc" }, { name: "On", running: "grpc" }],
    webviews: async () => ({ list: [] }),
    navigate: async () => ({ ok: true }),
    installApk: async () => ({ state: "done" }),
    confirm: (t) => (h.asked.push(t), o.allow ?? true),
    phones: () => (o.phones === undefined ? [] : o.phones),
    current: () => (o.current === undefined ? { kind: "emulator", deviceId: "emulator-5554" } : o.current),
    caps: () => (o.caps === undefined ? ALL_CAPS : o.caps),
    logcatSupported: () => o.logcatSupported ?? true,
    readLogcat: (f, limit) => (h.reads.push([f, limit]), o.readLogcat ? o.readLogcat(f, limit) : Promise.resolve({ lines: [LINE] })),
  };
  const tools = new Map(createTools(deps).map((t) => [t.name, t]));
  const run = (name: string, input: Record<string, unknown> = {}, signal = new AbortController().signal) =>
    tools.get(name)!.execute(input, { signal }) as Promise<Record<string, unknown>>;
  return { h, tools, run };
}

test("工具名符合 WebMCP 规范：只有字母数字和 _-.，不超过 128，且不重复", () => {
  const { tools } = harness();
  for (const name of tools.keys()) assert.match(name, /^[A-Za-z0-9_.-]{1,128}$/);
  assert.equal(tools.size, 14);
});

test("shotToDevice：截图像素按方向换算到设备面板，超出截图返回 null", () => {
  assert.deepEqual(shotToDevice({ x: 270, y: 600 }, { width: 540, height: 1200, rotation: 0 }, DEVICE), { x: 540, y: 1200 });
  // 顺时针 90°：截图左上角是设备面板的左下角
  assert.deepEqual(shotToDevice({ x: 0, y: 0 }, { width: 1200, height: 540, rotation: 90 }, DEVICE), { x: 0, y: 2399 });
  assert.equal(shotToDevice({ x: 540, y: 0 }, { width: 540, height: 1200, rotation: 0 }, DEVICE), null);
  assert.equal(shotToDevice({ x: 541, y: 0 }, { width: 540, height: 1200, rotation: 0 }, DEVICE), null);
  assert.equal(shotToDevice({ x: -1, y: 0 }, { width: 540, height: 1200, rotation: 0 }, DEVICE), null);
});

test("swipeSteps：按下开头、抬起结尾、终点准确", () => {
  const pts = swipeSteps({ x: 0, y: 1000 }, { x: 0, y: 200 }, 300);
  assert.deepEqual(pts[0], { x: 0, y: 1000, down: true, delayMs: 0 });
  assert.deepEqual(pts.at(-1), { x: 0, y: 200, down: false, delayMs: 0 });
  assert.ok(pts.slice(0, -1).every((p) => p.down));
  assert.ok(Math.abs(pts.reduce((s, p) => s + p.delayMs, 0) - 300) < 1);
});

test("截图返回 base64 图片和尺寸", async () => {
  const { run } = harness();
  const r = await run("droidpier_screenshot");
  assert.deepEqual(r, { ok: true, width: 540, height: 1200, rotation: 0, mimeType: "image/jpeg", data: "AQID" });
});

test("截图编码失败时返回原因，不抛出", async () => {
  const { tools } = harness();
  const t = createTools({ ...({} as ToolDeps), connected: () => true, rotation: () => 0, snapshot: async () => { throw new Error("no 2d context"); } })
    .find((x) => x.name === "droidpier_screenshot")!;
  const r = (await t.execute({}, { signal: new AbortController().signal })) as Record<string, unknown>;
  assert.equal(r.ok, false);
  assert.match(String(r.error), /no 2d context/);
  assert.ok(tools.size > 0);
});

test("点击要先截图；截图后按截图坐标发按下和抬起", async () => {
  const { h, run } = harness();
  assert.match(String((await run("droidpier_tap", { x: 10, y: 10 })).error), /先调用 droidpier_screenshot/);
  await run("droidpier_screenshot");
  await run("droidpier_tap", { x: 270, y: 600, durationMs: 10 });
  assert.deepEqual(h.sent, [{ t: "touch", x: 540, y: 1200, down: true }, { t: "touch", x: 540, y: 1200, down: false }]);
});

test("截图后设备转了方向，点击要求重新截图", async () => {
  const { h, run } = harness();
  await run("droidpier_screenshot");
  h.rotation = 90;
  assert.match(String((await run("droidpier_tap", { x: 1, y: 1 })).error), /方向变了/);
  assert.equal(h.sent.length, 0);
});

test("滑动中途被取消也会抬起手指", async () => {
  const { h, run } = harness();
  await run("droidpier_screenshot");
  const ac = new AbortController();
  const p = run("droidpier_swipe", { x1: 100, y1: 1000, x2: 100, y2: 200, durationMs: 1000 }, ac.signal);
  setTimeout(() => ac.abort(), 40);
  await p;
  assert.equal(h.sent.at(-1)!.t === "touch" && (h.sent.at(-1) as { down: boolean }).down, false);
  assert.ok(h.sent.length < 60);
});

test("没有设备时操作类工具不发消息，返回原因", async () => {
  const { h, run } = harness({ connected: false });
  const r = await run("droidpier_press_key", { key: "GoBack" });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /没有连接设备/);
  assert.equal(h.sent.length, 0);
});

test("参数不对时返回 ok:false 和原因，不抛出（Chrome 会把抛出的错误换成笼统的 UnknownError）", async () => {
  const { run } = harness();
  await run("droidpier_screenshot");
  const r = await run("droidpier_tap", { x: "a", y: 1 });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /x 需要是数字/);
});

test("按键只认列表里的键", async () => {
  const { h, run } = harness();
  await run("droidpier_press_key", { key: "GoHome" });
  assert.deepEqual(h.sent, [{ t: "key", key: "GoHome", eventType: "keypress" }]);
  assert.match(String((await run("droidpier_press_key", { key: "Shutdown" })).error), /不认识的键/);
});

test("重启、关闭设备先问用户：拒绝时什么都不发", async () => {
  const { h, run } = harness({ allow: false });
  for (const name of ["droidpier_reboot", "droidpier_stop_device"]) {
    const r = await run(name);
    assert.equal(r.ok, false);
  }
  assert.equal(h.asked.length, 2);
  assert.equal(h.controls.length, 0);
});

test("重启：用户允许后才发 reboot", async () => {
  const { h, run } = harness({ allow: true });
  assert.equal((await run("droidpier_reboot")).ok, true);
  assert.deepEqual(h.controls, [{ t: "reboot" }]);
});

test("安装 APK：用户拒绝时不下载", async () => {
  const { run } = harness({ allow: false });
  const realFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = (async () => { fetched = true; return new Response(""); }) as typeof fetch;
  (globalThis as { location?: unknown }).location = { href: "https://droid.devpier.dev/app/" };
  try {
    const r = await run("droidpier_install_apk", { url: "https://example.com/a.apk" });
    assert.equal(r.ok, false);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("启动设备：没运行的启动，已接管的切换，无法接管的报错", async () => {
  const { h, run } = harness();
  await run("droidpier_start_device", { name: "Pixel" });
  await run("droidpier_start_device", { name: "On" });
  const r = await run("droidpier_start_device", { name: "Busy" });
  assert.equal(r.ok, false);
  assert.deepEqual(h.controls, [{ t: "start", name: "Pixel" }, { t: "use", name: "On" }]);
});

const PHONES: PhoneInfo[] = [
  { id: "R5CR10WN52H", state: "device", manufacturer: "samsung", model: "SM-G9910", android: "12" },
  { id: "AUTH1", state: "unauthorized" },
  { id: "OFF1", state: "offline" },
];

test("设备列表：devices 是 AVD，phones 是真机，当前真机 current 为 true；没开 --phones 时 phones 为空", async () => {
  const r = await harness({ phones: PHONES, current: { kind: "phone", deviceId: "R5CR10WN52H" } }).run("droidpier_list_devices");
  assert.equal((r.devices as unknown[]).length, 3);
  assert.deepEqual((r.phones as Array<{ id: string; current: boolean }>).map((p) => [p.id, p.current]), [["R5CR10WN52H", true], ["AUTH1", false], ["OFF1", false]]);
  assert.deepEqual((await harness({ phones: null }).run("droidpier_list_devices")).phones, []);
});

test("启动设备：可用的真机切过去；未授权、离线的不发消息并说下一步；没开 --phones 时找不到", async () => {
  const { h, run } = harness({ phones: PHONES });
  assert.equal((await run("droidpier_start_device", { name: "R5CR10WN52H" })).ok, true);
  assert.match(String((await run("droidpier_start_device", { name: "AUTH1" })).error), /允许 USB 调试/);
  assert.match(String((await run("droidpier_start_device", { name: "OFF1" })).error), /重新插拔/);
  assert.deepEqual(h.controls, [{ t: "use", name: "R5CR10WN52H" }]);
  assert.match(String((await harness({ phones: null }).run("droidpier_start_device", { name: "R5CR10WN52H" })).error), /没有叫/);
});

test("真机不支持旋转、关机、重启：直接返回不支持，不问用户、不发消息", async () => {
  const { h, run } = harness({ caps: PHONE_CAPS, current: { kind: "phone", deviceId: "R5CR10WN52H" } });
  for (const name of ["droidpier_rotate", "droidpier_stop_device", "droidpier_reboot"]) {
    const r = await run(name);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /不支持/);
  }
  assert.equal(h.asked.length, 0);
  assert.equal(h.sent.length + h.controls.length, 0);
});

test("旧网关没有能力表时按模拟器处理：旋转照常发", async () => {
  const { h, run } = harness({ caps: null });
  assert.equal((await run("droidpier_rotate")).ok, true);
  assert.deepEqual(h.sent, [{ t: "rotate" }]);
});

test("读日志：旧网关不发请求，直接说网关版本较旧", async () => {
  const { h, run } = harness({ logcatSupported: false });
  const r = await run("droidpier_read_logcat");
  assert.equal(r.ok, false);
  assert.match(String(r.error), /网关版本较旧/);
  assert.equal(h.reads.length, 0);
});

test("读日志：默认全部 App、全部级别、200 行；行是「时间 pid 级别 tag: 内容」", async () => {
  const { h, run } = harness();
  const r = await run("droidpier_read_logcat");
  assert.deepEqual(h.reads, [[{ pkg: null, level: "V", text: "" }, 200]]);
  assert.deepEqual(r, { ok: true, lines: ["11-16 18:00:52.531 100 E App: boom"], truncated: false });
  await run("droidpier_read_logcat", { package: "com.a", level: "W", text: "net", limit: 5 });
  assert.deepEqual(h.reads[1], [{ pkg: "com.a", level: "W", text: "net" }, 5]);
});

test("读日志：参数不对返回原因；网关回 error 时 ok 为 false", async () => {
  const { run } = harness();
  assert.equal((await run("droidpier_read_logcat", { limit: 2000 })).ok, false);
  assert.equal((await run("droidpier_read_logcat", { level: "X" })).ok, false);
  const r = await harness({ readLogcat: async () => ({ lines: [], error: "adb 没有响应" }) }).run("droidpier_read_logcat");
  assert.deepEqual(r, { ok: false, error: "adb 没有响应" });
});

test("formatLogLines：单行截到 2000 字符；总量超过 10 万字符时丢最旧的并标 truncated", () => {
  const long = formatLogLines([{ ...LINE, msg: "x".repeat(3000) }]);
  assert.equal(long.lines[0].length, 2000);
  assert.ok(long.lines[0].endsWith("…"));
  const many = formatLogLines(Array.from({ length: 60 }, (_, i) => ({ ...LINE, n: i, msg: String(i).padEnd(3000, "y") })));
  assert.equal(many.truncated, true);
  assert.equal(many.lines.length, 50);
  assert.ok(many.lines[49].includes("App: 59y"));
  assert.ok(many.lines[0].includes("App: 10y"));
});

test("读日志：包名不像包名时当场报错，不发请求（网关会丢掉这种消息，页面要干等超时）", async () => {
  const { h, run } = harness();
  const r = await run("droidpier_read_logcat", { package: "my app" });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /包名/);
  assert.equal(h.reads.length, 0);
});

test("读日志：没有符合条件的行时附一句为什么，免得当成没有错误", async () => {
  const r = await harness({ readLogcat: async () => ({ lines: [] }) }).run("droidpier_read_logcat", { package: "com.a", level: "E" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines, []);
  assert.match(String(r.note), /最近约 5000 行/);
});
