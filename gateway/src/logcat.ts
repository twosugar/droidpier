// 日志面板的网关一侧：每台设备一个 adb logcat 进程，有页面订阅才运行；按每个订阅者的过滤条件合批推给页面
// （docs/superpowers/specs/2026-11-13-real-device-design.md 6.2「logcat」）
import { matchLog, parseLogcatLine, type LogFilter, type LogLine } from "../../shared/logcat.ts";
import type { AdbStream, AdbStreamHandlers } from "./adb.ts";

/** 合批间隔：刷屏时一行一条消息会把页面拖垮（spec 6.2 定的数值）。 */
const BATCH_MS = 100;
/** 每台设备留多少行给打开面板、改过滤条件时回放（spec 6.2「例如 5 万行」）。 */
const KEEP = 50_000;
/** 一次回放最多给页面多少行，免得一条消息太大（docs/superpowers/plans/2026-11-16-real-device-pr5-logcat.md 取舍 2）。 */
const REPLAY = 5_000;
/** 按 App 过滤时多久重查一次 pid（App 重启后 pid 会变）。 */
const PID_REFRESH_MS = 3_000;
/** 进程意外退出（拔线、adb 被杀）后的重启间隔，超出序列就一直用最后一个。 */
const RESTART_MS = [2_000, 5_000];
/** ActivityManager 起进程时的日志：Start proc <pid>:<包名>/<uid> …，看到就把新 pid 加进去，不等重查。 */
const START_PROC = /^Start proc (\d+):([\w.]+)[/:]/;

export type LogcatDeps = {
  /** 起 adb -s <id> logcat -v threadtime -T 500（adb.stream）。 */
  stream(id: string, h: AdbStreamHandlers): AdbStream;
  /** adb -s <id> shell pidof <pkg>，没运行时返回 []。 */
  pidof(id: string, pkg: string): Promise<number[]>;
  batchMs?: number;
  keep?: number;
  replay?: number;
  pidRefreshMs?: number;
  restartMs?: number[];
  log?(s: string): void;
};

export type LogcatSub = { setFilter(f: LogFilter): void; close(): void };

type Sub = {
  filter: LogFilter;
  pids: Set<number> | null;
  /** 这次 pidof 发出后从 Start proc 学到的 pid：查询结果可能早于 App 重启，合并进去免得把新 pid 冲掉。 */
  learned: Set<number>;
  /** pid 还没查回来时不推新行；查回来后从缓冲里回放，期间的行不会丢。 */
  ready: boolean;
  gen: number;
  closed: boolean;
  pidTimer?: ReturnType<typeof setTimeout>;
  onBatch(lines: LogLine[], reset: boolean): void;
};

type Device = {
  proc: AdbStream | null;
  partial: string;
  buf: LogLine[];
  fresh: LogLine[];
  subs: Set<Sub>;
  flushTimer?: ReturnType<typeof setTimeout>;
  restartTimer?: ReturnType<typeof setTimeout>;
  restarts: number;
};

export function createLogcatHub(deps: LogcatDeps) {
  const batchMs = deps.batchMs ?? BATCH_MS;
  const keep = deps.keep ?? KEEP;
  const replay = deps.replay ?? REPLAY;
  const pidRefreshMs = deps.pidRefreshMs ?? PID_REFRESH_MS;
  const restartMs = deps.restartMs ?? RESTART_MS;
  const log = deps.log ?? ((s: string) => console.log(s));
  const devices = new Map<string, Device>();
  let seq = 0;

  const flush = (d: Device) => {
    d.flushTimer = undefined;
    const fresh = d.fresh;
    d.fresh = [];
    if (d.buf.length > keep) d.buf.splice(0, d.buf.length - keep);
    for (const s of d.subs) {
      if (!s.ready) continue;
      const lines = fresh.filter((l) => matchLog(l, { pids: s.pids, level: s.filter.level, text: s.filter.text }));
      if (lines.length) s.onBatch(lines, false);
    }
  };

  const ingest = (d: Device, chunk: string) => {
    d.restarts = 0;
    const parts = (d.partial + chunk).split("\n");
    d.partial = parts.pop()!;
    for (const raw of parts) {
      const p = parseLogcatLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
      if (!p) continue;
      const l: LogLine = { n: ++seq, ...p };
      d.buf.push(l);
      d.fresh.push(l);
      const m = l.tag === "ActivityManager" ? START_PROC.exec(l.msg) : null;
      if (m) {
        for (const s of d.subs) {
          if (s.filter.pkg !== m[2]) continue;
          s.learned.add(Number(m[1]));
          s.pids?.add(Number(m[1]));
        }
      }
    }
    if (d.fresh.length && !d.flushTimer) d.flushTimer = setTimeout(() => flush(d), batchMs);
  };

  const start = (id: string, d: Device) => {
    const proc: AdbStream = deps.stream(id, {
      onData: (s) => ingest(d, s),
      onExit: (code) => {
        if (d.proc !== proc) return;
        d.proc = null;
        d.partial = "";
        if (!d.subs.size) return;
        const wait = restartMs[Math.min(d.restarts++, restartMs.length - 1)];
        log(`${id} 的 logcat 退出（${code ?? "信号"}），${wait / 1000} 秒后重启`);
        d.restartTimer = setTimeout(() => {
          d.restartTimer = undefined;
          if (d.subs.size && !d.proc) start(id, d);
        }, wait);
      },
    });
    d.proc = proc;
  };

  const stop = (id: string, d: Device) => {
    const proc = d.proc;
    d.proc = null;
    proc?.stop();
    clearTimeout(d.flushTimer);
    clearTimeout(d.restartTimer);
    devices.delete(id);
  };

  // 查 pid（按 App 过滤时），再从缓冲里回放匹配的最近行；gen 防止旧的查询晚回来覆盖新条件
  const apply = (id: string, d: Device, s: Sub, f: LogFilter) => {
    const gen = ++s.gen;
    s.filter = f;
    s.ready = false;
    clearTimeout(s.pidTimer);
    s.pidTimer = undefined;
    s.learned = new Set();
    const pids: Promise<Set<number> | null> = f.pkg === null ? Promise.resolve(null) : deps.pidof(id, f.pkg).then((p) => new Set(p), () => new Set());
    void pids.then((set) => {
      if (s.closed || s.gen !== gen) return;
      s.pids = set && new Set([...set, ...s.learned]);
      s.ready = true;
      const out: LogLine[] = [];
      for (let i = d.buf.length - 1; i >= 0 && out.length < replay; i--) {
        if (matchLog(d.buf[i], { pids: s.pids, level: f.level, text: f.text })) out.push(d.buf[i]);
      }
      s.onBatch(out.reverse(), true);
      if (f.pkg === null) return;
      const pkg = f.pkg;
      // 上一次回来才排下一次：adb 慢时不往设备队列里越堆越多
      const refresh = () => {
        s.pidTimer = setTimeout(() => {
          s.learned = new Set();
          const done = (p: number[] | null) => {
            if (s.closed || s.gen !== gen) return;
            if (p) s.pids = new Set([...p, ...s.learned]);
            refresh();
          };
          deps.pidof(id, pkg).then(done, () => done(null));
        }, pidRefreshMs);
      };
      refresh();
    });
  };

  return {
    subscribe(id: string, f: LogFilter, onBatch: (lines: LogLine[], reset: boolean) => void): LogcatSub {
      let d = devices.get(id);
      if (!d) {
        d = { proc: null, partial: "", buf: [], fresh: [], subs: new Set(), restarts: 0 };
        devices.set(id, d);
      }
      const dev = d;
      const s: Sub = { filter: f, pids: null, learned: new Set(), ready: false, gen: 0, closed: false, onBatch };
      dev.subs.add(s);
      if (!dev.proc && !dev.restartTimer) start(id, dev);
      apply(id, dev, s, f);
      return {
        setFilter: (nf) => void (!s.closed && apply(id, dev, s, nf)),
        close() {
          if (s.closed) return;
          s.closed = true;
          clearTimeout(s.pidTimer);
          dev.subs.delete(s);
          if (!dev.subs.size) stop(id, dev);
        },
      };
    },
    close() {
      for (const [id, d] of devices) {
        for (const s of d.subs) {
          s.closed = true;
          clearTimeout(s.pidTimer);
        }
        stop(id, d);
      }
    },
  };
}

