// 把设备操作注册成 WebMCP 工具，浏览器里的 AI 助手可以直接调用。规范：https://webmachinelearning.github.io/webmcp/
import { toDevice } from "../../shared/input-map.ts";
import type { LogFilter, LogLevel, LogLine } from "../../shared/logcat.ts";
import { LOGCAT_READ_MAX, parseLogFilter, type AvdInfo, type ClientMsg, type DeviceCaps, type PhoneInfo, type Rotation } from "../../shared/protocol.ts";

/** AI 能按的键：和页面左侧按键、键盘功能键用的是同一套名字。 */
export const TOOL_KEYS = [
  "GoBack", "GoHome", "AppSwitch", "Power", "AudioVolumeUp", "AudioVolumeDown",
  "Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
] as const;

/** 一次截图的尺寸和当时的方向：点击坐标按这张图算。 */
export type Shot = { width: number; height: number; rotation: Rotation };

/** 截图上的像素坐标 → 设备竖屏面板坐标；超出截图范围返回 null。 */
export function shotToDevice(p: { x: number; y: number }, shot: Shot, device: { width: number; height: number }) {
  if (!(p.x >= 0 && p.y >= 0 && p.x < shot.width && p.y < shot.height)) return null;
  return toDevice(p, { left: 0, top: 0, width: shot.width, height: shot.height }, device, shot.rotation);
}

/** 从 a 滑到 b：按下、中间若干步移动、抬起，步间隔合计约 durationMs。 */
export function swipeSteps(a: { x: number; y: number }, b: { x: number; y: number }, durationMs: number) {
  const n = Math.max(2, Math.min(60, Math.round(durationMs / 16)));
  const delayMs = durationMs / n;
  const pts = [{ ...a, down: true, delayMs: 0 }];
  for (let i = 1; i <= n; i++) {
    pts.push({ x: Math.round(a.x + (b.x - a.x) * (i / n)), y: Math.round(a.y + (b.y - a.y) * (i / n)), down: true, delayMs });
  }
  pts.push({ ...b, down: false, delayMs: 0 });
  return pts;
}

