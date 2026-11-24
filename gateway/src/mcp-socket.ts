// MCP 的传输：网关在一个 Unix socket 上收消息，`droidpier mcp` 把 AI 客户端的 stdin/stdout 接到这个 socket。
// 不开 TCP 端口：WebSocket 那边只认 Chrome / Edge 的页面（gateway/src/peer.ts），命令行进程连不进去，也不该放宽；
// 这里靠文件权限，socket 所在目录只有当前用户能进（0700），别的用户、浏览器里的网页都碰不到。
import net from "node:net";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";

/** 按行切：每行交给 onLine，最后不完整的一行留着等下一段。 */
function lines(onLine: (l: string) => void) {
  let buf = "";
  return (d: Buffer | string) => {
    buf += d.toString();
    const parts = buf.split("\n");
    buf = parts.pop()!;
    for (const p of parts) if (p.trim()) onLine(p);
  };
}

const connects = (path: string) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(path);
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

/**
 * 在 path 上收 MCP 消息，每行交给 handle，回话写回同一条连接。同一条连接上的请求并发处理（执行 JS 可能要等）。
 * 另一个网关已经在这个 socket 上时返回 null，不抢。
 */
export async function listenMcp(opts: { path: string; handle: (line: string) => Promise<string | null>; log: (s: string) => void }) {
  const dir = dirname(opts.path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  if (await connects(opts.path)) {
    opts.log(`已有别的网关在 ${opts.path} 上提供 MCP，这个网关不提供`);
    return null;
  }
  // 上次没关干净留下的文件
  await unlink(opts.path).catch(() => {});
  const conns = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    conns.add(sock);
    sock.on("close", () => conns.delete(sock));
    sock.on("error", () => {});
    sock.on(
      "data",
      lines((l) => {
        opts.handle(l).then(
          (out) => {
            if (out !== null && !sock.destroyed) sock.write(`${out}\n`);
          },
          (e: Error) => opts.log(`MCP 处理失败：${e.message}`),
        );
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.path, () => resolve());
  });
  await chmod(opts.path, 0o600);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of conns) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** 网关重启（自动更新要几秒）时等它回来的时长；超过就退出。 */
const RECONNECT_FOR_MS = 60_000;

/**
 * `droidpier mcp`：把 stdin 接到网关的 MCP socket，回话写到 stdout。stdin 结束时结束。
 * 网关断开（重启、自动更新）时不退出：断开时还没回话的请求替网关回一个错误，断开期间来的消息存着，重新连上再发。
 * 第一次就连不上（网关没在运行）时直接失败。
 */
export function pipeMcp(opts: { path: string; stdin: Readable; stdout: Writable; retryMs?: number }): Promise<void> {
  const retryMs = opts.retryMs ?? 500;
  return new Promise((resolve, reject) => {
    let sock: net.Socket | null = null;
    let first = true;
    // 第一次就连不上、或者等网关回来等过了头：不再重连
    let gaveUp = false;
    let ended = false;
    let downSince = 0;
    const queue: string[] = [];
    // 发出去还没回话的请求 id
    const waiting = new Map<string, unknown>();
    const idKey = (id: unknown) => JSON.stringify(id);

    const writeOut = (line: string) => opts.stdout.write(`${line}\n`);
    const forward = (line: string) => {
      try {
        const m = JSON.parse(line);
        if (m && m.id !== undefined && typeof m.method === "string") waiting.set(idKey(m.id), m.id);
      } catch {
        // 不是 JSON：照样转给网关，由它回解析错误
      }
      sock!.write(`${line}\n`);
    };

    const connect = () => {
      const s = net.connect(opts.path);
      s.once("connect", () => {
        first = false;
        sock = s;
        for (const l of queue.splice(0)) forward(l);
        if (ended) s.end();
      });
      s.on(
        "data",
        lines((l) => {
          try {
            const m = JSON.parse(l);
            if (m && m.id !== undefined && m.method === undefined) waiting.delete(idKey(m.id));
          } catch {
            // 原样交给客户端
          }
          writeOut(l);
        }),
      );
      s.on("error", (e: NodeJS.ErrnoException) => {
        if (!first) return;
        gaveUp = true;
        reject(new Error(e.code === "ENOENT" || e.code === "ECONNREFUSED" ? "Droidpier 网关没有在运行：先运行 droidpier start" : `连不上网关：${e.message}`));
      });
      s.once("close", () => {
        if (sock === s) sock = null;
        if (gaveUp || first) return;
        if (ended) return resolve();
        // 断开时没回话的请求：网关不会再回了
        for (const id of waiting.values()) writeOut(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Droidpier 网关重启了（可能在自动更新），这次请求没有结果，请重试" } }));
        waiting.clear();
        downSince ||= Date.now();
        if (Date.now() - downSince > RECONNECT_FOR_MS) {
          gaveUp = true;
          return reject(new Error("Droidpier 网关断开后一分钟没有回来"));
        }
        setTimeout(connect, retryMs);
      });
      // 重新连上了
      s.once("connect", () => (downSince = 0));
    };

    opts.stdin.on(
      "data",
      lines((l) => (sock ? forward(l) : queue.push(l))),
    );
    opts.stdin.once("end", () => {
      ended = true;
      if (sock) sock.end();
      else if (!first) resolve();
    });
    connect();
  });
}
