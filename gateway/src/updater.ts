// 自动更新：后台服务定时拿下载站的 .sha256 和装过的那份（install.sh 写的 installed.sha256）比，有新版本就下载、
// 先校验 sha256 再解压、验过新程序能跑，再原子地换掉 launchd 运行的那个可执行文件；调用方随后以 RESTART_EXIT_CODE 退出，
// launchd（KeepAlive.SuccessfulExit=false，见 service.ts）拉起新版本。信任模型同 scripts/install.sh：
// 下载地址写死在这里，sha256 和压缩包同域；页面只能让网关“现在查一次”，选不了地址也给不了内容。
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UpdateState } from "../../shared/protocol.ts";

export const DOWNLOAD_BASE = "https://droid.devpier.dev/download";
const NAME = "droidpier-darwin-arm64";
/** 换上新版本后用这个退出码退出：非 0，launchd 当作异常退出，马上拉起新的可执行文件。 */
export const RESTART_EXIT_CODE = 75;
/** 下载包现在约 18 MiB（scripts/build-binary.ts），留足余量，防止下载站出错时写满磁盘。 */
const MAX_BYTES = 200 * 2 ** 20;
/** 前台运行时发现新版本打印的话。 */
export const NEWER_LINE = "有新版本，运行 droidpier start 切到后台并自动更新，或重新运行安装命令";

export type UpdateReport = { state: UpdateState; message?: string };
export type CheckResult = { kind: "latest" } | { kind: "updated" } | { kind: "deferred"; reason: string } | { kind: "failed"; error: string };

