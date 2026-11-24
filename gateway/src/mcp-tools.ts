// MCP 给 AI 的工具：看当前设备、列 H5 页面、在页面里执行 JS、读 console、截图。
// 页面的调试连接按页面留着（console 要一直收），设备换了或连接断了就丢掉，下次用到再连。
// Android 是 Chrome 的 CDP，iOS 是 WebKit 的协议（gateway/src/webkit-cdp.ts 包成同样的接口），两边 Runtime、console 的写法不同。
import type { CdpClient } from "./cdp.ts";
import type { McpContent, McpTool } from "./mcp.ts";
import type { WebViewPage } from "../../shared/protocol.ts";

export type McpDevice = { id: string; name: string; platform: "android" | "ios"; kind: "emulator" | "phone"; width: number; height: number };

export type McpDeps = {
  /** 页面上正显示的设备；没有时 null。 */
  current(): Promise<McpDevice | null>;
  /** 当前设备上可调试的页面。 */
  pages(): Promise<WebViewPage[]>;
  /** 连上这个页面；webkit 为 true 时是 iOS 的协议。iOS 和页面里的调试界面共用一条通道（gateway/src/shared-channel.ts）。 */
  connect(page: WebViewPage): Promise<{ cdp: CdpClient; webkit: boolean }>;
  /** 当前设备的截图，PNG。 */
  screenshot(): Promise<Buffer>;
};

/** MCP 握手时给 AI 的说明。 */
export const MCP_INSTRUCTIONS =
  "Droidpier 网关：操作 Droidpier 页面上正显示的那台设备（Android 模拟器、真机、MuMu、iOS 模拟器），调试里面的 H5 页面。" +
  "先用 list_pages 找页面，再用 evaluate 执行 JS、console_logs 读日志，screenshot 看屏幕。" +
  "iOS 页面和 Droidpier 页面里的调试界面共用同一条调试连接，不要再用 iwdp 等工具另外连同一台模拟器，会把连接顶掉。";

/** iOS 上执行结果的对象组：取完值就放掉。 */
const OBJECT_GROUP = "droidpier-mcp";
/** console 留最近这么多条。 */
const LOG_KEEP = 500;
/** 一次返回的结果最多这么多字，太长的截断（AI 读不了太长的）。 */
const RESULT_MAX = 50_000;

type Log = { seq: number; level: string; text: string; source?: string };
type PageLink = { device: string; cdp: CdpClient; webkit: boolean; logs: Log[]; next: number };

const pageKey = (p: WebViewPage) => `${p.socket}/${p.id}`;
const clip = (s: string) => (s.length > RESULT_MAX ? `${s.slice(0, RESULT_MAX)}…（共 ${s.length} 字，已截断）` : s);
const textOf = (s: string): McpContent[] => [{ type: "text", text: s }];

/** console 参数或结果的一个值（RemoteObject）写成一段字。 */
function show(o: any): string {
  if (!o || typeof o !== "object") return String(o);
  if ("value" in o) return typeof o.value === "string" ? o.value : JSON.stringify(o.value);
  if (o.type === "undefined") return "undefined";
  return o.description ?? o.type ?? "";
}

