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

/** `droidpier mcp`：把 stdin 接到网关的 MCP socket，回话写到 stdout；stdin 结束或网关断开时结束。 */
export function pipeMcp(opts: { path: string; stdin: Readable; stdout: Writable }): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(opts.path);
    sock.once("error", (e: NodeJS.ErrnoException) => {
      reject(new Error(e.code === "ENOENT" || e.code === "ECONNREFUSED" ? "Droidpier 网关没有在运行：先运行 droidpier start" : `连不上网关：${e.message}`));
    });
    sock.once("connect", () => {
      opts.stdin.pipe(sock);
      sock.pipe(opts.stdout, { end: false });
      sock.once("close", () => resolve());
    });
  });
}