export type UpdaterDeps = {
  base: string;
  /** 要换掉的可执行文件（launchd 运行的那个）。 */
  bin: string;
  /** 装过的压缩包的 sha256，和 install.sh 写的是同一个文件。 */
  stamp: string;
  getText(url: string): Promise<string>;
  /** 下载到 dest；失败抛错。 */
  download(url: string, dest: string): Promise<void>;
  sha256File(path: string): Promise<string>;
  /** 文件不存在时返回 null。 */
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  rm(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  exec(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** 有不能被重启打断的操作时返回原因（装 SDK、开机、删设备……），否则 null。 */
  busy(): string | null;
  log(s: string): void;
};

/** 下载地址。DROIDPIER_DOWNLOAD 只给测试用（同 install.sh）：只认 https，http 只认 127.0.0.1。 */
export function downloadBase(env: Record<string, string | undefined>): { base: string } | { error: string } {
  const v = env.DROIDPIER_DOWNLOAD;
  if (!v) return { base: DOWNLOAD_BASE };
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { error: `DROIDPIER_DOWNLOAD 不合法：${v}` };
  }
  if (u.protocol === "https:" || (u.protocol === "http:" && u.hostname === "127.0.0.1")) return { base: v.replace(/\/+$/, "") };
  return { error: `DROIDPIER_DOWNLOAD 只能是 https 地址或 http://127.0.0.1：${v}` };
}

/**
 * 安装命令把程序装在 <前缀>/bin/droidpier，sha256 记在 <前缀>/share/droidpier/installed.sha256（~/.local 下）。
 * 不是这样装的（从源码运行、直接跑 dist 里的）返回 null：不自动更新，免得换掉开发用的文件。
 */
export function installLayout(binPath: string, standalone: boolean): { bin: string; stamp: string } | null {
  if (!standalone || basename(binPath) !== "droidpier" || basename(dirname(binPath)) !== "bin") return null;
  return { bin: binPath, stamp: join(dirname(dirname(binPath)), "share/droidpier/installed.sha256") };
}

const parseSha = (s: string) => {
  const t = s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return /^[0-9a-f]{64}$/.test(t) ? t : null;
};

/** 下载站上的版本和装过的不一样时返回它的 sha256，一样返回 null；取不到抛错。 */
export async function remoteNewer(d: Pick<UpdaterDeps, "base" | "stamp" | "getText" | "readFile">): Promise<string | null> {
  const want = parseSha(await d.getText(`${d.base}/${NAME}.tar.xz.sha256`));
  if (!want) throw new Error("下载站的 .sha256 内容不对");
  const have = (await d.readFile(d.stamp))?.trim() ?? "";
  return want === have ? null : want;
}

/** 后台服务查一次更新；返回 updated 时新版本已经换上，调用方要以 RESTART_EXIT_CODE 退出。 */
export async function updateOnce(d: UpdaterDeps): Promise<CheckResult> {
  let want: string | null;
  try {
    want = await remoteNewer(d);
  } catch (e) {
    d.log(`检查更新失败：${(e as Error).message}`);
    return { kind: "failed", error: (e as Error).message };
  }
  if (!want) {
    d.log("检查更新：已是最新版本");
    return { kind: "latest" };
  }
  const deferred = (reason: string): CheckResult => (d.log(`有新版本，${reason}，等结束后再更新`), { kind: "deferred", reason });
  const busy = d.busy();
  if (busy) return deferred(busy);
  // 放在可执行文件旁边：同一块盘，最后的 rename 才是原子的
  const work = join(dirname(d.bin), ".droidpier-update");
  const archive = join(work, `${NAME}.tar.xz`);
  const fresh = join(work, NAME);
  try {
    await d.rm(work);
    await d.mkdir(work);
    d.log(`有新版本（sha256 ${want.slice(0, 12)}…），下载 ${d.base}/${NAME}.tar.xz`);
    await d.download(`${d.base}/${NAME}.tar.xz`, archive);
    const got = await d.sha256File(archive);
    if (got !== want) throw new Error(`校验失败：sha256 应为 ${want}，下载到的是 ${got}`);
    const tar = await d.exec("/usr/bin/tar", ["-xJf", archive, "-C", work, NAME]);
    if (tar.code !== 0) throw new Error(`解压失败：${(tar.stderr || tar.stdout).trim()}`);
    await d.chmod(fresh, 0o755);
    await d.exec("/usr/bin/xattr", ["-d", "com.apple.quarantine", fresh]);
    const v = await d.exec(fresh, ["--version"]);
    if (v.code !== 0 || !/^droidpier \S/.test(v.stdout)) throw new Error(`新版本运行不起来：${(v.stderr || v.stdout).trim() || `退出码 ${v.code}`}`);
    // 下载期间可能开始了不能打断的操作
    const late = d.busy();
    if (late) return deferred(late);
    await d.mkdir(dirname(d.stamp));
    await d.writeFile(`${d.stamp}.new`, `${want}\n`);
    await d.rename(fresh, d.bin);
    await d.rename(`${d.stamp}.new`, d.stamp);
    d.log(`已换上新版本 ${v.stdout.trim()}，重启网关`);
    return { kind: "updated" };
  } catch (e) {
    d.log(`更新失败，接着用现在的版本：${(e as Error).message}`);
    return { kind: "failed", error: (e as Error).message };
  } finally {
    await d.rm(work).catch(() => {});
  }
}

/** 前台运行：只看有没有新版本，有就打印一行（同一个新版本只打印一次），从不下载；取不到就算了，不打扰。 */
export function newerNotice(d: Pick<UpdaterDeps, "base" | "stamp" | "getText" | "readFile" | "log">): () => Promise<UpdateReport> {
  let told = "";
  return async () => {
    const want = await remoteNewer(d);
    if (want && want !== told) {
      told = want;
      d.log(NEWER_LINE);
    }
    return { state: "off" };
  };
}

export const toReport = (r: CheckResult): UpdateReport =>
  r.kind === "latest" ? { state: "latest" }
  : r.kind === "updated" ? { state: "restarting" }
  : r.kind === "deferred" ? { state: "deferred", message: r.reason }
  : { state: "failed", message: r.error };

/** 定时检查和页面触发的检查：同时只跑一个；页面触发的 pageGapMs 内最多一次，期间返回上次的结果。 */
export function createAutoUpdater(o: {
  check(): Promise<UpdateReport>;
  now(): number;
  /** 返回取消函数。 */
  setTimer(fn: () => void, ms: number): () => void;
  random(): number;
  intervalMs: number;
  /** 每次间隔在 intervalMs 上下随机偏移这么多：很多台机器不会同一时刻去下载站。 */
  jitterMs: number;
  pageGapMs: number;
}) {
  let running: Promise<UpdateReport> | null = null;
  let last: { at: number; report: UpdateReport } | null = null;
  let lastPage = -Infinity;
  let cancel: (() => void) | null = null;
  let stopped = false;
  const run = () =>
    (running ??= o.check().catch((e: Error): UpdateReport => ({ state: "failed", message: e.message })).then((report) => {
      last = { at: o.now(), report };
      running = null;
      return report;
    }));
  const schedule = () => {
    if (stopped) return;
    const ms = o.intervalMs + (o.random() * 2 - 1) * o.jitterMs;
    cancel = o.setTimer(() => void run().finally(schedule), ms);
  };
  return {
    start() {
      void run().finally(schedule);
    },
    request(): Promise<UpdateReport> {
      if (running) return running;
      if (last && o.now() - lastPage < o.pageGapMs) return Promise.resolve(last.report);
      lastPage = o.now();
      return run();
    },
    last: () => last,
    stop() {
      stopped = true;
      cancel?.();
    },
  };
}

/** 真实的依赖。getText / download 跟随重定向，但最后的地址必须和 base 同一个协议（不许从 https 降到 http）。 */
export function realUpdaterDeps(o: { base: string; bin: string; stamp: string; busy(): string | null; log(s: string): void }): UpdaterDeps {
  const proto = new URL(o.base).protocol;
  const get = async (url: string, timeoutMs: number) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    if (new URL(r.url || url).protocol !== proto) throw new Error(`下载地址被重定向到了 ${r.url}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}：${url}`);
    return r;
  };
  return {
    ...o,
    getText: async (url) => (await get(url, 15_000)).text(),
    download: async (url, dest) => {
      const r = await get(url, 10 * 60_000);
      if (!r.body) throw new Error(`没有内容：${url}`);
      let n = 0;
      const src = Readable.fromWeb(r.body as import("node:stream/web").ReadableStream<Uint8Array>);
      src.on("data", (c: Buffer) => {
        n += c.length;
        if (n > MAX_BYTES) src.destroy(new Error(`下载包超过 ${MAX_BYTES / 2 ** 20} MiB，不像是 droidpier`));
      });
      await pipeline(src, createWriteStream(dest));
    },
    sha256File: async (p) => {
      const h = createHash("sha256");
      for await (const c of createReadStream(p)) h.update(c as Buffer);
      return h.digest("hex");
    },
    readFile: (p) => readFile(p, "utf8").catch(() => null),
    writeFile: (p, s) => writeFile(p, s),
    mkdir: async (dir) => void (await mkdir(dir, { recursive: true })),
    rm: (p) => rm(p, { recursive: true, force: true }),
    rename: (a, b) => rename(a, b),
    chmod: (p, m) => chmod(p, m),
    exec: (cmd, args) =>
      new Promise((res) =>
        execFile(cmd, args, { encoding: "utf8", timeout: 30_000 }, (e, stdout, stderr) =>
          res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr }),
        ),
      ),
  };
}