export function createMcpTools(deps: McpDeps): McpTool[] {
  const links = new Map<string, PageLink>();
  const connecting = new Map<string, Promise<PageLink>>();

  const device = async () => {
    const d = await deps.current();
    if (!d) throw new Error("没有连接设备：先在 Droidpier 页面上打开一台设备");
    return d;
  };

  /** page 参数对应的页面；不给时用唯一在前台的那个。 */
  const pickPage = async (arg: unknown): Promise<WebViewPage> => {
    const pages = await deps.pages();
    const list = () => pages.map((p) => `${pageKey(p)}  ${p.visible ? "前台" : "后台"}  ${p.url}`).join("\n");
    if (typeof arg === "string" && arg) {
      const p = pages.find((x) => pageKey(x) === arg);
      if (!p) throw new Error(`没有这个页面：${arg}。现在的页面：\n${list() || "（没有）"}`);
      return p;
    }
    const front = pages.filter((p) => p.visible);
    if (front.length === 1) return front[0];
    if (!front.length) throw new Error(`前台没有页面，用 page 参数指定一个：\n${list() || "（没有）"}`);
    throw new Error(`前台有 ${front.length} 个页面，用 page 参数指定一个：\n${list()}`);
  };

  const link = async (arg: unknown): Promise<PageLink> => {
    const d = await device();
    // 换了设备：旧设备的连接都不要了
    for (const [k, l] of links) if (l.device !== d.id) (links.delete(k), l.cdp.close());
    const page = await pickPage(arg);
    const key = `${d.id}|${pageKey(page)}`;
    const have = links.get(key);
    if (have) return have;
    const pending = connecting.get(key);
    if (pending) return pending;
    const p = (async () => {
      const { cdp, webkit } = await deps.connect(page);
      const l: PageLink = { device: d.id, cdp, webkit, logs: [], next: 0 };
      const add = (level: string, text: string, source?: string) => {
        l.logs.push({ seq: l.next++, level, text, ...(source ? { source } : {}) });
        if (l.logs.length > LOG_KEEP) l.logs.splice(0, l.logs.length - LOG_KEEP);
      };
      if (webkit) {
        cdp.on("Console.messageAdded", ({ message: m }) => add(m?.level ?? "log", m?.text ?? "", m?.url ? `${m.url}:${m.line ?? 0}` : undefined));
        await cdp.send("Console.enable");
      } else {
        cdp.on("Runtime.consoleAPICalled", (e) => add(e.type ?? "log", (e.args ?? []).map(show).join(" ")));
        cdp.on("Runtime.exceptionThrown", (e) => add("error", e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text ?? "未捕获的异常"));
        await cdp.send("Runtime.enable");
      }
      links.set(key, l);
      void cdp.closed.then(() => {
        if (links.get(key) === l) links.delete(key);
      });
      return l;
    })().finally(() => connecting.delete(key));
    connecting.set(key, p);
    return p;
  };

  const pageArg = { page: { type: "string", description: "list_pages 给出的 page；不填时用唯一在前台的页面" } };

  return [
    {
      name: "device_status",
      description: "Droidpier 当前连接的设备（页面上正显示的那台）：名字、平台（android / ios）、类型、屏幕像素尺寸。",
      inputSchema: { type: "object", properties: {} },
      run: async () => textOf(JSON.stringify(await device())),
    },
    {
      name: "list_pages",
      description: "当前设备上可以调试的 H5 页面（App 里的 WebView、浏览器标签页）。visible 表示在前台。其他工具的 page 参数用这里的 page。",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        await device();
        const pages = await deps.pages();
        return textOf(JSON.stringify(pages.map((p) => ({ page: pageKey(p), title: p.title, url: p.url, visible: p.visible, app: p.pkg }))));
      },
    },
    {
      name: "evaluate",
      description: "在 H5 页面里执行一段 JavaScript，返回结果（JSON）。结果是 Promise 时等它完成。抛出异常时工具失败并带上异常信息。可以用来查 DOM、读页面状态、调页面里的函数。",
      inputSchema: { type: "object", properties: { ...pageArg, expression: { type: "string", description: "要执行的 JavaScript 表达式" } }, required: ["expression"] },
      run: async (args) => {
        if (typeof args.expression !== "string") throw new Error("缺少 expression");
        const l = await link(args.page);
        let r: any;
        if (!l.webkit) r = await l.cdp.send("Runtime.evaluate", { expression: args.expression, returnByValue: true, awaitPromise: true });
        else {
          // WebKit 的 Runtime.evaluate 没有 awaitPromise，按值取回时 Promise 会变成 {}（2026-11-24 iOS 18.3 实测）：
          // 先拿对象，Promise 单独等，别的对象再按值取回；用完放掉这组对象
          r = await l.cdp.send("Runtime.evaluate", { expression: args.expression, objectGroup: OBJECT_GROUP, returnByValue: false });
          const o = r.result;
          if (!r.wasThrown && o?.objectId) {
            r = o.className === "Promise"
              ? await l.cdp.send("Runtime.awaitPromise", { promiseObjectId: o.objectId, returnByValue: true })
              : await l.cdp.send("Runtime.callFunctionOn", { objectId: o.objectId, functionDeclaration: "function () { return this; }", returnByValue: true });
          }
          void l.cdp.send("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }).catch(() => {});
        }
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "执行出错");
        if (r.wasThrown) throw new Error(show(r.result));
        const v = r.result;
        return textOf(clip(v && "value" in v ? (JSON.stringify(v.value) ?? "undefined") : show(v)));
      },
    },
    {
      name: "console_logs",
      description: `H5 页面的 console 输出和未捕获的异常（从第一次连上这个页面开始收，留最近 ${LOG_KEEP} 条）。since 填上次返回的 next 只取新的。`,
      inputSchema: { type: "object", properties: { ...pageArg, since: { type: "number", description: "只要序号不小于它的日志" } } },
      run: async (args) => {
        const l = await link(args.page);
        const since = typeof args.since === "number" ? args.since : 0;
        return textOf(clip(JSON.stringify({ next: l.next, logs: l.logs.filter((x) => x.seq >= since) })));
      },
    },
    {
      name: "screenshot",
      description: "当前设备屏幕的截图（PNG）。",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        await device();
        return [{ type: "image", data: (await deps.screenshot()).toString("base64"), mimeType: "image/png" }];
      },
    },
  ];
}
