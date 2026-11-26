// 真机会话：把随包的 scrcpy-server 推到手机上跑，从它的视频连接取 H.264 画面，输入和剪贴板走它的控制连接
import type { Duplex } from "node:stream";
import type { DeviceCaps, Rotation } from "../../shared/protocol.ts";
import type { AdbStream, AdbStreamHandlers } from "./adb.ts";
import type { DeviceSession, VideoPacket } from "./emulator.ts";
import { androidKeycode } from "../../shared/android-keys.ts";
import { toVideo } from "../../shared/input-map.ts";
import {
  createDeviceMessageParser,
  createVideoParser,
  injectKeycode,
  injectScroll,
  injectText,
  injectTouch,
  randomScid,
  RESET_VIDEO,
  serverArgs,
  setClipboard,
} from "./scrcpy.ts";
import { SCRCPY_VERSION } from "./scrcpy-server.ts";
import { TextError } from "../../shared/i18n.ts";

/** 推到手机上的位置；服务端带 cleanup=true，退出时自己删掉。 */
const REMOTE_JAR = `/data/local/tmp/droidpier-scrcpy-${SCRCPY_VERSION}.jar`;

/** 真机转屏跟随手机，重启、关机还不支持（docs/superpowers/plans/2026-11-16-real-device-pr4-input.md）。 */
const PHONE_CAPS: DeviceCaps = { rotate: false, reboot: true, stop: false, clipboard: true, input: true, scroll: true };

/** 服务端起来之前 adb forward 照样接受连接、随后关掉；这么久收不到数据就算连不上。 */
const CONNECT_TIMEOUT_MS = 5000;
const RETRY_MS = 100;
/**
 * 请求关键帧的最短间隔：每个新订阅者、每次积压都会请求，窗口内的合并成一次、窗口结束时补发。
 * 不能直接丢：转屏时页面连着改几次尺寸、每次都重新订阅，丢掉最后一次的话屏幕静止时 scrcpy 不会自己出关键帧，画面就一直停住
 * （2026-11-16 SM-G9910 实测）。
 */
const KEY_REQUEST_GAP_MS = 200;
/**
 * 两次「写剪贴板 + 粘贴」之间的最短间隔：服务端异步注入粘贴键，App 处理它时才读剪贴板，
 * 下一段文字写得太快会先把剪贴板盖掉（2026-11-16 SM-G9910 实测连发 4 个汉字粘出 4 个最后一个字）。
 */
export const PASTE_GAP_MS = 100;
/** 滚轮多少 CSS 像素算 scrcpy 的 1 个滚动单位：按「一格滚轮约 100px」估的，真机验收时按手感调。 */
const PX_PER_SCROLL = 100;

export type PhoneDeps = {
  /** 落盘后的 jar 路径（gateway/src/scrcpy-server.ts 的 materializeScrcpyServer）。 */
  jarPath(): Promise<string>;
  push(local: string, remote: string): Promise<void>;
  freePort(): Promise<number>;
  releasePort(port: number): void;
  forward(port: number, scid: string): Promise<void>;
  removeForward(port: number): Promise<void>;
  /** 用 adb shell 跑服务端，长进程（adb.stream）。 */
  startServer(cmd: string, h: AdbStreamHandlers): AdbStream;
  connect(port: number): Promise<Duplex>;
  /** adb exec-out screencap -p 的 PNG。 */
  screencap(): Promise<Buffer>;
  /** adb reboot：手机断开后视频连接结束，会话照常关闭；重连由网关的重启流程负责（gateway/src/server.ts 的 reboot）。 */
  reboot(): Promise<void>;
  now?(): number;
  connectTimeoutMs?: number;
  log?(s: string): void;
};

const unsupported = () => Promise.reject(new TextError({ en: "This device does not support this action", zh: "这台设备不支持这个操作" }));

/** 等这条连接的第一块数据；收到之前就断了、或等满 waitMs，返回 null（服务端还没监听）。 */
function firstData(s: Duplex, waitMs: number): Promise<Buffer | null> {
  return new Promise((res) => {
    const timer = setTimeout(() => done(null), waitMs);
    const done = (v: Buffer | null) => {
      clearTimeout(timer);
      s.off("data", onData);
      s.off("close", onGone);
      s.off("end", onGone);
      s.off("error", onGone);
      res(v);
    };
    const onData = (b: Buffer) => {
      s.pause();
      done(b);
    };
    const onGone = () => done(null);
    s.on("data", onData);
    s.once("close", onGone);
    s.once("end", onGone);
    s.once("error", onGone);
  });
}

