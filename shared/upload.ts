import { msgOf, type Msg } from "./i18n.ts";
/** 二进制消息类型：页面发给网关的文件分片（4 字节 kind + 4 字节传输 id + 数据）。 */
export const BIN_UPLOAD = 3;
export const UPLOAD_HEADER_BYTES = 8;
export const UPLOAD_CHUNK_BYTES = 256 * 1024;
/** 页面最多领先网关确认这么多字节：页面和网关手上压着的数据都不超过它。 */
export const UPLOAD_WINDOW_BYTES = 4 * UPLOAD_CHUNK_BYTES;
export const UPLOAD_MAX_BYTES = 2 * 1024 ** 3;
/** 非 APK 文件放到这里（设备里的「下载」文件夹）。 */
export const PUSH_DIR = "/sdcard/Download";

// Android 文件系统单个文件名上限 255 字节，留些余量
const NAME_MAX_BYTES = 200;
const UNSUPPORTED = [".xapk", ".apks", ".aab", ".apkm"];

/** 页面给的文件名只留最后一段，去掉控制字符、换掉 Android 存储不认的字符、限制长度；用不了时返回 null。 */
export function sanitizeFileName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? "";
  let name = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[:*?"<>|]/g, "_").trim();
  if (!name || /^\.+$/.test(name)) return null;
  if (utf8Bytes(name) > NAME_MAX_BYTES) {
    const dot = name.lastIndexOf(".");
    // 页面打包的 .app 要保住整个 .app.tar，网关靠它认出是 App
    const ext = name.toLowerCase().endsWith(APP_TAR_SUFFIX) ? name.slice(-APP_TAR_SUFFIX.length) : dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = cutToBytes(name.slice(0, name.length - ext.length), NAME_MAX_BYTES - utf8Bytes(ext)) + ext;
  }
  return name;
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).byteLength;

// 按码点截，不会拆开代理对
function cutToBytes(s: string, max: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const b = utf8Bytes(ch);
    if (bytes + b > max) break;
    out += ch;
    bytes += b;
  }
  return out;
}

export type FileKind = { kind: "apk" } | { kind: "file" } | { kind: "unsupported"; ext: string };

/** 页面把拖进来的 .app 文件夹打成 tar 传过来时，文件名后面加的后缀。 */
export const APP_TAR_SUFFIX = ".app.tar";

/** 按扩展名分：.apk 安装，几种 APK 包格式暂不支持，其他文件放进下载文件夹。 */
export function fileKind(name: string): FileKind {
  if (name.toLowerCase().endsWith(APP_TAR_SUFFIX)) return { kind: "unsupported", ext: ".app" };
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
  if (ext === ".apk") return { kind: "apk" };
  if (UNSUPPORTED.includes(ext)) return { kind: "unsupported", ext };
  return { kind: "file" };
}

/** iOS 模拟器上拖了不是 App 的东西时的提示。 */
export const IOS_ONLY_APPS_MSG: Msg = {
  en: "iOS simulators only install apps: drop a .app folder, or a .zip / .ipa that holds one",
  zh: "iOS 模拟器只能装 App：拖 .app 文件夹，或装着 .app 的 .zip / .ipa",
};
/** IOS_ONLY_APPS_MSG 的中文。 */
export const IOS_ONLY_APPS = IOS_ONLY_APPS_MSG.zh;

export type IosFileKind = { kind: "ios-app"; format: "tar" | "zip" } | { kind: "unsupported" };

/** iOS 模拟器只装 App：页面打包的 .app 是 tar，.zip / .ipa（里面装着 .app）用 zip 解。 */
export function iosFileKind(name: string): IosFileKind {
  const lower = name.toLowerCase();
  if (lower.endsWith(APP_TAR_SUFFIX)) return { kind: "ios-app", format: "tar" };
  if (lower.endsWith(".zip") || lower.endsWith(".ipa")) return { kind: "ios-app", format: "zip" };
  return { kind: "unsupported" };
}

