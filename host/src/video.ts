// 真机视频（BIN_VIDEO）的解码：配置包里的 SPS/PPS 拼在关键帧前，交给 WebCodecs。做法见 docs/superpowers/specs/2026-11-13-real-device-design.md「原型实测」
import type { VideoHeader } from "../../shared/protocol.ts";

/** 解码队列积压超过这么多就丢 P 帧，等下一个关键帧追上（2026-11-13 原型取值）。 */
const MAX_QUEUE = 8;

/** 从 Annex B 码流里找 SPS（NAL 类型 7），取 profile / constraint / level 拼成 WebCodecs 的 codec 串。 */
export function codecFromSps(annexB: Uint8Array): string {
  for (let i = 0; i + 6 < annexB.length; i++) {
    if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1 && (annexB[i + 3] & 0x1f) === 7) {
      const hex = (n: number) => n.toString(16).padStart(2, "0");
      return `avc1.${hex(annexB[i + 4])}${hex(annexB[i + 5])}${hex(annexB[i + 6])}`;
    }
  }
  return "avc1.42001f";
}

export type Decoder = { decode(key: boolean, data: Uint8Array): void; close(): void; queueSize(): number };

/**
 * 按包到达顺序喂解码器：配置包换解码器，换完等关键帧；关键帧前拼上配置包。
 * 解码器出错（坏包、硬件解码器被回收）后就不能再用了：丢掉它并调用 requestRestart，让网关重发配置包和关键帧。
 */
export function createVideoPipe(o: { makeDecoder(codec: string, onError: () => void): Decoder; requestRestart?(): void }) {
  let decoder: Decoder | null = null;
  let config: Uint8Array | null = null;
  let gotKey = false;
  return {
    push(h: VideoHeader, data: Uint8Array) {
      if (h.config) {
        config = data.slice();
        decoder?.close();
        const d: Decoder = o.makeDecoder(codecFromSps(config), () => {
          if (decoder !== d) return;
          d.close();
          decoder = null;
          o.requestRestart?.();
        });
        decoder = d;
        gotKey = false;
        return;
      }
      if (!decoder) return;
      if (!h.key) {
        if (!gotKey) return;
        // 后面的 P 帧都引用这一帧，丢了就得一直等到下一个关键帧，否则花屏
        if (decoder.queueSize() > MAX_QUEUE) {
          gotKey = false;
          return;
        }
      }
      if (h.key) gotKey = true;
      let payload = data;
      if (h.key && config) {
        payload = new Uint8Array(config.length + data.length);
        payload.set(config);
        payload.set(data, config.length);
      }
      decoder.decode(h.key, payload);
    },
    close() {
      decoder?.close();
      decoder = null;
    },
  };
}

/** WebCodecs 的薄封装：不传 description，按 Annex B 解码；只在浏览器里用。 */
export function webCodecsDecoder(codec: string, onFrame: (f: VideoFrame) => void, onError: (e: Error) => void): Decoder {
  const d = new VideoDecoder({ output: onFrame, error: (e) => onError(e instanceof Error ? e : new Error(String(e))) });
  d.configure({ codec, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
  // 时间戳只用来让解码器保持顺序，不参与延迟计算
  let ts = 0;
  return {
    decode(key, data) {
      if (d.state !== "configured") return;
      d.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: ts++, data }));
    },
    close() {
      if (d.state !== "closed") d.close();
    },
    queueSize: () => d.decodeQueueSize,
  };
}
