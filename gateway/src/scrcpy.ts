// scrcpy-server v5.0.1 的连接协议（纯函数）。格式以 docs/superpowers/specs/2026-11-13-real-device-design.md 的「原型实测」为准
import { randomInt } from "node:crypto";
import { SCRCPY_VERSION } from "./scrcpy-server.ts";

/** 画面长边：原型实测 864x1920 / 55 fps；这一版不按页面尺寸重启服务端（docs/superpowers/plans/2026-11-16-real-device-pr3-video.md 取舍 2）。 */
const MAX_SIZE = 1920;

/** 交给 adb shell 的整条启动命令。不要音频；剪贴板自动同步 v5.0.1 默认就开，写出来免得默认值变了。 */
export function serverArgs(scid: string, remoteJar: string): string {
  return `CLASSPATH=${remoteJar} app_process / com.genymobile.scrcpy.Server ${SCRCPY_VERSION} scid=${scid} log_level=info ` +
    `audio=false control=true clipboard_autosync=true tunnel_forward=true video_codec=h264 max_size=${MAX_SIZE} stay_awake=true power_on=true cleanup=true`;
}

/** 服务端按 16 进制解析 scid，负数会被拒绝；socket 名是 scrcpy_<8 位 16 进制>。 */
export function randomScid(): string {
  return randomInt(0, 0x7fffffff).toString(16).padStart(8, "0");
}

/** 控制连接上的「重置视频」：服务端重启编码器，随后发配置包和关键帧。 */
export const RESET_VIDEO = Buffer.from([17]);

export type VideoEvent =
  | { kind: "meta"; name: string }
  | { kind: "codec"; id: number }
  | { kind: "session"; width: number; height: number }
  | { kind: "packet"; config: boolean; key: boolean; data: Buffer };

const CONFIG_BIT = 1n << 62n;
const KEY_BIT = 1n << 61n;

/**
 * 视频连接的字节流：哑字节 → 64 字节设备名 → 4 字节编码 id → 循环（12 字节头 [+ 数据]）。
 * 头的最高位为 1 是会话包（flags、宽、高），否则是 pts|标记 + 长度，后面跟数据。任意切块喂入都行。
 */
export function createVideoParser(onEvent: (e: VideoEvent) => void): { push(chunk: Buffer): void } {
  let buf: Buffer = Buffer.alloc(0);
  let stage: "dummy" | "meta" | "codec" | "header" | "data" = "dummy";
  let pending: { config: boolean; key: boolean; size: number } | null = null;
  const need = (n: number) => buf.length >= n;
  const take = (n: number) => {
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (stage === "dummy") {
          if (!need(1)) return;
          take(1);
          stage = "meta";
        } else if (stage === "meta") {
          if (!need(64)) return;
          onEvent({ kind: "meta", name: take(64).toString("utf8").replace(/\0.*$/s, "") });
          stage = "codec";
        } else if (stage === "codec") {
          if (!need(4)) return;
          onEvent({ kind: "codec", id: take(4).readUInt32BE(0) });
          stage = "header";
        } else if (stage === "header") {
          if (!need(12)) return;
          const h = take(12);
          if (h[0] & 0x80) {
            onEvent({ kind: "session", width: h.readUInt32BE(4), height: h.readUInt32BE(8) });
            continue;
          }
          const ptsFlags = h.readBigUInt64BE(0);
          pending = { config: (ptsFlags & CONFIG_BIT) !== 0n, key: (ptsFlags & KEY_BIT) !== 0n, size: h.readUInt32BE(8) };
          stage = "data";
        } else {
          if (!need(pending!.size)) return;
          // 拷一份：buf 之后会被拼接复用，订阅者可能异步发送
          const data = Buffer.from(take(pending!.size));
          onEvent({ kind: "packet", config: pending!.config, key: pending!.key, data });
          pending = null;
          stage = "header";
        }
      }
    },
  };
}

// 控制连接上的消息（网关 → 手机）。格式以 v5.0.1 服务端 control/ControlMessageReader.java 为准，多字节整数大端

type VideoSize = { width: number; height: number };

/** 触摸动作：Android MotionEvent 的 ACTION_DOWN / ACTION_UP / ACTION_MOVE。 */
export type Action = 0 | 1 | 2;

/** scrcpy 的 POINTER_ID_GENERIC_FINGER：服务端按触摸屏事件注入。 */
const FINGER = -2n;

/** 按键：action 0 按下、1 抬起；repeat、meta 都是 0。 */
export function injectKeycode(action: 0 | 1, keycode: number): Buffer {
  const b = Buffer.alloc(14);
  b.writeUInt8(0, 0);
  b.writeUInt8(action, 1);
  b.writeInt32BE(keycode, 2);
  return b;
}