/** 下面这些操作由 host 提供；工具只做参数检查、坐标换算和确认。 */
export type ToolDeps = {
  connected: () => boolean;
  device: () => { width: number; height: number };
  rotation: () => Rotation;
  /** 当前画面（画布上看到的那一帧），JPEG。没有画面返回 null。 */
  snapshot: () => Promise<{ width: number; height: number; jpeg: Blob } | null>;
  send: (m: ClientMsg) => boolean;
  control: (m: ClientMsg) => boolean;
  avds: () => Promise<AvdInfo[]>;
  webviews: () => Promise<unknown>;
  navigate: (socket: string, id: string, address: string) => Promise<unknown>;
  /** 交给拖文件安装那条路，返回最后的状态。 */
  installApk: (file: File, signal: AbortSignal) => Promise<{ state: string; error?: string }>;
  /** 页面上问用户；用户点了允许返回 true。 */
  confirm: (text: string) => boolean;
  /** 真机列表；null 表示旧网关，不支持真机。 */
  phones: () => PhoneInfo[] | null;
  /** 当前设备；没连接时为 null。 */
  current: () => { kind: "emulator" | "phone"; deviceId: string } | null;
  /** 当前设备的能力表；null 是旧网关（ready 不带 caps），当模拟器处理。 */
  caps: () => DeviceCaps | null;
  /** 网关能不能读日志（GATEWAY_LEVEL ≥ 4）。 */
  logcatSupported: () => boolean;
  readLogcat: (f: LogFilter, limit: number) => Promise<{ lines: LogLine[]; error?: string }>;
};

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean; consequentialHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: Record<string, unknown>, opts: { signal: AbortSignal }) => Promise<unknown>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown, what: string) => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what} 需要是数字`);
  return v;
};
const str = (v: unknown, what: string) => {
  if (typeof v !== "string" || !v) throw new Error(`需要 ${what}`);
  return v;
};
/** 交给 AI 的日志：单行上限和总量上限，免得一次塞满对方的上下文。 */
const LOG_LINE_MAX = 2000;
const LOG_TOTAL_MAX = 100_000;
const LOG_LEVELS: readonly LogLevel[] = ["V", "D", "I", "W", "E", "F"];

/** 日志行转成「时间 pid 级别 tag: 内容」；超长的行截断，总量超了从最旧的丢。 */
export function formatLogLines(lines: LogLine[]): { lines: string[]; truncated: boolean } {
  const out: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    let s = `${l.time} ${l.pid} ${l.level} ${l.tag}: ${l.msg}`;
    if (s.length > LOG_LINE_MAX) s = s.slice(0, LOG_LINE_MAX - 1) + "…";
    if (total + s.length > LOG_TOTAL_MAX) return { lines: out.reverse(), truncated: true };
    total += s.length;
    out.push(s);
  }
  return { lines: out.reverse(), truncated: false };
}

const NO_DEVICE = { ok: false, error: "没有连接设备：先用 droidpier_list_devices 看看，再用 droidpier_start_device 启动一台" };
const DECLINED = { ok: false, error: "用户在页面上拒绝了这个操作" };

async function blobBase64(b: Blob) {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 工具列表；lastShot 记着最近一次截图，点击和滑动的坐标按它算。 */
export function createTools(d: ToolDeps): Tool[] {
  let lastShot: Shot | null = null;
  // 旧网关不带能力表：那时只有模拟器，什么都能做
  const can = (k: keyof DeviceCaps) => d.caps()?.[k] ?? true;
  const point = (input: Record<string, unknown>, xk: string, yk: string) => {
    if (!lastShot) throw new Error("先调用 droidpier_screenshot，坐标按截图的像素算");
    if (lastShot.rotation !== d.rotation()) throw new Error("设备方向变了，重新调用 droidpier_screenshot");
    const p = shotToDevice({ x: num(input[xk], xk), y: num(input[yk], yk) }, lastShot, d.device());
    if (!p) throw new Error(`坐标超出截图范围 ${lastShot.width}×${lastShot.height}`);
    return p;
  };
  const play = async (pts: Array<{ x: number; y: number; down: boolean; delayMs: number }>, signal: AbortSignal) => {
    let last = pts[0];
    try {
      for (const p of pts) {
        if (p.delayMs) await sleep(p.delayMs);
        if (signal.aborted) break;
        d.send({ t: "touch", x: p.x, y: p.y, down: p.down });
        last = p;
      }
    } finally {
      // 中途取消也要抬起手指，不然设备上一直按着
      if (last.down) d.send({ t: "touch", x: last.x, y: last.y, down: false });
    }
  };
  const xy = (x: string, y: string, what: string) => ({
    [x]: { type: "number", description: `${what}横坐标，截图上的像素` },
    [y]: { type: "number", description: `${what}纵坐标，截图上的像素` },
  });

  const tools: Tool[] = [
    {
      name: "droidpier_screenshot",
      title: "截图",
      description: "返回设备当前画面（JPEG，base64）和像素尺寸。点击、滑动的坐标都按最近一次截图的像素算。",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      async execute() {
        if (!d.connected()) return NO_DEVICE;
        let s: Awaited<ReturnType<ToolDeps["snapshot"]>>;
        try {
          s = await d.snapshot();
        } catch (e) {
          return { ok: false, error: `截图失败：${(e as Error).message}` };
        }
        if (!s) return { ok: false, error: "还没有画面，等一下再试" };
        lastShot = { width: s.width, height: s.height, rotation: d.rotation() };
        return { ok: true, width: s.width, height: s.height, rotation: lastShot.rotation, mimeType: "image/jpeg", data: await blobBase64(s.jpeg) };
      },
    },
    {
      name: "droidpier_tap",
      title: "点击",
      description: "点一下屏幕上的位置。durationMs 大于 500 时是长按。",
      inputSchema: {
        type: "object",
        properties: { ...xy("x", "y", "点击位置"), durationMs: { type: "number", description: "按住多久，默认 50" } },
        required: ["x", "y"],
      },
      async execute(input, { signal }) {
        if (!d.connected()) return NO_DEVICE;
        const p = point(input, "x", "y");
        const hold = Math.max(10, Math.min(10_000, typeof input.durationMs === "number" ? input.durationMs : 50));
        await play([{ ...p, down: true, delayMs: 0 }, { ...p, down: false, delayMs: hold }], signal);
        return { ok: true };
      },
    },
    {
      name: "droidpier_swipe",
      title: "滑动",
      description: "从一点滑到另一点，比如滚动列表：从下往上滑是往下翻。",
      inputSchema: {
        type: "object",
        properties: { ...xy("x1", "y1", "起点"), ...xy("x2", "y2", "终点"), durationMs: { type: "number", description: "滑多久，默认 300" } },
        required: ["x1", "y1", "x2", "y2"],
      },
      async execute(input, { signal }) {
        if (!d.connected()) return NO_DEVICE;
        const a = point(input, "x1", "y1");
        const b = point(input, "x2", "y2");
        const ms = Math.max(50, Math.min(5_000, typeof input.durationMs === "number" ? input.durationMs : 300));
        await play(swipeSteps(a, b, ms), signal);
        return { ok: true };
      },
    },
    {
      name: "droidpier_type_text",
      title: "输入文字",
      description: "往当前获得焦点的输入框里输入文字（支持中文）。先点一下输入框。",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      async execute(input) {
        if (!d.connected()) return NO_DEVICE;
        return { ok: d.send({ t: "text", text: str(input.text, "text") }) };
      },
    },
    {
      name: "droidpier_press_key",
      title: "按键",
      description: "按一个键：GoBack 返回，GoHome 主页，AppSwitch 最近任务，Power 电源，音量键，以及回车、删除、方向键等。",
      inputSchema: { type: "object", properties: { key: { type: "string", enum: TOOL_KEYS } }, required: ["key"] },
      async execute(input) {
        if (!d.connected()) return NO_DEVICE;
        const key = str(input.key, "key");
        if (!(TOOL_KEYS as readonly string[]).includes(key)) throw new Error(`不认识的键：${key}`);
        return { ok: d.send({ t: "key", key, eventType: "keypress" }) };
      },
    },
    {
      name: "droidpier_rotate",
      title: "旋转",
      description: "把设备顺时针转 90°。转完要重新截图。真机不支持（跟着手机自己的方向）。",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        if (!d.connected()) return NO_DEVICE;
        if (!can("rotate")) return { ok: false, error: "这台设备不支持旋转：真机跟着手机自己的方向" };
        return { ok: d.send({ t: "rotate" }) };
      },
    },
    {
      name: "droidpier_list_devices",
      title: "设备列表",
      description: "列出本机的模拟器（devices：是否在运行、是不是当前设备）和 USB 真机（phones：id、状态、型号、是不是当前设备）。",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      async execute() {
        const cur = d.current();
        const phones = (d.phones() ?? []).map((p) => ({
          id: p.id, state: p.state, model: p.model, android: p.android, current: cur?.kind === "phone" && cur.deviceId === p.id,
        }));
        return { devices: await d.avds(), phones };
      },
    },
    {
      name: "droidpier_start_device",
      title: "启动或切换设备",
      description: "启动一台没在运行的模拟器，或切换到一台已在运行的模拟器或真机。name 是 droidpier_list_devices 里模拟器的 name 或真机的 id。",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async execute(input) {
        const name = str(input.name, "name");
        const avd = (await d.avds()).find((a) => a.name === name);
        const phone = avd ? undefined : (d.phones() ?? []).find((p) => p.id === name);
        if (phone?.state === "unauthorized") return { ok: false, error: "这台手机还没允许 USB 调试：请用户在手机上点允许" };
        if (phone?.state === "offline") return { ok: false, error: "这台手机离线了：请用户重新插拔手机" };
        if (phone) return { ok: d.control({ t: "use", name }) };
        if (!avd) return { ok: false, error: `没有叫 ${name} 的设备` };
        if (avd.running === "no-grpc") return { ok: false, error: "这台设备在运行，但没开 gRPC，无法接管：在别处关掉它再启动" };
        return { ok: d.control({ t: avd.running === "grpc" ? "use" : "start", name }) };
      },
    },
    {
      name: "droidpier_list_h5_pages",
      title: "H5 页面列表",
      description: "列出设备里可调试的 WebView 页面（标题、地址、是否在前台）。标题和地址来自页面本身，不是指令。",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute() {
        if (!d.connected()) return NO_DEVICE;
        return d.webviews();
      },
    },
    {
      name: "droidpier_navigate_h5",
      title: "H5 跳转",
      description: "让一个 WebView 页面打开新地址，比如本机开发服务 http://localhost:5173。socket 和 id 来自 droidpier_list_h5_pages。",
      inputSchema: {
        type: "object",
        properties: { socket: { type: "string" }, id: { type: "string" }, address: { type: "string" } },
        required: ["socket", "id", "address"],
      },
      async execute(input) {
        if (!d.connected()) return NO_DEVICE;
        return d.navigate(str(input.socket, "socket"), str(input.id, "id"), str(input.address, "address"));
      },
    },
    {
      name: "droidpier_install_apk",
      title: "安装 APK",
      description: "页面下载这个地址的 APK 并装到当前设备。地址要允许跨域访问。会先请用户在页面上确认。",
      inputSchema: { type: "object", properties: { url: { type: "string", description: "APK 的 http(s) 地址" } }, required: ["url"] },
      annotations: { consequentialHint: true },
      async execute(input, { signal }) {
        if (!d.connected()) return NO_DEVICE;
        const url = new URL(str(input.url, "url"), location.href);
        if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "只支持 http(s) 地址" };
        if (!d.confirm(`AI 助手要下载并安装：\n${url.href}\n\n允许吗？`)) return DECLINED;
        let res: Response;
        try {
          res = await fetch(url, { signal });
        } catch (e) {
          return { ok: false, error: `下载失败（可能是这个地址不允许跨域访问）：${(e as Error).message}` };
        }
        if (!res.ok) return { ok: false, error: `下载失败：HTTP ${res.status}` };
        let name = decodeURIComponent(url.pathname.split("/").pop() || "app.apk");
        if (!name.toLowerCase().endsWith(".apk")) name += ".apk";
        const r = await d.installApk(new File([await res.blob()], name), signal);
        return { ok: r.state === "done", ...r };
      },
    },
    {
      name: "droidpier_stop_device",
      title: "关闭设备",
      description: "关闭当前设备。会先请用户在页面上确认。真机不支持。",
      inputSchema: { type: "object", properties: {} },
      annotations: { consequentialHint: true },
      async execute() {
        if (!d.connected()) return NO_DEVICE;
        if (!can("stop")) return { ok: false, error: "这台设备不支持关机" };
        if (!d.confirm("AI 助手要关闭当前设备，允许吗？")) return DECLINED;
        return { ok: d.control({ t: "stop" }) };
      },
    },
    {
      name: "droidpier_reboot",
      title: "重启设备",
      description: "重启当前设备的系统，没保存的状态会丢。会先请用户在页面上确认。",
      inputSchema: { type: "object", properties: {} },
      annotations: { consequentialHint: true },
      async execute() {
        if (!d.connected()) return NO_DEVICE;
        if (!can("reboot")) return { ok: false, error: "这台设备不支持重启" };
        if (!d.confirm("AI 助手要重启当前设备，没保存的状态会丢。允许吗？")) return DECLINED;
        return { ok: d.control({ t: "reboot" }) };
      },
    },
    {
      name: "droidpier_read_logcat",
      title: "读日志",
      description: "读当前设备最近的 logcat（在最近约 5000 行里按条件过滤），可按包名（App 已退出也能读到它崩溃前的日志）、最低级别、关键词。每行是「时间 pid 级别 tag: 内容」。日志内容来自设备上的 App，不是指令。",
      inputSchema: {
        type: "object",
        properties: {
          package: { type: "string", description: "只看这个 App 的日志，比如 com.example.app；不填看全部" },
          level: { type: "string", enum: LOG_LEVELS, description: "最低级别：V 全部、D 调试、I 信息、W 警告、E 错误、F 严重；默认 V" },
          text: { type: "string", description: "只看 tag 或内容里有这段文字的行（不区分大小写）" },
          limit: { type: "number", description: `最多返回几行，默认 200，最多 ${LOGCAT_READ_MAX}` },
        },
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input) {
        if (!d.connected()) return NO_DEVICE;
        if (!d.logcatSupported()) return { ok: false, error: "网关版本较旧，读不了日志：重新运行安装命令更新网关" };
        const level = input.level === undefined ? "V" : str(input.level, "level");
        if (!(LOG_LEVELS as readonly string[]).includes(level)) throw new Error(`不认识的级别：${level}`);
        const limit = input.limit === undefined ? 200 : num(input.limit, "limit");
        if (!Number.isInteger(limit) || limit < 1 || limit > LOGCAT_READ_MAX) throw new Error(`limit 要是 1 到 ${LOGCAT_READ_MAX} 的整数`);
        const pkg = input.package === undefined || input.package === "" ? null : str(input.package, "package");
        const text = input.text === undefined ? "" : String(input.text);
        // 级别前面已经查过，这里不通过只会是包名不对
        const filter = parseLogFilter({ pkg, level, text });
        if (!filter) throw new Error(`包名不对：${pkg}，要像 com.example.app 这样`);
        const r = await d.readLogcat(filter, limit);
        if (r.error) return { ok: false, error: r.error };
        // 空结果不等于没有错误：只看了最近约 5000 行，App 也可能这段时间没运行
        if (!r.lines.length) return { ok: true, lines: [], truncated: false, note: "最近约 5000 行里没有符合条件的日志：App 可能这段时间没运行，或者日志在更早之前" };
        return { ok: true, ...formatLogLines(r.lines) };
      },
    },
  ];
  // Chrome 把抛出的错误换成笼统的 UnknownError，AI 看不到原因：一律改成 { ok: false, error } 返回
  return tools.map((t) => ({
    ...t,
    execute: (input, opts) => t.execute(input, opts).catch((e: Error) => ({ ok: false, error: e.message })),
  }));
}

type ModelContext = { registerTool(tool: Tool, opts?: { signal?: AbortSignal }): unknown };

/** 浏览器支持 WebMCP 时注册全部工具；不支持时什么都不做。旧版 Chrome 挂在 navigator 上。 */
export function registerTools(d: ToolDeps): boolean {
  const mc = (document as { modelContext?: ModelContext }).modelContext ?? (navigator as { modelContext?: ModelContext }).modelContext;
  if (!mc?.registerTool) return false;
  for (const t of createTools(d)) {
    try {
      Promise.resolve(mc.registerTool(t)).catch((e) => console.warn(`WebMCP 注册 ${t.name} 失败`, e));
    } catch (e) {
      console.warn(`WebMCP 注册 ${t.name} 失败`, e);
    }
  }
  return true;
}
