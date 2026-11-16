// 给一个页面连接发真机视频：H.264 的 P 帧依赖前面的帧，不能像 RGBA 那样只留最新一帧，只能整段丢到下一个关键帧
import { encodeVideoHeader } from "../../shared/protocol.ts";
import type { VideoPacket } from "./emulator.ts";

/** WebSocket 积压超过这么多就丢帧重来（2026-11-13 原型用的阈值，USB 真机 1920 长边下够用）。 */
const LIMIT_BYTES = 4 * 2 ** 20;

export function createVideoSender(o: { send(buf: Buffer): void; buffered(): number; requestKey(): void; limitBytes?: number }) {
  const limit = o.limitBytes ?? LIMIT_BYTES;
  // 刚订阅时没有可依赖的前序帧，等关键帧
  let waitingKey = true;
  // 积压时请求来的关键帧多半也落在积压里被丢了：积压清掉后要再请求一次，否则一直等到手机自己出关键帧
  let needKey = false;
  let seq = 0;
  let dropped = 0;
  const send = (p: VideoPacket) => {
    const h = encodeVideoHeader({ seq: seq++, config: p.config, key: p.key, width: p.width, height: p.height });
    o.send(Buffer.concat([h, p.data]));
  };
  return {
    push(p: VideoPacket) {
      // 配置包（SPS/PPS）很小，解码器换配置必须要它，总是发
      if (p.config) return send(p);
      if (o.buffered() > limit) {
        dropped++;
        if (!waitingKey) {
          waitingKey = true;
          o.requestKey();
        } else if (p.key) needKey = true;
        return;
      }
      if (needKey) {
        needKey = false;
        if (!p.key) o.requestKey();
      }
      if (waitingKey && !p.key) {
        dropped++;
        return;
      }
      waitingKey = false;
      send(p);
    },
    /** 页面从后台回来：之前的帧已经断档，重新等关键帧。 */
    reset() {
      waitingKey = true;
      o.requestKey();
    },
    dropped: () => dropped,
  };
}
