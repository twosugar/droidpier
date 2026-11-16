// scrcpy-server v5.0.1 的连接协议（纯函数）。格式以 docs/superpowers/specs/2026-11-13-real-device-design.md 的「原型实测」为准
import { randomInt } from "node:crypto";
import { SCRCPY_VERSION } from "./scrcpy-server.ts";

/** 画面长边：原型实测 864x1920 / 55 fps；这一版不按页面尺寸重启服务端（docs/superpowers/plans/2026-11-16-real-device-pr3-video.md 取舍 2）。 */
const MAX_SIZE = 1920;

/** 交给 adb shell 的整条启动命令。剪贴板、音频这一版不开。 */
export function serverArgs(scid: string, remoteJar: string): string {
  return `CLASSPATH=${remoteJar} app_process / com.genymobile.scrcpy.Server ${SCRCPY_VERSION} scid=${scid} log_level=info ` +
    `audio=false control=true tunnel_forward=true video_codec=h264 max_size=${MAX_SIZE} stay_awake=true power_on=true cleanup=true`;
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
