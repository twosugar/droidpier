import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { PassThrough } from "node:stream";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenMcp, pipeMcp } from "../src/mcp-socket.ts";

// macOS 的 Unix socket 路径不能超过 104 字节：放在短的临时目录里
const tmp = () => mkdtemp(join(tmpdir(), "mcp-"));
const echo = async (line: string) => (line === "notify" ? null : `re:${line}`);

/** 连上 socket，发几行，收 n 行回话。 */
async function talk(path: string, lines: string[], n: number): Promise<string[]> {
  const sock = net.connect(path);
  await new Promise((r) => sock.once("connect", r));
  const got: string[] = [];
  let buf = "";
  const done = new Promise<void>((r) =>
    sock.on("data", (d) => {
      buf += d.toString();
      const parts = buf.split("\n");
      buf = parts.pop()!;
      got.push(...parts);
      if (got.length >= n) r();
    }),
  );
  sock.write(lines.map((l) => `${l}\n`).join(""));
  await done;
  sock.destroy();
  return got;
}

test("listenMcp：每行一条，按行回话，通知不回；目录只给自己（0700），socket 0600", async () => {
  const dir = join(await tmp(), "Droidpier");
  const path = join(dir, "mcp-7300.sock");
  const srv = await listenMcp({ path, handle: echo, log: () => {} });
  try {
    assert.deepEqual(await talk(path, ["a", "notify", "b"], 2), ["re:a", "re:b"]);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await srv!.close();
  }
  await assert.rejects(stat(path));
});

test("listenMcp：同一条连接上的请求并发处理，慢的不挡快的", async () => {
  const path = join(await tmp(), "m.sock");
  const srv = await listenMcp({
    path,
    handle: async (l) => {
      if (l === "slow") await new Promise((r) => setTimeout(r, 100));
      return l;
    },
    log: () => {},
  });
  try {
    assert.deepEqual(await talk(path, ["slow", "fast"], 2), ["fast", "slow"]);
  } finally {
    await srv!.close();
  }
});

test("listenMcp：上次留下的 socket 文件删掉重建；另一个网关正在用时不抢，返回 null", async () => {
  const path = join(await tmp(), "m.sock");
  await writeFile(path, "");
  const a = await listenMcp({ path, handle: echo, log: () => {} });
  assert.ok(a);
  const logs: string[] = [];
  const b = await listenMcp({ path, handle: echo, log: (s) => logs.push(s) });
  assert.equal(b, null);
  assert.match(logs.join("\n"), /已有/);
  assert.deepEqual(await talk(path, ["x"], 1), ["re:x"]);
  await a!.close();
});

test("pipeMcp：stdin 接到 socket，回话写到 stdout；连不上时说网关没运行", async () => {
  const path = join(await tmp(), "m.sock");
  const srv = await listenMcp({ path, handle: echo, log: () => {} });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = "";
  stdout.on("data", (d) => (out += d.toString()));
  const ended = pipeMcp({ path, stdin, stdout });
  stdin.write("hello\n");
  await new Promise<void>((r) => {
    const t = setInterval(() => out.includes("re:hello") && (clearInterval(t), r()), 5);
  });
  stdin.end();
  await ended;
  await srv!.close();
  await assert.rejects(pipeMcp({ path: join(await tmp(), "none.sock"), stdin: new PassThrough(), stdout: new PassThrough() }), /网关没有在运行/);
});

test("pipeMcp：网关重启（自动更新）时不退出：没回话的请求回一个错误，断开时来的请求等重新连上再发", async () => {
  const path = join(await tmp(), "m.sock");
  const jsonEcho = async (l: string) => {
    const m = JSON.parse(l);
    if (m.method === "hang") return new Promise<string>(() => {});
    return JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method });
  };
  const a = await listenMcp({ path, handle: jsonEcho, log: () => {} });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out: any[] = [];
  let buf = "";
  stdout.on("data", (d) => {
    buf += d.toString();
    const parts = buf.split("\n");
    buf = parts.pop()!;
    for (const p of parts) out.push(JSON.parse(p));
  });
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(f());
  };
  const ended = pipeMcp({ path, stdin, stdout, retryMs: 20 });
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "first" }) + "\n");
  await until(() => out.length === 1);
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "hang" }) + "\n");
  await new Promise((r) => setTimeout(r, 30));
  await a!.close();
  await until(() => out.some((m) => m.id === 2));
  assert.match(out.find((m) => m.id === 2).error.message, /网关/);
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "later" }) + "\n");
  await new Promise((r) => setTimeout(r, 50));
  const b = await listenMcp({ path, handle: jsonEcho, log: () => {} });
  await until(() => out.some((m) => m.id === 3));
  assert.equal(out.find((m) => m.id === 3).result, "later");
  stdin.end();
  await ended;
  await b!.close();
});