export async function connectPhone(id: string, deps: PhoneDeps): Promise<DeviceSession> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((s: string) => console.log(s));
  const timeoutMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;

  const subs = new Set<(p: VideoPacket) => void>();
  const rotationCbs: Array<(r: Rotation) => void> = [];
  const closedCbs: Array<() => void> = [];
  let size = { width: 0, height: 0 };
  let lastConfig: VideoPacket | null = null;
  let lastKeyRequest = -Infinity;
  let keyRequestTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let port: number | null = null;
  let server: AdbStream | null = null;
  let video: Duplex | null = null;
  let control: Duplex | null = null;
  let onFirstSession: (() => void) | null = null;
  // 手指是否按着、最后一点（竖屏面板像素）：页面每次移动都发 down=true，按下 / 移动 / 抬起由这里分
  let pressed = false;
  // 转屏时替用户抬起了手指：页面要过一会儿才知道新方向，这期间的坐标按旧方向算，等用户真松手前都不发
  let liftedByRotation = false;
  let lastTouch = { x: 0, y: 0 };
  let clipboard = "";
  let lastPasteAt = -Infinity;
  const clipCbs: Array<(text: string) => void> = [];

  const rotationOf = (w: number, h: number): Rotation => (w > h ? 90 : 0);
  const close = (why: string) => {
    if (closed) return;
    closed = true;
    clearTimeout(keyRequestTimer);
    log(`${id} 的画面连接结束：${why}`);
    server?.stop();
    video?.destroy();
    control?.destroy();
    if (port !== null) {
      const p = port;
      deps.removeForward(p).catch((e: Error) => log(`移除 adb forward 失败：${e.message}`)).finally(() => deps.releasePort(p));
    }
    for (const cb of closedCbs) cb();
  };

  // 会话关了或控制连接还没连上时，输入直接丢掉
  const send = (b: Buffer) => {
    if (!closed && control) control.write(b);
  };
  const videoPoint = (x: number, y: number) => toVideo({ x, y }, session.device, session.rotation, size);
  // server.ts 按连接把输入排成队、一条完成再发下一条，所以这里等着，后面的按键、触摸也跟着排在粘贴之后
  const writeClipboard = async (text: string, paste: boolean) => {
    const b = setClipboard(text, paste);
    if (closed || !control) return;
    if (paste) {
      const wait = lastPasteAt + PASTE_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastPasteAt = Date.now();
    }
    clipboard = text;
    send(b);
  };

  const session: DeviceSession = {
    kind: "phone",
    caps: PHONE_CAPS,
    id,
    serial: 0,
    avdName: undefined,
    device: { width: 0, height: 0 },
    rotation: 0,
    frames: () => () => {},
    video(onPacket) {
      subs.add(onPacket);
      if (lastConfig) onPacket(lastConfig);
      return () => void subs.delete(onPacket);
    },
    requestKeyFrame() {
      if (closed || !control || keyRequestTimer) return;
      const write = () => {
        lastKeyRequest = now();
        control?.write(RESET_VIDEO);
      };
      const wait = lastKeyRequest + KEY_REQUEST_GAP_MS - now();
      if (wait <= 0) return write();
      keyRequestTimer = setTimeout(() => {
        keyRequestTimer = undefined;
        if (!closed) write();
      }, wait);
    },
    async touch(x, y, down) {
      if (liftedByRotation) {
        if (!down) liftedByRotation = false;
        return;
      }
      if (!down && !pressed) return;
      const action = !down ? 1 : pressed ? 2 : 0;
      pressed = down;
      lastTouch = { x, y };
      const p = videoPoint(x, y);
      send(injectTouch(action, p.x, p.y, size));
    },
    async key(key, eventType) {
      const code = androidKeycode(key);
      if (code === null) {
        // 页面把单个可打印 ASCII 字符作为 keypress 发来，按字符注入
        if (eventType === "keypress" && [...key].length === 1) return send(injectText(key));
        throw new TextError({ en: `Unknown key: ${key}`, zh: `不认识的按键：${key}` });
      }
      if (eventType !== "keyup") send(injectKeycode(0, code));
      if (eventType !== "keydown") send(injectKeycode(1, code));
    },
    // 和模拟器一样写剪贴板再粘贴（取舍 1）：会覆盖手机剪贴板；粘贴键要 Android 7+
    text: (text) => writeClipboard(text, true),
    setClipboard: (text) => writeClipboard(text, false),
    getClipboard: async () => clipboard,
    onClipboard: (cb) => void clipCbs.push(cb),
    async scroll(x, y, dx, dy) {
      const p = videoPoint(x, y);
      // 浏览器 deltaY 正值往下滚，Android AXIS_VSCROLL 正值往上滚
      send(injectScroll(p.x, p.y, size, dx / PX_PER_SCROLL, -dy / PX_PER_SCROLL));
    },
    rotate: unsupported,
    reboot: () => deps.reboot(),
    screenshot: () => deps.screencap(),
    onRotation: (cb) => void rotationCbs.push(cb),
    onClosed: (cb) => void closedCbs.push(cb),
    close: () => close("网关关闭了会话"),
  };

  const parser = createVideoParser((e) => {
    if (e.kind === "meta") log(`已连接 ${id}（${e.name}）`);
    else if (e.kind === "session") {
      const before = { rotation: session.rotation, ...size };
      size = { width: e.width, height: e.height };
      session.device = { width: Math.min(e.width, e.height), height: Math.max(e.width, e.height) };
      session.rotation = rotationOf(e.width, e.height);
      // 按着时尺寸变了，之后带新尺寸的移动 / 抬起和按下对不上，手机上会留一根一直按着的手指：用新尺寸先抬起
      if (pressed && (size.width !== before.width || size.height !== before.height)) {
        pressed = false;
        liftedByRotation = true;
        const p = videoPoint(lastTouch.x, lastTouch.y);
        send(injectTouch(1, p.x, p.y, size));
      }
      if (onFirstSession) {
        const f = onFirstSession;
        onFirstSession = null;
        f();
      } else if (session.rotation !== before.rotation) for (const cb of rotationCbs) cb(session.rotation);
    } else if (e.kind === "packet") {
      const p: VideoPacket = { config: e.config, key: e.key, data: e.data, width: size.width, height: size.height };
      if (p.config) lastConfig = p;
      for (const cb of subs) cb(p);
    }
  });

  try {
    const jar = await deps.jarPath();
    await deps.push(jar, REMOTE_JAR);
    port = await deps.freePort();
    const scid = randomScid();
    await deps.forward(port, scid);
    server = deps.startServer(serverArgs(scid, REMOTE_JAR), {
      onData: () => {},
      onExit: (code) => close(`服务端退出（${code ?? "信号"}）`),
    });

    // 视频连接：收到第一块数据（含哑字节）才算服务端真的在听
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (closed) throw new TextError({ en: "The scrcpy server did not start", zh: "scrcpy 服务端没有起来" });
      const s = await deps.connect(port);
      const first = await firstData(s, Math.max(0, deadline - Date.now()));
      if (first) {
        video = s;
        parser.push(first);
        break;
      }
      s.destroy();
      if (Date.now() >= deadline) throw new TextError({ en: `Could not reach the scrcpy server on the phone within ${timeoutMs / 1000} seconds`, zh: `${timeoutMs / 1000} 秒内连不上手机上的 scrcpy 服务端` });
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
    // 设备名要等控制连接也连上后才发，所以先连控制再等会话包
    control = await deps.connect(port);
    // 服务端会往控制连接写设备消息（剪贴板等），不读走会堵住
    const deviceMessages = createDeviceMessageParser((m) => {
      if (m.kind !== "clipboard") return;
      clipboard = m.text;
      for (const cb of clipCbs) cb(m.text);
    });
    control.on("data", (b: Buffer) => {
      try {
        deviceMessages.push(b);
      } catch (e) {
        close(`控制连接出错：${(e as Error).message}`);
      }
    });
    control.once("close", () => close("控制连接断开"));
    control.once("error", () => close("控制连接出错"));
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;
    const firstSession = new Promise<void>((res, rej) => {
      onFirstSession = () => (clearTimeout(sessionTimer), res());
      sessionTimer = setTimeout(() => rej(new TextError({ en: `No screen size from scrcpy within ${timeoutMs / 1000} seconds`, zh: `${timeoutMs / 1000} 秒内没收到 scrcpy 的画面尺寸` })), timeoutMs);
    });
    video.on("data", (b: Buffer) => parser.push(b));
    video.once("close", () => close("视频连接断开"));
    video.once("end", () => close("视频连接断开"));
    video.once("error", () => close("视频连接出错"));
    video.resume();
    await firstSession;
    return session;
  } catch (e) {
    close((e as Error).message);
    throw e;
  }
}
