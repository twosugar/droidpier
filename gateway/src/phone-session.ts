// 真机会话：把随包的 scrcpy-server 推到手机上跑，从它的视频连接取 H.264 画面。输入和剪贴板是 PR 4
import type { Duplex } from "node:stream";
import type { DeviceCaps, Rotation } from "../../shared/protocol.ts";
import type { AdbStream, AdbStreamHandlers } from "./adb.ts";
import type { DeviceSession, VideoPacket } from "./emulator.ts";
import { createVideoParser, randomScid, RESET_VIDEO, serverArgs } from "./scrcpy.ts";
import { SCRCPY_VERSION } from "./scrcpy-server.ts";

/** 推到手机上的位置；服务端带 cleanup=true，退出时自己删掉。 */
const REMOTE_JAR = `/data/local/tmp/droidpier-scrcpy-${SCRCPY_VERSION}.jar`;

/** 这一版真机只能看画面（docs/superpowers/plans/2026-11-16-real-device-pr3-video.md 取舍 5）。 */
const PHONE_CAPS: DeviceCaps = { rotate: false, reboot: false, stop: false, clipboard: false, input: false };

/** 服务端起来之前 adb forward 照样接受连接、随后关掉；这么久收不到数据就算连不上。 */
const CONNECT_TIMEOUT_MS = 5000;
const RETRY_MS = 100;
/** 请求关键帧的最短间隔：每个新订阅者、每次积压都会请求，合并成一次。 */
const KEY_REQUEST_GAP_MS = 200;

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
  now?(): number;
  connectTimeoutMs?: number;
  log?(s: string): void;
};

const unsupported = () => Promise.reject(new Error("这台设备不支持这个操作"));

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
  let closed = false;
  let port: number | null = null;
  let server: AdbStream | null = null;
  let video: Duplex | null = null;
  let control: Duplex | null = null;
  let onFirstSession: (() => void) | null = null;

  const rotationOf = (w: number, h: number): Rotation => (w > h ? 90 : 0);
  const close = (why: string) => {
    if (closed) return;
    closed = true;
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
      if (closed || !control || now() - lastKeyRequest < KEY_REQUEST_GAP_MS) return;
      lastKeyRequest = now();
      control.write(RESET_VIDEO);
    },
    // 输入和剪贴板是 PR 4：先收下不做事，页面不会因此报错
    touch: async () => {},
    key: async () => {},
    text: async () => {},
    setClipboard: async () => {},
    getClipboard: async () => "",
    onClipboard: () => {},
    rotate: unsupported,
    reboot: unsupported,
    screenshot: () => deps.screencap(),
    onRotation: (cb) => void rotationCbs.push(cb),
    onClosed: (cb) => void closedCbs.push(cb),
    close: () => close("网关关闭了会话"),
  };

  const parser = createVideoParser((e) => {
    if (e.kind === "meta") log(`已连接 ${id}（${e.name}）`);
    else if (e.kind === "session") {
      const before = session.rotation;
      size = { width: e.width, height: e.height };
      session.device = { width: Math.min(e.width, e.height), height: Math.max(e.width, e.height) };
      session.rotation = rotationOf(e.width, e.height);
      if (onFirstSession) {
        const f = onFirstSession;
        onFirstSession = null;
        f();
      } else if (session.rotation !== before) for (const cb of rotationCbs) cb(session.rotation);
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
      if (closed) throw new Error("scrcpy 服务端没有起来");
      const s = await deps.connect(port);
      const first = await firstData(s, Math.max(0, deadline - Date.now()));
      if (first) {
        video = s;
        parser.push(first);
        break;
      }
      s.destroy();
      if (Date.now() >= deadline) throw new Error(`${timeoutMs / 1000} 秒内连不上手机上的 scrcpy 服务端`);
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
    // 设备名要等控制连接也连上后才发，所以先连控制再等会话包
    control = await deps.connect(port);
    // 服务端会往控制连接写设备消息（剪贴板等），不读走会堵住；这一版丢弃
    control.on("data", () => {});
    control.once("close", () => close("控制连接断开"));
    control.once("error", () => close("控制连接出错"));
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;
    const firstSession = new Promise<void>((res, rej) => {
      onFirstSession = () => (clearTimeout(sessionTimer), res());
      sessionTimer = setTimeout(() => rej(new Error(`${timeoutMs / 1000} 秒内没收到 scrcpy 的画面尺寸`)), timeoutMs);
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