/** 按字符注入文字（服务端用 KeyCharacterMap 逐字转按键，键盘上打不出的字符会被跳过）。 */
export function injectText(text: string): Buffer {
  const t = Buffer.from(text, "utf8");
  const h = Buffer.alloc(5);
  h.writeUInt8(1, 0);
  h.writeUInt32BE(t.length, 1);
  return Buffer.concat([h, t]);
}

/** 触摸。x、y 是视频帧像素，video 必须等于服务端当前的视频尺寸，否则服务端丢掉这条（PositionMapper.map）。 */
export function injectTouch(action: Action, x: number, y: number, video: VideoSize): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt8(2, 0);
  b.writeUInt8(action, 1);
  b.writeBigInt64BE(FINGER, 2);
  b.writeInt32BE(x, 10);
  b.writeInt32BE(y, 14);
  b.writeUInt16BE(video.width, 18);
  b.writeUInt16BE(video.height, 20);
  b.writeUInt16BE(action === 1 ? 0 : 0xffff, 22);
  return b;
}

/** [-16, 16] 的滚动量 → i16 定点：服务端按 [-1, 1] 解码后再乘 16（ControlMessageReader.parseInjectScrollEvent）。 */
function scrollFixed(v: number): number {
  const n = Math.max(-16, Math.min(16, v)) / 16;
  if (n === 1) return 0x7fff;
  return Math.max(-0x8000, Math.min(0x7fff, Math.round(n * 0x8000)));
}

/** 滚动。坐标规则同 injectTouch；vscroll 正值往上滚、hscroll 正值往右滚（Android AXIS_VSCROLL / AXIS_HSCROLL）。 */
export function injectScroll(x: number, y: number, video: VideoSize, hscroll: number, vscroll: number): Buffer {
  const b = Buffer.alloc(21);
  b.writeUInt8(3, 0);
  b.writeInt32BE(x, 1);
  b.writeInt32BE(y, 5);
  b.writeUInt16BE(video.width, 9);
  b.writeUInt16BE(video.height, 11);
  b.writeInt16BE(scrollFixed(hscroll), 13);
  b.writeInt16BE(scrollFixed(vscroll), 15);
  return b;
}

/** 服务端单条消息上限 256KB，减去 1 字节类型、8 字节 sequence、1 字节 paste、4 字节长度；超了服务端抛异常，控制线程退出。 */
export const CLIPBOARD_MAX_BYTES = (1 << 18) - 14;

/** 写手机剪贴板；paste 为 true 时服务端再按一下粘贴键（Android 7+）。sequence 写 0，不要确认。 */
export function setClipboard(text: string, paste: boolean): Buffer {
  const t = Buffer.from(text, "utf8");
  if (t.length > CLIPBOARD_MAX_BYTES) throw new Error("文字太长，手机剪贴板最多约 256KB");
  const h = Buffer.alloc(14);
  h.writeUInt8(9, 0);
  h.writeUInt8(paste ? 1 : 0, 9);
  h.writeUInt32BE(t.length, 10);
  return Buffer.concat([h, t]);
}

export type DeviceEvent = { kind: "clipboard"; text: string } | { kind: "ack"; sequence: bigint };

/**
 * 控制连接上的设备消息（手机 → 网关，control/DeviceMessageWriter.java）：剪贴板 [0][len u32][utf8]、
 * 剪贴板确认 [1][sequence u64]、UHID 输出 [2][id u16][len u16][data]（跳过）。任意切块喂入；未知类型抛错。
 */
export function createDeviceMessageParser(onEvent: (e: DeviceEvent) => void): { push(chunk: Buffer): void } {
  let buf: Buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (buf.length < 1) return;
        const type = buf.readUInt8(0);
        if (type === 0) {
          if (buf.length < 5) return;
          const len = buf.readUInt32BE(1);
          if (buf.length < 5 + len) return;
          const text = buf.subarray(5, 5 + len).toString("utf8");
          buf = buf.subarray(5 + len);
          onEvent({ kind: "clipboard", text });
        } else if (type === 1) {
          if (buf.length < 9) return;
          const sequence = buf.readBigUInt64BE(1);
          buf = buf.subarray(9);
          onEvent({ kind: "ack", sequence });
        } else if (type === 2) {
          if (buf.length < 5) return;
          const len = buf.readUInt16BE(3);
          if (buf.length < 5 + len) return;
          buf = buf.subarray(5 + len);
        } else throw new Error(`未知的设备消息类型 ${type}`);
      }
    },
  };
}
