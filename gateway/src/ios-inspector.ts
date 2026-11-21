// iOS 模拟器的 H5 调试：连模拟器里的 webinspectord_sim（Safari「开发」菜单用的同一个接口），列出可调试的页面，
// 为 WebKit 自己的调试界面（系统里的 WebInspectorUI.framework，gateway/src/server.ts 在 /webinspector/ 下提供）转发消息。
// 接口是 4 字节大端长度 + 二进制 plist 的 RPC，选择子和键名照 ios_webkit_debug_proxy 的 rpc.c（2026-11-22 iOS 27 模拟器实测）
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import type { WebViewPage } from "../../shared/protocol.ts";
import { decode, encode, type Plist } from "./bplist.ts";

type Dict = { [k: string]: Plist };

/** 一个页面的调试通道：前端发来的协议消息原样交给页面，页面的回复和事件原样交给前端。 */
export type InspectorChannel = { send(message: string): void; onMessage(cb: (message: string) => void): void; onClose(cb: () => void): void; close(): void };

/** WebInspectorUI 里有 iOS 13.0–27.0 各版本的命令表（Protocol/Legacy/iOS/<版本>）：取不超过模拟器版本的最大一个。 */
export function legacyProtocolVersion(runtime: string, available: string[]): string | null {
  const num = (v: string) => v.split(".").map(Number);
  const cmp = (a: string, b: string) => {
    const [x, y] = [num(a), num(b)];
    return x[0] - y[0] || (x[1] ?? 0) - (y[1] ?? 0);
  };
  const want = /(\d+\.\d+)/.exec(runtime)?.[1];
  if (!want) return null;
  const ok = available.filter((v) => /^\d+\.\d+$/.test(v) && cmp(v, want) <= 0).sort(cmp);
  return ok.at(-1) ?? null;
}

/** 把字节流切成消息：4 字节大端长度 + bplist。 */
export function createWirParser(onMessage: (selector: string, arg: Dict) => void) {
  let buf: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const n = buf.readUInt32BE(0);
      if (buf.length < 4 + n) break;
      const body = buf.subarray(4, 4 + n);
      buf = buf.subarray(4 + n);
      let msg: Plist;
      try {
        msg = decode(body);
      } catch {
        continue;
      }
      if (msg && typeof msg === "object" && !Array.isArray(msg) && !Buffer.isBuffer(msg) && typeof msg.__selector === "string") {
        const arg = msg.__argument;
        onMessage(msg.__selector, arg && typeof arg === "object" && !Array.isArray(arg) && !Buffer.isBuffer(arg) ? arg : {});
      }
    }
  };
}

