import { execFile, spawn, type ChildProcess } from "node:child_process";
import { ADB_UNRESPONSIVE } from "../../shared/protocol.ts";
import { adbBin } from "./platform.ts";

/** 短命令（排在设备队列里的）一次 adb 调用的超时；long 队列的超时由调用方给。 */
export const ADB_TIMEOUT_MS = 5000;

/** 同一台设备连续这么多次短命令超时，就让 adb server 重连它一次。 */
const RECONNECT_AFTER = 2;
/** 两次自动重连至少隔这么久：重连没用时不反复折腾，等用户重启模拟器。 */
const RECONNECT_COOLDOWN_MS = 30_000;

/** adb 调用超时：设备里的 adbd 多半卡住了。 */
export class AdbUnresponsive extends Error {
  constructor() {
    super(ADB_UNRESPONSIVE);
    this.name = "AdbUnresponsive";
  }
}

// 还在跑的 adb 进程：网关退出时一起结束，卡在 adbd 上的不能留成孤儿
const children = new Set<ChildProcess>();

/** 结束所有还在跑的 adb 进程。同步，可以在 process 的 exit 事件里调用。 */
export function killAdbChildren(): void {
  for (const c of children) c.kill("SIGKILL");
}

/**
 * 跑一次 adb。超时用 SIGKILL 结束并记日志，归类为 AdbUnresponsive；其他失败原样抛。
 * execFile 默认只发 SIGTERM，进程不理它时回调要等它自己退出，所以显式用 SIGKILL。
 */
export function execAdb(bin: string, args: string[], timeoutMs: number, log: (s: string) => void): Promise<string> {
  return new Promise((res, rej) => {
    const child = execFile(bin, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 2 ** 20 }, (e, stdout) => {
      children.delete(child);
      if (!e) return res(stdout);
      if ((e as { killed?: boolean }).killed) {
        log(`adb ${args.join(" ")} 超过 ${timeoutMs / 1000} 秒没返回，已用 SIGKILL 结束`);
        return rej(new AdbUnresponsive());
      }
      rej(e);
    });
    children.add(child);
  });
}

/** 同 execAdb，但输出按原始字节返回（screencap 的 PNG 不能当字符串解码）。 */
export function execAdbBuffer(bin: string, args: string[], timeoutMs: number, log: (s: string) => void): Promise<Buffer> {
  return new Promise((res, rej) => {
    const child = execFile(bin, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 32 * 2 ** 20, encoding: "buffer" }, (e, stdout) => {
      children.delete(child);
      if (!e) return res(stdout);
      if ((e as { killed?: boolean }).killed) {
        log(`adb ${args.join(" ")} 超过 ${timeoutMs / 1000} 秒没返回，已用 SIGKILL 结束`);
        return rej(new AdbUnresponsive());
      }
      rej(e);
    });
    children.add(child);
  });
}

export type AdbStream = { stop(): void };
export type AdbStreamHandlers = { onData(chunk: string): void; onExit(code: number | null): void };

/**
 * 跑一条长期运行的 adb（track-devices、logcat）：不进设备队列、没有总超时，输出边到边交给 onData。
 * 进程登记在 children 里，网关退出时由 killAdbChildren 一起结束。
 */
export function streamAdb(bin: string, args: string[], h: AdbStreamHandlers): AdbStream {
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
  children.add(child);
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (s: string) => h.onData(s));
  child.once("error", () => {});
  child.once("close", (code) => {
    children.delete(child);
    h.onExit(code);
  });
  return { stop: () => void child.kill("SIGTERM") };
}

/**
 * adb 调用入口。带 `-s <设备>` 的命令按设备排队，同一台设备同一时间只有一个 adb 进程在跑；
 * 不带 -s 的（forward --list、devices）只找本机 adb server，不排队。
 * 装 APK、传文件要几分钟，走 long 这条单独的队列：不挡住 H5 列表这类短命令，长任务之间仍一次一个。
 */
