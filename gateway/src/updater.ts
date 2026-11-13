// 自动更新：后台服务定时取下载站的更新清单（<名字>.update.json：版本 + 压缩包 sha256）和它的 ed25519 签名，
// 签名用下面写死的公钥验过、版本比正在运行的新、sha256 和装过的不一样，才下载压缩包；先校验 sha256 再解压，
// 验过新程序报的版本就是清单里的版本，留一份旧的（.prev）再原子地换掉 launchd 运行的那个可执行文件；调用方随后以
// RESTART_EXIT_CODE 退出，launchd（KeepAlive.SuccessfulExit=false，见 service.ts）拉起新版本。新版本启动后连续起不来
// 就换回旧的（checkPending）。下载地址写死在这里；页面只能让网关“现在查一次”，选不了地址也给不了内容。
// install.sh 只校验同域的 sha256（防损坏），自动更新另外要签名（防下载站被换）：见 docs/deploy.md。
import { createHash, createPublicKey, verify } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UpdateFailure, UpdateState } from "../../shared/protocol.ts";

export const DOWNLOAD_BASE = "https://droid.devpier.dev/download";
const NAME = "droidpier-darwin-arm64";
/** 验更新清单签名的公钥；私钥只在 CI 的密钥里（scripts/sign-update.ts）。 */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALLWvnqGUFm947xZCjwxhTMUDQygdOayw3/0mwDAOVKc=
-----END PUBLIC KEY-----
`;
/** 换上新版本（或换回旧版本）后用这个退出码退出：非 0，launchd 当作异常退出，马上拉起换好的可执行文件。 */
export const RESTART_EXIT_CODE = 75;
/** 下载包现在约 18 MiB（scripts/build-binary.ts），留足余量，防止下载站出错时写满磁盘。 */
const MAX_BYTES = 200 * 2 ** 20;
/** 解压出来的可执行文件现在约 65 MiB；不在这个范围里的不去执行它。 */
const BIN_MIN = 2 ** 20;
const BIN_MAX = 500 * 2 ** 20;
/** 清单和签名都只有一两百字节。 */
const MANIFEST_MAX = 4096;
const SIG_MAX = 1024;
/** 刚换上的新版本最多启动这么多次还没稳定运行，就换回旧版本。 */
const MAX_PENDING_STARTS = 3;
/** 前台运行时发现新版本打印的话。 */
export const NEWER_LINE = "有新版本，运行 droidpier start 切到后台并自动更新，或重新运行安装命令";

export type UpdateReport = { state: UpdateState; message?: string };
export type CheckResult =
  | { kind: "latest" }
  | { kind: "updated" }
  | { kind: "deferred"; reason: string }
  | { kind: "failed"; reason: UpdateFailure; error: string };
export type Manifest = { name: string; version: string; sha256: string };

export type UpdaterDeps = {
  base: string;
  /** 要换掉的可执行文件（launchd 运行的那个）。 */
  bin: string;
  /** 装过的压缩包的 sha256，和 install.sh 写的是同一个文件。 */
  stamp: string;
  /** 正在运行的版本（构建时间）：只换比它新的。 */
  version: string;
  /** 验清单签名的公钥（PEM）；真实依赖里是 UPDATE_PUBLIC_KEY。 */
  publicKey: string;
  /** 取一个小文件，超过 maxBytes 抛错；404 返回 null。 */
  getSmall(url: string, maxBytes: number): Promise<Buffer | null>;
  /** 下载到 dest；失败抛错。 */
  download(url: string, dest: string): Promise<void>;
  sha256File(path: string): Promise<string>;
  /** 文件不存在时返回 null。 */
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, data: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  rm(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** 不跟随符号链接；不存在返回 null。 */
  lstat(path: string): Promise<{ isFile: boolean; size: number } | null>;
  writable(dir: string): Promise<boolean>;
  exec(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** 有不能被重启打断的操作时返回原因（装 SDK、开机、删设备……），否则 null。 */
  busy(): string | null;
  log(s: string): void;
  /** 中止进行中的下载（网关退出时）；之后 busy() 报“网关正在退出”，不再换文件。 */
  abort?(): void;
};

class UpdateError extends Error {
  reason: UpdateFailure;
  constructor(reason: UpdateFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** 回退要用的文件：旧可执行文件、旧 stamp、启动计数、启动失败退回过的版本。 */
const files = (d: Pick<UpdaterDeps, "bin" | "stamp">) => {
  const share = dirname(d.stamp);
  return { share, prev: `${d.bin}.prev`, stampPrev: `${d.stamp}.prev`, pending: join(share, "update-pending"), bad: join(share, "update-bad") };
};

/**
 * 下载地址。DROIDPIER_DOWNLOAD 只给测试用（同 install.sh），allowOverride 为 false 时（正式 label 的后台服务）不认它；
 * 只认 https，http 只认 127.0.0.1。
 */
export function downloadBase(env: Record<string, string | undefined>, allowOverride: boolean): { base: string } | { error: string } {
  const v = env.DROIDPIER_DOWNLOAD;
  if (!v || !allowOverride) return { base: DOWNLOAD_BASE };
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

const SHA = /^[0-9a-f]{64}$/;
// 构建时间，scripts/build-binary.ts 写的 toISOString()：同格式的字符串可以直接按字典序比新旧
const VERSION = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

/** 验签名、解析清单；不对就抛 UpdateError。 */
export function readManifest(bytes: Buffer, sig: Buffer | null, publicKey: string): Manifest {
  if (sig === null) throw new UpdateError("unsigned", "下载站上的更新清单没有签名");
  const raw = Buffer.from(sig.toString("utf8").trim(), "base64");
  let ok = false;
  try {
    ok = raw.length === 64 && verify(null, bytes, createPublicKey(publicKey), raw);
  } catch {
    ok = false;
  }
  if (!ok) throw new UpdateError("signature", "更新清单的签名不对");
  let m: Partial<Manifest>;
  try {
    m = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new UpdateError("manifest", "更新清单不是 JSON");
  }
  if (m?.name !== NAME || typeof m.sha256 !== "string" || !SHA.test(m.sha256) || typeof m.version !== "string" || !VERSION.test(m.version)) {
    throw new UpdateError("manifest", "更新清单的内容不对");
  }
  return { name: m.name, version: m.version, sha256: m.sha256 };
}

/** 下载站上有比正在运行的新、签名对、没退回过的版本时返回它的清单，否则 null；取不到或不对时抛错。 */
export async function remoteNewer(d: Pick<UpdaterDeps, "base" | "bin" | "stamp" | "version" | "publicKey" | "getSmall" | "readFile" | "log">): Promise<Manifest | null> {
  const url = `${d.base}/${NAME}.update.json`;
  const bytes = await d.getSmall(url, MANIFEST_MAX);
  if (!bytes) throw new UpdateError("manifest", "下载站上没有更新清单");
  // 和装着的是同一个包：不下载、不执行任何东西，签名不用看。没签名的发布不会让已是最新的网关报失败、退避
  const installed = (await d.readFile(d.stamp))?.trim();
  try {
    if (installed && (JSON.parse(bytes.toString("utf8")) as { sha256?: unknown })?.sha256 === installed) return null;
  } catch {
    // 不是 JSON：下面 readManifest 报 manifest
  }
  const m = readManifest(bytes, await d.getSmall(`${url}.sig`, SIG_MAX), d.publicKey);
  if (m.version <= d.version) {
    if (m.version < d.version) d.log(`下载站上的版本 ${m.version} 比正在运行的 ${d.version} 旧，不换`);
    return null;
  }
  if (m.sha256 === (await d.readFile(files(d).bad))?.trim()) {
    d.log(`版本 ${m.version} 换上后启动失败过、已退回，不再换上`);
    return null;
  }
  return m;
}

const fail = (reason: UpdateFailure) => (e: unknown): never => {
  throw e instanceof UpdateError ? e : new UpdateError(reason, (e as Error).message);
};

/** 后台服务查一次更新；返回 updated 时新版本已经换上，调用方要以 RESTART_EXIT_CODE 退出。 */
export async function updateOnce(d: UpdaterDeps): Promise<CheckResult> {
  const failed = (e: unknown): CheckResult => {
    const reason = e instanceof UpdateError ? e.reason : "network";
    const error = (e as Error).message;
    d.log(`更新失败（${reason}），接着用现在的版本：${error}`);
    return { kind: "failed", reason, error };
  };
  let m: Manifest | null;
  try {
    m = await remoteNewer(d);
  } catch (e) {
    return failed(e);
  }
  if (!m) {
    d.log("检查更新：已是最新版本");
    return { kind: "latest" };
  }
  const deferred = (reason: string): CheckResult => (d.log(`有新版本 ${m!.version}，${reason}，等结束后再更新`), { kind: "deferred", reason });
  const busy = d.busy();
  if (busy) return deferred(busy);
  const f = files(d);
  try {
    await d.mkdir(f.share).catch(() => {});
    if (!(await d.writable(dirname(d.bin))) || !(await d.writable(f.share))) throw new UpdateError("not-writable", `写不了 ${dirname(d.bin)} 或 ${f.share}`);
  } catch (e) {
    return failed(e);
  }
  // 放在可执行文件旁边：同一块盘，最后的 rename 才是原子的；每次新建，不碰别的进程的目录
  let work: string | null = null;
  try {
    work = await d.mkdtemp(join(dirname(d.bin), ".droidpier-update-")).catch(fail("not-writable"));
    const archive = join(work, `${NAME}.tar.xz`);
    const fresh = join(work, NAME);
    d.log(`有新版本 ${m.version}，下载 ${d.base}/${NAME}.tar.xz`);
    await d.download(`${d.base}/${NAME}.tar.xz`, archive).catch(fail("network"));
    const got = await d.sha256File(archive).catch(fail("checksum"));
    if (got !== m.sha256) throw new UpdateError("checksum", `校验失败：sha256 应为 ${m.sha256}，下载到的是 ${got}`);
    const tar = await d.exec("/usr/bin/tar", ["-xJf", archive, "-C", work, NAME]);
    if (tar.code !== 0) throw new UpdateError("unpack", `解压失败：${(tar.stderr || tar.stdout).trim()}`);
    const st = await d.lstat(fresh);
    if (!st?.isFile || st.size < BIN_MIN || st.size > BIN_MAX) throw new UpdateError("unpack", `解压出来的 ${NAME} 不是正常大小的普通文件`);
    await d.chmod(fresh, 0o755).catch(fail("unpack"));
    await d.exec("/usr/bin/xattr", ["-d", "com.apple.quarantine", fresh]);
    const v = await d.exec(fresh, ["--version"]);
    if (v.code !== 0 || v.stdout.trim() !== `droidpier ${m.version}`) {
      throw new UpdateError("bad-binary", `新版本报的版本不对：${(v.stdout || v.stderr).trim() || `退出码 ${v.code}`}`);
    }
    // 下载期间可能开始了不能打断的操作
    const late = d.busy();
    if (late) return deferred(late);
    try {
      await d.writeFile(`${d.stamp}.new`, `${m.sha256}\n`);
      // 旧版本留一份：新版本启动不起来时 checkPending 换回去
      await d.copyFile(d.bin, f.prev);
      if ((await d.readFile(d.stamp)) !== null) await d.copyFile(d.stamp, f.stampPrev);
      else await d.rm(f.stampPrev);
      await d.writeFile(f.pending, "0");
      await d.rename(fresh, d.bin);
    } catch (e) {
      await d.rm(f.pending).catch(() => {});
      throw new UpdateError("install", (e as Error).message);
    }
    await d.rename(`${d.stamp}.new`, d.stamp).catch(fail("install"));
    d.log(`已换上新版本 droidpier ${m.version}，重启网关`);
    return { kind: "updated" };
  } catch (e) {
    return failed(e);
  } finally {
    if (work) await d.rm(work).catch(() => {});
  }
}

/**
 * 后台服务一启动就调用：刚换上新版本（有启动计数）时计数加一；超过 MAX_PENDING_STARTS 次还没稳定运行，
 * 就换回旧的可执行文件和 stamp、记下这个坏版本，返回 rolled-back，调用方以 RESTART_EXIT_CODE 退出。
 */
export async function checkPending(d: Pick<UpdaterDeps, "bin" | "stamp" | "readFile" | "writeFile" | "rename" | "rm" | "lstat" | "log">): Promise<"none" | "counting" | "rolled-back"> {
  const f = files(d);
  const s = await d.readFile(f.pending);
  if (s === null) return "none";
  const n = (Number.parseInt(s, 10) || 0) + 1;
  if (n <= MAX_PENDING_STARTS) {
    await d.writeFile(f.pending, String(n));
    d.log(`新版本第 ${n} 次启动`);
    return "counting";
  }
  await d.rm(f.pending);
  if (!(await d.lstat(f.prev))?.isFile) {
    d.log("新版本启动了几次都没能稳定运行，但没有旧版本可以换回");
    return "none";
  }
  const bad = (await d.readFile(d.stamp))?.trim();
  await d.rename(f.prev, d.bin);
  // 第一次装时没有旧 stamp：删掉新的，安装命令下次会重新下载
  if ((await d.readFile(f.stampPrev)) !== null) await d.rename(f.stampPrev, d.stamp);
  else await d.rm(d.stamp);
  if (bad) await d.writeFile(f.bad, `${bad}\n`);
  d.log(`新版本启动了 ${MAX_PENDING_STARTS} 次都没能稳定运行，已换回旧版本，重启网关`);
  return "rolled-back";
}

/** 删掉可执行文件旁边超过一小时的 .droidpier-update-* 临时目录（上次更新时网关被杀，没来得及删）。 */
export async function cleanStaleWork(d: {
  bin: string; now(): number; readdir(dir: string): Promise<string[]>; mtimeMs(path: string): Promise<number | null>; rm(path: string): Promise<void>; log(s: string): void;
}): Promise<void> {
  const dir = dirname(d.bin);
  for (const name of await d.readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(".droidpier-update-")) continue;
    const p = join(dir, name);
    const t = await d.mtimeMs(p);
    if (t === null || d.now() - t < 3600_000) continue;
    await d.rm(p).catch(() => {});
    d.log(`删掉上次没删的更新临时目录 ${name}`);
  }
}

/** 等第一次检查最多 ms 毫秒：超时返回 null，检查在后台接着跑。 */
export function firstWithin<T>(first: Promise<T>, ms: number, setTimer: (fn: () => void, ms: number) => () => void): Promise<T | null> {
  return new Promise((res) => {
    const cancel = setTimer(() => res(null), ms);
    void first.then((v) => {
      cancel();
      res(v);
    });
  });
}

/** 新版本稳定运行了一阵：不再算它的启动次数。 */
export async function confirmStable(d: Pick<UpdaterDeps, "bin" | "stamp" | "readFile" | "rm" | "log">): Promise<void> {
  const f = files(d);
  if ((await d.readFile(f.pending)) === null) return;
  await d.rm(f.pending);
  d.log("新版本运行正常");
}

/** 前台运行：只看有没有新版本，有就打印一行（同一个新版本只打印一次），从不下载；取不到就算了，不打扰。 */
export function newerNotice(d: Parameters<typeof remoteNewer>[0]): () => Promise<UpdateReport> {
  let told = "";
  return async () => {
    const m = await remoteNewer(d);
    if (m && m.sha256 !== told) {
      told = m.sha256;
      d.log(NEWER_LINE);
    }
    return { state: "off" };
  };
}

/** 给页面和 /healthz 的结果：failed 只给类别，不带路径和原始错误。 */
export const toReport = (r: CheckResult): UpdateReport =>
  r.kind === "latest" ? { state: "latest" }
  : r.kind === "updated" ? { state: "restarting" }
  : r.kind === "deferred" ? { state: "deferred", message: r.reason }
  : { state: "failed", message: r.reason };

/**
 * 定时检查和页面触发的检查：同时只跑一个；页面触发的 pageGapMs 内最多一次，期间返回上次的结果。
 * 连续失败时间隔加倍，最多 8 倍。
 */
export function createAutoUpdater(o: {
  check(): Promise<UpdateReport>;
  /** 中止进行中的检查（下载）；stop 时调用。 */
  abort?(): void;
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
  let failures = 0;
  const run = () =>
    (running ??= o.check().catch((): UpdateReport => ({ state: "failed", message: "network" })).then((report) => {
      last = { at: o.now(), report };
      failures = report.state === "failed" ? failures + 1 : 0;
      running = null;
      return report;
    }));
  const schedule = () => {
    if (stopped) return;
    const ms = o.intervalMs * 2 ** Math.min(failures, 3) + (o.random() * 2 - 1) * o.jitterMs;
    cancel = o.setTimer(() => void run().finally(schedule), ms);
  };
  return {
    /** 马上查一次，返回这次的结果；之后定时查。 */
    start(): Promise<UpdateReport> {
      const first = run();
      void first.finally(schedule);
      return first;
    },
    request(): Promise<UpdateReport> {
      if (running) return running;
      if (last && o.now() - lastPage < o.pageGapMs) return Promise.resolve(last.report);
      lastPage = o.now();
      return run();
    },
    last: () => last,
    /** 停掉定时检查，中止进行中的下载，等它删完临时目录。 */
    stop(): Promise<void> {
      stopped = true;
      cancel?.();
      o.abort?.();
      return running ? running.then(() => {}) : Promise.resolve();
    },
  };
}

/** cleanStaleWork 的真实依赖。 */
export const realCleanDeps = (o: { bin: string; log(s: string): void }) => ({
  ...o,
  now: () => Date.now(),
  readdir: (dir: string) => readdir(dir),
  mtimeMs: (p: string) => stat(p).then((s) => s.mtimeMs, () => null),
  rm: (p: string) => rm(p, { recursive: true, force: true }),
});

/** 真实的依赖。取文件跟随重定向，但最后的地址必须和 base 同协议、同主机。 */
export function realUpdaterDeps(o: { base: string; bin: string; stamp: string; version: string; busy(): string | null; log(s: string): void }): UpdaterDeps {
  const want = new URL(o.base);
  const stopping = new AbortController();
  const get = async (url: string, timeoutMs: number) => {
    const r = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), stopping.signal]), redirect: "follow" });
    const got = new URL(r.url || url);
    if (got.protocol !== want.protocol || got.host !== want.host) throw new Error(`下载地址被重定向到了别的地方：${got.origin}`);
    return r;
  };
  const limited = (body: ReadableStream<Uint8Array>, max: number) => {
    let n = 0;
    const src = Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>);
    src.on("data", (c: Buffer) => {
      n += c.length;
      if (n > max) src.destroy(new Error(`内容超过 ${max} 字节`));
    });
    return src;
  };
  return {
    ...o,
    busy: () => (stopping.signal.aborted ? "网关正在退出" : o.busy()),
    abort: () => stopping.abort(new Error("网关正在退出")),
    publicKey: UPDATE_PUBLIC_KEY,
    getSmall: async (url, max) => {
      const r = await get(url, 10_000);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}：${url}`);
      if (!r.body) return Buffer.alloc(0);
      const chunks: Buffer[] = [];
      for await (const c of limited(r.body, max)) chunks.push(c as Buffer);
      return Buffer.concat(chunks);
    },
    download: async (url, dest) => {
      const r = await get(url, 10 * 60_000);
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}：${url}`);
      await pipeline(limited(r.body, MAX_BYTES), createWriteStream(dest, { flags: "wx", mode: 0o600 }), { signal: stopping.signal });
    },
    sha256File: async (p) => {
      const h = createHash("sha256");
      for await (const c of createReadStream(p)) h.update(c as Buffer);
      return h.digest("hex");
    },
    readFile: (p) => readFile(p, "utf8").catch(() => null),
    writeFile: (p, s) => writeFile(p, s),
    copyFile: (a, b) => copyFile(a, b),
    mkdir: async (dir) => void (await mkdir(dir, { recursive: true })),
    mkdtemp: (prefix) => mkdtemp(prefix),
    rm: (p) => rm(p, { recursive: true, force: true }),
    rename: (a, b) => rename(a, b),
    chmod: (p, m) => chmod(p, m),
    lstat: (p) => lstat(p).then((s) => ({ isFile: s.isFile(), size: s.size }), () => null),
    writable: (dir) => access(dir, constants.W_OK).then(() => true, () => false),
    exec: (cmd, args) =>
      new Promise((res) =>
        execFile(cmd, args, { encoding: "utf8", timeout: 30_000 }, (e, stdout, stderr) =>
          res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr }),
        ),
      ),
  };
}