export function wirFrame(selector: string, arg: Dict): Buffer {
  const body = encode({ __selector: selector, __argument: arg });
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

const LIST_WAIT_MS = 1500;
const str = (v: Plist | undefined) => (typeof v === "string" ? v : "");

/**
 * 一台模拟器的调试连接。connect 给出到 webinspectord_sim 的 socket（测试里换成假的）。
 * 页面在列表里的 socket 字段是应用 id（PID:123 这种），id 是页面编号，和 Android 的「socket + 页面 id」对得上。
 */
export function createIosInspector(deps: { connect: () => Promise<Duplex>; log?: (s: string) => void }) {
  const log = deps.log ?? (() => {});
  const conn = randomUUID().toUpperCase();
  let sock: Duplex | null = null;
  let connecting: Promise<Duplex> | null = null;
  const handlers = new Set<(selector: string, arg: Dict) => void>();
  // 发送者 → 通道：页面的数据带着 WIRDestinationKey（就是建通道时的 WIRSenderKey）
  const channels = new Map<string, { appId: string; deliver(m: string): void; closed(): void }>();

  const dispatch = (selector: string, arg: Dict) => {
    if (selector === "_rpc_applicationSentData:") {
      const ch = channels.get(str(arg.WIRDestinationKey));
      const data = arg.WIRMessageDataKey;
      if (ch && Buffer.isBuffer(data)) ch.deliver(data.toString("utf8"));
    } else if (selector === "_rpc_applicationDisconnected:") {
      // 应用退出：它的通道断了，页面那边会重新列表
      const gone = str(arg.WIRApplicationIdentifierKey);
      for (const ch of [...channels.values()]) if (ch.appId === gone) ch.closed();
    }
    for (const h of handlers) h(selector, arg);
  };

  const ensure = (): Promise<Duplex> => {
    if (sock) return Promise.resolve(sock);
    connecting ??= deps.connect().then((s) => {
      sock = s;
      connecting = null;
      s.on("data", createWirParser(dispatch));
      const gone = () => {
        if (sock !== s) return;
        sock = null;
        for (const ch of channels.values()) ch.closed();
        channels.clear();
      };
      s.on("close", gone);
      s.on("error", (e: Error) => {
        log(`iOS 调试接口出错：${e.message}`);
        gone();
      });
      s.write(wirFrame("_rpc_reportIdentifier:", { WIRConnectionIdentifierKey: conn }));
      return s;
    }, (e: Error) => {
      connecting = null;
      throw e;
    });
    return connecting;
  };
  const send = async (selector: string, arg: Dict) => (await ensure()).write(wirFrame(selector, { WIRConnectionIdentifierKey: conn, ...arg }));
  const waitFor = (selector: string, pred: (a: Dict) => boolean, ms: number) =>
    new Promise<Dict | null>((resolve) => {
      const h = (s: string, a: Dict) => {
        if (s !== selector || !pred(a)) return;
        clearTimeout(t);
        handlers.delete(h);
        resolve(a);
      };
      const t = setTimeout(() => {
        handlers.delete(h);
        resolve(null);
      }, ms);
      handlers.add(h);
    });

  return {
    /** 所有应用里可调试的网页（Safari 标签、App 里开了 isInspectable 的 WKWebView）。 */
    async list(): Promise<WebViewPage[]> {
      const apps = waitFor("_rpc_reportConnectedApplicationList:", () => true, LIST_WAIT_MS);
      await send("_rpc_getConnectedApplications:", {});
      const dict = (await apps)?.WIRApplicationDictionaryKey;
      const appList = dict && typeof dict === "object" && !Array.isArray(dict) && !Buffer.isBuffer(dict) ? Object.values(dict) : [];
      const pages: WebViewPage[] = [];
      await Promise.all(appList.map(async (app) => {
        if (!app || typeof app !== "object" || Array.isArray(app) || Buffer.isBuffer(app)) return;
        const appId = str(app.WIRApplicationIdentifierKey);
        if (!appId) return;
        const listing = waitFor("_rpc_applicationSentListing:", (a) => a.WIRApplicationIdentifierKey === appId, LIST_WAIT_MS);
        await send("_rpc_forwardGetListing:", { WIRApplicationIdentifierKey: appId });
        const l = (await listing)?.WIRListingKey;
        if (!l || typeof l !== "object" || Array.isArray(l) || Buffer.isBuffer(l)) return;
        for (const p of Object.values(l)) {
          if (!p || typeof p !== "object" || Array.isArray(p) || Buffer.isBuffer(p)) continue;
          // 只要网页：WIRTypeJavaScript（JSContext）这类前端用不了 web-page 模式
          if (str(p.WIRTypeKey) && str(p.WIRTypeKey) !== "WIRTypeWebPage" && str(p.WIRTypeKey) !== "WIRTypeWeb") continue;
          const id = p.WIRPageIdentifierKey;
          if (typeof id !== "number") continue;
          pages.push({
            socket: appId,
            id: String(id),
            title: str(p.WIRTitleKey),
            url: str(p.WIRURLKey),
            pkg: str(app.WIRApplicationBundleIdentifierKey) || str(app.WIRApplicationNameKey) || undefined,
            // 列表里没有可见性：iOS 一次只显示一个前台应用，都当可见（页面靠它决定要不要自动打开控制台）
            visible: true,
          });
        }
      }));
      return pages;
    },
    /** 给这个页面建调试通道。 */
    async open(appId: string, pageId: string): Promise<InspectorChannel> {
      const sender = randomUUID().toUpperCase();
      const base = { WIRApplicationIdentifierKey: appId, WIRPageIdentifierKey: Number(pageId), WIRSenderKey: sender };
      const msgCbs: Array<(m: string) => void> = [];
      const closeCbs: Array<() => void> = [];
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        channels.delete(sender);
        for (const cb of closeCbs) cb();
      };
      // 前端连上之前到的消息（Target.targetCreated 等）先存着，onMessage 挂上时一次交出去
      const early: string[] = [];
      channels.set(sender, {
        appId,
        deliver: (m) => (msgCbs.length ? msgCbs.forEach((cb) => cb(m)) : early.push(m)),
        closed: finish,
      });
      try {
        await send("_rpc_forwardSocketSetup:", { ...base, WIRAutomaticallyPause: false });
      } catch (e) {
        // 连不上调试接口：不留表项
        channels.delete(sender);
        throw e;
      }
      return {
        send: (message) => {
          if (!closed) void send("_rpc_forwardSocketData:", { ...base, WIRSocketDataKey: Buffer.from(message, "utf8") }).catch(() => finish());
        },
        onMessage: (cb) => {
          msgCbs.push(cb);
          for (const m of early.splice(0)) cb(m);
        },
        onClose: (cb) => void closeCbs.push(cb),
        close: () => {
          if (closed) return;
          void send("_rpc_forwardDidClose:", base).catch(() => {});
          finish();
        },
      };
    },
    /** 断开到模拟器的连接（会话关掉时）。 */
    close() {
      for (const ch of channels.values()) ch.closed();
      channels.clear();
      sock?.destroy();
      sock = null;
    },
  };
}

export type IosInspector = ReturnType<typeof createIosInspector>;
