import WebSocket from "ws";
import { TextError, textOf, type Msg } from "../../shared/i18n.ts";

export type CdpClient = {
  send(method: string, params?: object): Promise<any>;
  on(event: string, cb: (params: any) => void): () => void;
  close(): void;
  /** socket 关闭时 resolve */
  readonly closed: Promise<void>;
};

/** error：认得的给两种语言，认不出的（WebView 的 net::ERR_…、CDP 的报错）是原文。 */
export type NavResult =
  | { ok: true; href: string; title: string; bridge: boolean }
  | { ok: false; error: string | Msg };

/** 本机开发服务器没启动时给用户的提示。 */
export const DEV_SERVER_DOWN: Msg = { en: "Cannot reach this address: is the local dev server running?", zh: "连不上这个地址：本机开发服务器启动了吗？" };

const ERR_MAP: Record<string, Msg> = {
  "net::ERR_CLEARTEXT_NOT_PERMITTED": { en: "This app does not allow plain http: use https or a debug build", zh: "这个 App 禁止明文 http，请用 https 或 debug 包" },
  "net::ERR_CONNECTION_REFUSED": DEV_SERVER_DOWN,
  "net::ERR_NAME_NOT_RESOLVED": { en: "The domain name could not be resolved", zh: "域名解析失败" },
};

/** 页面加载超时、页面已关闭：navigate 的回复用（server.ts 也用）。 */
export const PAGE_TIMEOUT: Msg = { en: "The page timed out loading", zh: "页面加载超时" };
export const PAGE_CLOSED: Msg = { en: "The page has closed", zh: "页面已关闭" };
const CDP_CLOSED: Msg = { en: "The debugging connection has closed", zh: "CDP socket 已关闭" };

function mapError(text: string): string | Msg {
  return ERR_MAP[text] ?? text;
}

export function connectCdp(wsUrl: string): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
    const listeners = new Map<string, Set<(params: any) => void>>();
    let closedResolve!: () => void;
    const closedPromise = new Promise<void>((r) => { closedResolve = r; });

    let opened = false;
    ws.once("open", () => { opened = true; resolve(client); });
    ws.once("error", (err) => { if (!opened) reject(err); });

    ws.on("message", (data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      } else if (msg.method) {
        const set = listeners.get(msg.method);
        if (set) for (const cb of set) cb(msg.params);
      }
    });

    ws.on("close", () => {
      const err = new TextError(CDP_CLOSED);
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      closedResolve();
    });

    const client: CdpClient = {
      send(method, params) {
        if (ws.readyState !== WebSocket.OPEN) {
          return Promise.reject(new TextError(CDP_CLOSED));
        }
        return new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      on(event, cb) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(cb);
        return () => listeners.get(event)?.delete(cb);
      },
      close() {
        ws.terminate();
      },
      get closed() { return closedPromise; },
    };
  });
}

export async function navigateAndCheck(
  cdp: CdpClient,
  url: string,
  timeoutMs = 10000,
): Promise<NavResult> {
  // 1. Page.enable
  try {
    await cdp.send("Page.enable");
  } catch (e: any) {
    return { ok: false, error: textOf(e) };
  }

  // 2+3. 先注册 loadEventFired 监听器再发 navigate，避免同 tick 到达时丢失事件
  let resolveLoad!: (v: "loaded" | "timeout" | "closed") => void;
  const loadPromise = new Promise<"loaded" | "timeout" | "closed">((res) => { resolveLoad = res; });
  let loadDone = false;

  const offLoad = cdp.on("Page.loadEventFired", () => {
    if (loadDone) return;
    loadDone = true;
    offLoad();
    clearTimeout(loadTid);
    resolveLoad("loaded");
  });

  const loadTid = setTimeout(() => {
    if (loadDone) return;
    loadDone = true;
    offLoad();
    resolveLoad("timeout");
  }, timeoutMs);

  cdp.closed.then(() => {
    if (loadDone) return;
    loadDone = true;
    clearTimeout(loadTid);
    offLoad();
    resolveLoad("closed");
  });

  let navResult: any;
  try {
    navResult = await cdp.send("Page.navigate", { url });
  } catch (e: any) {
    // navigate 失败时清理监听器
    if (!loadDone) { loadDone = true; clearTimeout(loadTid); offLoad(); resolveLoad("closed"); }
    return { ok: false, error: textOf(e) };
  }

  if (navResult?.errorText) {
    // 有 errorText 时不会触发 loadEventFired，清理后直接返回
    if (!loadDone) { loadDone = true; clearTimeout(loadTid); offLoad(); resolveLoad("closed"); }
    return { ok: false, error: mapError(navResult.errorText) };
  }

  const loadResult = await loadPromise;
  if (loadResult === "timeout") return { ok: false, error: PAGE_TIMEOUT };
  if (loadResult === "closed") return { ok: false, error: PAGE_CLOSED };

  // 4. Runtime.evaluate
  try {
    const [hrefRes, titleRes, bridgeRes] = await Promise.all([
      cdp.send("Runtime.evaluate", { expression: "location.href" }),
      cdp.send("Runtime.evaluate", { expression: "document.title" }),
      cdp.send("Runtime.evaluate", { expression: "typeof window._dsbridge" }),
    ]);
    const href = String(hrefRes?.result?.value ?? "");
    const title = String(titleRes?.result?.value ?? "");
    const bridge = bridgeRes?.result?.value === "object";
    return { ok: true, href, title, bridge };
  } catch (e: any) {
    return { ok: false, error: textOf(e) };
  }
}