/** 包名下拉的「运行中的 App」：adb shell ps -A -o USER,NAME 里 u0_a 开头的用户（普通 App），去掉 :子进程名，丢掉不像包名的。 */
export function parseApps(psOut: string): string[] {
  const apps = new Set<string>();
  for (const line of psOut.split("\n")) {
    const m = /^u0_a\d+\s+(\S+)/.exec(line);
    const name = m?.[1].split(":")[0];
    if (name && /^[A-Za-z][\w.]*$/.test(name)) apps.add(name);
  }
  return [...apps].sort();
}

/** WebMCP 读日志每次导出这么多行再过滤：平常的设备上大约是最近一两分钟。 */
export const READ_DUMP_LINES = 5000;
/** 导出的内容超过 adb 输出上限（有很长的行，比如 OkHttp 打印整个响应体）时，改读这么多行。 */
const READ_DUMP_FALLBACK = 1000;

/** 用 run(行数) 导出 logcat：超过 adb 输出上限就少读一些再试一次。 */
export async function dumpLogcat(run: (lines: number) => Promise<string>): Promise<string> {
  const tooBig = (e: unknown) => (e as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  try {
    return await run(READ_DUMP_LINES);
  } catch (e) {
    if (!tooBig(e)) throw e;
  }
  try {
    return await run(READ_DUMP_FALLBACK);
  } catch (e) {
    if (tooBig(e)) throw new Error(`日志行太长，最近 ${READ_DUMP_FALLBACK} 行也超过了 adb 的输出上限：稍后再试`);
    throw e;
  }
}

/** AndroidRuntime 崩溃日志的第一行：Process: <包名>, PID: <pid>。 */
const CRASH_PROC = /^Process: ([\w.]+), PID: (\d+)/;

/**
 * WebMCP 读日志：从一次 adb logcat -d 的输出里按条件挑最后 limit 行。按包名过滤时，pid 除了 pidof 查到的，还算上输出里这个包的
 * Start proc 和崩溃日志里出现过的 pid，App 已经崩溃退出时也能读到它退出前的日志。
 */
export function readLogcat(dump: string, pkgPids: number[], f: LogFilter, limit: number): LogLine[] {
  const parsed: LogLine[] = [];
  const pids = new Set(pkgPids);
  for (const raw of dump.split("\n")) {
    const p = parseLogcatLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    if (!p) continue;
    parsed.push({ n: parsed.length + 1, ...p });
    if (f.pkg === null) continue;
    const start = p.tag === "ActivityManager" ? START_PROC.exec(p.msg) : null;
    if (start?.[2] === f.pkg) pids.add(Number(start[1]));
    const crash = p.tag === "AndroidRuntime" ? CRASH_PROC.exec(p.msg) : null;
    if (crash?.[1] === f.pkg) pids.add(Number(crash[2]));
  }
  const match = { pids: f.pkg === null ? null : pids, level: f.level, text: f.text };
  return parsed.filter((l) => matchLog(l, match)).slice(-limit);
}