export function createAdb(opts: { exec?: (args: string[], timeoutMs?: number) => Promise<string>; stream?: (args: string[], h: AdbStreamHandlers) => AdbStream; execBuffer?: (args: string[], timeoutMs?: number) => Promise<Buffer>; timeoutMs?: number; log?: (s: string) => void; now?: () => number } = {}) {
  const log = opts.log ?? ((s: string) => console.log(s));
  const exec = opts.exec ?? ((args: string[], timeoutMs?: number) => execAdb(adbBin(), args, timeoutMs ?? opts.timeoutMs ?? ADB_TIMEOUT_MS, log));
  const execBuffer = opts.execBuffer ?? ((args: string[], timeoutMs?: number) => execAdbBuffer(adbBin(), args, timeoutMs ?? opts.timeoutMs ?? ADB_TIMEOUT_MS, log));
  const now = opts.now ?? Date.now;
  const tails = new Map<string, Promise<unknown>>();
  // 设备 → 连续超时次数和上次自动重连的时间
  const stuck = new Map<string, { count: number; reconnectedAt: number }>();
  // 设备 → 重连完成后要通知的：adb server 断开设备时会撤掉它的 forward / reverse，缓存了它们的模块得忘掉
  const reconnectListeners = new Map<string, Set<() => void>>();

  /**
   * 模拟器的短命令连续超时时让 adb server 重连它：模拟器里的 adbd 卡住后，adb reconnect 常常就能恢复，不用重启模拟器
   * （2026-11-16 实测一次，同一时间页面也点了重启，没能单独确认）。重连不排队：排在卡住的命令后面就没意义了。
   * 真机不自动重连：USB 慢时超时更常见，重连会打断投屏和正在传的文件。
   */
  function watch<T>(id: string, p: Promise<T>): Promise<T> {
    return p.then(
      (v) => {
        // 只清计数，冷却照旧：adbd 时好时坏时也不能每隔几秒就重连一次
        const s = stuck.get(id);
        if (s) s.count = 0;
        return v;
      },
      (e) => {
        if (!(e instanceof AdbUnresponsive) || !id.startsWith("emulator-")) throw e;
        const s = stuck.get(id) ?? { count: 0, reconnectedAt: -Infinity };
        s.count++;
        stuck.set(id, s);
        if (s.count >= RECONNECT_AFTER && now() - s.reconnectedAt >= RECONNECT_COOLDOWN_MS) {
          s.count = 0;
          s.reconnectedAt = now();
          log(`${id} 的 adb 连续没有响应，执行 adb reconnect`);
          exec(["-s", id, "reconnect"]).then(
            () => { for (const f of reconnectListeners.get(id) ?? []) f(); },
            (err: Error) => log(`adb reconnect ${id} 失败：${err.message}`),
          );
        }
        throw e;
      },
    );
  }

  function queued<T>(key: string, job: () => Promise<T>): Promise<T> {
    const p = (tails.get(key) ?? Promise.resolve()).then(job);
    const tail = p.catch(() => {});
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return p;
  }

  function run(args: string[]): Promise<string> {
    if (args[0] !== "-s" || !args[1]) return exec(args);
    return watch(args[1], queued(args[1], () => exec(args)));
  }

  return {
    run,
    /** 自动重连这台设备之后调 f（见 watch）；返回取消订阅。 */
    onReconnect(id: string, f: () => void): () => void {
      const set = reconnectListeners.get(id) ?? new Set();
      set.add(f);
      reconnectListeners.set(id, set);
      return () => {
        set.delete(f);
        if (!set.size && reconnectListeners.get(id) === set) reconnectListeners.delete(id);
      };
    },
    /** 长期运行的 adb，见 streamAdb。 */
    stream: opts.stream ?? ((args: string[], h: AdbStreamHandlers) => streamAdb(adbBin(), args, h)),
    /** 这台设备上的 adb：参数是 `adb -s <设备 id>` 之后的部分。 */
    device: (id: string) => (args: string[]) => run(["-s", id, ...args]),
    /** 这台设备上输出是二进制的短命令（exec-out screencap -p），和 device 排同一条队列。 */
    deviceBuffer: (id: string) => (args: string[], timeoutMs?: number) => watch(id, queued(id, () => execBuffer(["-s", id, ...args], timeoutMs))),
    /** 这台设备上的长任务（install、push），超时由调用方给。 */
    long: (id: string) => (args: string[], timeoutMs: number) => {
      const full = ["-s", id, ...args];
      return queued(`long:${id}`, () => exec(full, timeoutMs));
    },
  };
}

/** 模拟器在 adb 里的设备 id：emulator-<控制台端口>。网关里只在这里拼这个前缀。 */
export function emulatorId(serial: number): string {
  return `emulator-${serial}`;
}

/** 网关进程里唯一的 adb 入口：所有模块共用同一组设备队列。 */
export const adb = createAdb();
