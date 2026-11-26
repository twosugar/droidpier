import type { ClientMsg, ServerMsg, UploadState } from "../../shared/protocol.ts";
import { APP_TAR_SUFFIX, canSendChunk, encodeUploadChunk, fileKind, IOS_ONLY_APPS_MSG, iosFileKind, nextChunk, UPLOAD_MAX_BYTES } from "../../shared/upload.ts";
import { t } from "../../shared/i18n.ts";

/** 页面上显示的一个文件。received 是网关已收下的字节。kind：apk 装到 Android，app 装到 iOS 模拟器，file 放进下载文件夹。 */
export type UploadItem = {
  id: number;
  name: string;
  size: number;
  kind: "apk" | "app" | "file";
  state: "waiting" | UploadState;
  received: number;
  error?: string;
};

type Active = { item: UploadItem; file: File; sent: number; reading: boolean; timer: ReturnType<typeof setTimeout> | null };

/** 拖进来的文件排队，一次传一个；按网关的确认控制发送窗口，页面同一时间只读一个窗口的数据。 */
export function createUploads(opts: {
  send: (m: ClientMsg) => boolean;
  sendBinary: (b: Uint8Array) => boolean;
  onChange: (list: UploadItem[]) => void;
  onNotice: (text: string) => void;
  /** 发出 upload 后多久没回就当网关不支持。 */
  replyTimeoutMs: number;
}) {
  let nextId = 1;
  let items: UploadItem[] = [];
  const files = new Map<number, File>();
  let active: Active | null = null;

  const changed = () => opts.onChange(items.map((i) => ({ ...i })));
  const isEnded = (i: UploadItem) => i.state === "done" || i.state === "failed";
  const fail = (item: UploadItem, error: string) => {
    item.state = "failed";
    item.error = error;
    files.delete(item.id);
  };
  const finishActive = () => {
    if (active?.timer) clearTimeout(active.timer);
    active = null;
  };
  // 页面这边放弃了正在传的文件：网关那边也要删临时文件、让出位置
  const giveUp = (a: Active, error: string) => {
    fail(a.item, error);
    finishActive();
    opts.send({ t: "uploadCancel", id: a.item.id });
    changed();
    pump();
  };

  const fill = async () => {
    const a = active;
    if (!a || a.reading || a.item.state !== "uploading") return;
    while (active === a && canSendChunk({ sent: a.sent, acked: a.item.received, size: a.item.size })) {
      const { start, end } = nextChunk(a.sent, a.item.size);
      a.reading = true;
      let data: Uint8Array;
      try {
        data = new Uint8Array(await a.file.slice(start, end).arrayBuffer());
      } catch (e) {
        a.reading = false;
        if (active === a) giveUp(a, t({ en: `Failed to read file: ${(e as Error).message}`, zh: `读文件失败：${(e as Error).message}` }));
        return;
      }
      a.reading = false;
      if (active !== a || a.item.state !== "uploading") return;
      if (data.byteLength !== end - start) return giveUp(a, t({ en: "File changed during upload, please drop it again", zh: "文件在传的过程中变了，请重新拖入" }));
      if (!opts.sendBinary(encodeUploadChunk(a.item.id, data))) return;
      a.sent = end;
    }
  };

  const pump = () => {
    if (active) return;
    const item = items.find((i) => i.state === "waiting");
    if (!item) return;
    const file = files.get(item.id)!;
    if (!opts.send({ t: "upload", id: item.id, name: file.name, size: item.size })) {
      fail(item, t({ en: "No gateway connected", zh: "没有连上网关" }));
      changed();
      return pump();
    }
    item.state = "uploading";
    const a: Active = { item, file, sent: 0, reading: false, timer: null };
    a.timer = setTimeout(() => {
      if (active !== a || a.timer === null) return;
      giveUp(a, t({ en: "Gateway did not respond: gateway may need an upgrade (run the install command again)", zh: "网关没有回应：可能要升级网关（重新运行安装命令）" }));
    }, opts.replyTimeoutMs);
    active = a;
    changed();
  };

  return {
    /**
     * 加进队列；格式不支持、太大的直接标失败。ios：当前设备是 iOS 模拟器，只收 App；gatewayTooOld：网关不会装 App 时给的说明。
     * 页面打包的 .app 文件名带 .tar（见 drop-entries.ts），列表里显示原名。
     */
    add(list: File[], o: { ios?: boolean; gatewayTooOld?: string } = {}) {
      for (const f of list) {
        const shown = f.name.toLowerCase().endsWith(APP_TAR_SUFFIX) ? f.name.slice(0, -".tar".length) : f.name;
        const k = fileKind(f.name);
        const kind: UploadItem["kind"] = o.ios ? "app" : k.kind === "apk" ? "apk" : "file";
        const item: UploadItem = { id: nextId++, name: shown, size: f.size, kind, state: "waiting", received: 0 };
        items.push(item);
        if (o.ios && o.gatewayTooOld) fail(item, o.gatewayTooOld);
        else if (o.ios && iosFileKind(f.name).kind === "unsupported") fail(item, t(IOS_ONLY_APPS_MSG));
        else if (!o.ios && k.kind === "unsupported") fail(item, t({ en: `${k.ext} is not supported, please provide a .apk file`, zh: `暂不支持 ${k.ext}，请提供 .apk` }));
        else if (f.size > UPLOAD_MAX_BYTES) fail(item, t({ en: "File is too large: maximum 2 GB", zh: "文件太大：最大 2 GB" }));
        else files.set(item.id, f);
      }
      changed();
      pump();
    },
    onMsg(m: Extract<ServerMsg, { t: "upload" }>) {
      const a = active;
      if (!a || a.item.id !== m.id) return;
      if (a.timer) {
        clearTimeout(a.timer);
        a.timer = null;
      }
      const item = a.item;
      if (m.state === "uploading") {
        item.received = m.received ?? item.received;
        changed();
        void fill();
        return;
      }
      item.state = m.state;
      if (m.state === "failed") fail(item, m.error ?? t({ en: "Unknown error", zh: "未知原因" }));
      if (isEnded(item)) {
        files.delete(item.id);
        finishActive();
        if (item.state === "done" && item.kind === "file") opts.onNotice(t({ en: `${item.name} has been placed in the Downloads folder`, zh: `${item.name} 已放到 下载 文件夹` }));
      }
      changed();
      pump();
    },
    /** 和网关断开：网关那边已经删了临时文件，进行中和排队的都作废。 */
    disconnected() {
      let any = false;
      for (const i of items) {
        if (isEnded(i)) continue;
        fail(i, t({ en: "Disconnected from gateway", zh: "与网关断开" }));
        any = true;
      }
      finishActive();
      if (any) changed();
    },
    /** 收起结束了的。 */
    clear() {
      items = items.filter((i) => !isEnded(i));
      changed();
    },
    list: () => items.map((i) => ({ ...i })),
  };
}