const HINT: Record<string, Msg> = {
  INSTALL_FAILED_VERSION_DOWNGRADE: { en: "A newer version is already installed on the device; uninstall it first", zh: "设备上已装了更高的版本，先卸载再装" },
  INSTALL_FAILED_UPDATE_INCOMPATIBLE: { en: "The signature differs from the version on the device; uninstall it first", zh: "签名和设备上已装的不同，先卸载再装" },
  INSTALL_FAILED_INSUFFICIENT_STORAGE: { en: "Not enough storage on the emulator", zh: "模拟器存储空间不足" },
  INSTALL_FAILED_NO_MATCHING_ABIS: { en: "The APK does not support arm64 and cannot be installed on this emulator", zh: "APK 不支持 arm64，装不到这台模拟器上" },
  INSTALL_FAILED_OLDER_SDK: { en: "The APK needs a newer Android version than this emulator has", zh: "APK 要求的 Android 版本比这台模拟器高" },
  INSTALL_FAILED_DEPRECATED_SDK_VERSION: { en: "The APK's targetSdk is below 23; Android 14 and later refuse to install it", zh: "APK 的 targetSdk 低于 23，Android 14 起不让装" },
};
const PARSE_FAILED: Msg = { en: "The APK file is damaged or not a valid APK", zh: "APK 文件损坏或不是有效的 APK" };

/** 把 adb install / push 的失败输出变成一句给人看的话（两种语言）：认得的失败码带说明。 */
export function installFailure(output: string): { code?: string; text: Msg } {
  const code = /\b(INSTALL_(?:PARSE_)?FAILED_[A-Z0-9_]+)/.exec(output)?.[1];
  if (code) {
    const hint = HINT[code] ?? (code.startsWith("INSTALL_PARSE_FAILED_") ? PARSE_FAILED : undefined);
    return { code, text: hint ? { en: `${code} (${hint.en})`, zh: `${code}（${hint.zh}）` } : msgOf(code) };
  }
  const last = output.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return { text: last ? msgOf(last.slice(0, 300)) : { en: "Unknown reason", zh: "未知原因" } };
}

/** 发送方还能不能再发一片：没发完，且领先确认不到一个窗口。 */
export function canSendChunk(t: { sent: number; acked: number; size: number }): boolean {
  return t.sent < t.size && t.sent - t.acked < UPLOAD_WINDOW_BYTES;
}

/** 从 sent 开始的下一片。 */
export function nextChunk(sent: number, size: number): { start: number; end: number } {
  return { start: sent, end: Math.min(size, sent + UPLOAD_CHUNK_BYTES) };
}

export function encodeUploadChunk(id: number, data: Uint8Array): Uint8Array {
  const buf = new Uint8Array(UPLOAD_HEADER_BYTES + data.byteLength);
  const view = new DataView(buf.buffer);
  view.setUint32(0, BIN_UPLOAD, true);
  view.setUint32(4, id >>> 0, true);
  buf.set(data, UPLOAD_HEADER_BYTES);
  return buf;
}

/** 解出分片；太短返回 null。不检查 kind，调用方先用 binKind 分流。 */
export function decodeUploadChunk(buf: Uint8Array): { id: number; data: Uint8Array } | null {
  if (buf.byteLength < UPLOAD_HEADER_BYTES) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { id: view.getUint32(4, true), data: buf.subarray(UPLOAD_HEADER_BYTES) };
}

/**
 * 网关收到一片时检查：arrived 是已收到（含还没写完）的字节，written 是已写进文件的。
 * 返回拒绝的原因；没问题返回 null。
 */
export function checkChunk(t: { id: number; size: number; arrived: number; written: number }, id: number, len: number): Msg | null {
  if (id !== t.id) return { en: "Wrong transfer ID", zh: "传输编号不对" };
  if (len === 0) return { en: "Empty chunk", zh: "空分片" };
  if (len > UPLOAD_CHUNK_BYTES) return { en: "Chunk too large", zh: "分片太大" };
  if (t.arrived + len > t.size) return { en: "Received more data than the file size", zh: "收到的数据超过了文件大小" };
  if (t.arrived - t.written + len > 2 * UPLOAD_WINDOW_BYTES) return { en: "The page sent data too fast without waiting for the gateway", zh: "页面发得太快，没有等网关确认" };
  return null;
}
