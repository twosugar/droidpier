import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdbUnresponsive, createAdb, emulatorId, execAdb, execAdbBuffer, killAdbChildren, streamAdb } from "../src/adb.ts";
import { ADB_UNRESPONSIVE } from "../../shared/protocol.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 假 exec：每次调用挂起，直到测试手动放行；记录同时在跑的个数。 */
function gatedExec() {
  const f = {
    calls: [] as string[],
    running: 0,
    maxRunning: 0,
    gates: [] as Array<{ args: string[]; ok: (s: string) => void; fail: (e: Error) => void }>,
    exec: (args: string[]) =>
      new Promise<string>((ok, fail) => {
        f.calls.push(args.join(" "));
        f.running++;
        f.maxRunning = Math.max(f.maxRunning, f.running);
        f.gates.push({
          args,
          ok: (s) => (f.running--, ok(s)),
          fail: (e) => (f.running--, fail(e)),
        });
      }),
  };
  return f;
}

test("同一台设备的 adb 命令一次只跑一个，按到达顺序", async () => {
  const f = gatedExec();
  const adb = createAdb({ exec: f.exec });
  const dev = adb.device("emulator-5554");
  const a = dev(["shell", "cat", "/proc/net/unix"]);
  const b = dev(["shell", "input", "keyevent", "279"]);
  await sleep(10);
  assert.deepEqual(f.calls, ["-s emulator-5554 shell cat /proc/net/unix"]);
  f.gates[0].ok("A");
  assert.equal(await a, "A");
  await sleep(10);
  assert.deepEqual(f.calls.at(-1), "-s emulator-5554 shell input keyevent 279");
  f.gates[1].ok("B");
  assert.equal(await b, "B");
  assert.equal(f.maxRunning, 1);
});

test("不同设备、不带 -s 的命令互不排队", async () => {
  const f = gatedExec();
  const adb = createAdb({ exec: f.exec });
  void adb.device("emulator-5554")(["shell", "true"]);
  void adb.device("emulator-5556")(["shell", "true"]);
  void adb.run(["forward", "--list"]);
  await sleep(10);
  assert.equal(f.running, 3);
  for (const g of f.gates) g.ok("");
});

test("前一个失败（包括超时）后队列继续往下走", async () => {
  const f = gatedExec();
  const adb = createAdb({ exec: f.exec });
  const dev = adb.device("emulator-5554");
  const a = dev(["shell", "a"]);
  const b = dev(["shell", "b"]);
  await sleep(10);
  f.gates[0].fail(new AdbUnresponsive());
  await assert.rejects(a, AdbUnresponsive);
  await sleep(10);
  f.gates[1].ok("ok");
  assert.equal(await b, "ok");
});

test("AdbUnresponsive 的文案是页面上显示的那句", () => {
  assert.equal(new AdbUnresponsive().message, ADB_UNRESPONSIVE);
});

test("真 adb 进程超时：用 SIGKILL 结束（不理 SIGTERM 的也杀得掉），归类为 adb 无响应并记日志", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emu-adb-"));
  const bin = join(dir, "adb");
  // 忽略 SIGTERM 后 exec 成 sleep：只有 SIGKILL 能让它在超时后马上结束
  await writeFile(bin, "#!/bin/sh\ntrap '' TERM\nexec sleep 30\n");
  await chmod(bin, 0o755);
  const logs: string[] = [];
  const t0 = Date.now();
  await assert.rejects(execAdb(bin, ["-s", "emulator-5554", "shell", "cat", "/proc/net/unix"], 300, (s) => logs.push(s)), AdbUnresponsive);
  assert.ok(Date.now() - t0 < 3000, `用了 ${Date.now() - t0} ms`);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /SIGKILL/);
  assert.match(logs[0], /shell cat \/proc\/net\/unix/);
});

test("真 adb 进程正常退出码非 0：原样报错，不算无响应", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emu-adb-"));
  const bin = join(dir, "adb");
  await writeFile(bin, "#!/bin/sh\necho \"error: device offline\" >&2\nexit 1\n");
  await chmod(bin, 0o755);
  const e = await execAdb(bin, ["devices"], 2000, () => {}).catch((e: Error) => e);
  assert.ok(e instanceof Error);
  assert.ok(!(e instanceof AdbUnresponsive));
});

test("网关退出时结束还在跑的 adb 进程，不留孤儿", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emu-adb-"));
  const bin = join(dir, "adb");
  await writeFile(bin, "#!/bin/sh\nexec sleep 30\n");
  await chmod(bin, 0o755);
  const p = execAdb(bin, ["-s", "emulator-5554", "shell", "true"], 60_000, () => {});
  await sleep(100);
  const t0 = Date.now();
  killAdbChildren();
  await assert.rejects(p);
  assert.ok(Date.now() - t0 < 2000);
});

test("长任务另走一条队列：安装没结束时，同一台设备的短命令照常跑；长任务之间仍一次一个", async () => {
  const f = gatedExec();
  const adb = createAdb({ exec: f.exec });
  const install = adb.long("emulator-5554")(["install", "-r", "-t", "/tmp/a.apk"], 600_000);
  const push = adb.long("emulator-5554")(["push", "/tmp/b.txt", "/sdcard/Download/b.txt"], 600_000);
  const list = adb.device("emulator-5554")(["shell", "cat", "/proc/net/unix"]);
  await sleep(10);
  assert.deepEqual(f.calls, ["-s emulator-5554 install -r -t /tmp/a.apk", "-s emulator-5554 shell cat /proc/net/unix"]);
  f.gates[1].ok("L");
  assert.equal(await list, "L");
  f.gates[0].ok("Success");
  assert.equal(await install, "Success");
  await sleep(10);
  assert.equal(f.calls.at(-1), "-s emulator-5554 push /tmp/b.txt /sdcard/Download/b.txt");
  f.gates[2].ok("");
  await push;
});

test("长任务用调用方给的超时", async () => {
  const seen: Array<number | undefined> = [];
  const adb = createAdb({ exec: async (_args, timeoutMs) => (seen.push(timeoutMs), "") });
  await adb.long("emulator-5554")(["install", "x.apk"], 600_000);
  await adb.device("emulator-5554")(["shell", "true"]);
  assert.deepEqual(seen, [600_000, undefined]);
});

test("设备 id 原样放进 -s，不加前缀（真机序列号）", async () => {
  const calls: string[] = [];
  const adb = createAdb({ exec: async (args) => (calls.push(args.join(" ")), "") });
  await adb.device("R5CR10WN52H")(["shell", "true"]);
  await adb.long("192.168.1.5:5555")(["install", "x.apk"], 600_000);
  assert.deepEqual(calls, ["-s R5CR10WN52H shell true", "-s 192.168.1.5:5555 install x.apk"]);
});

test("emulatorId 拼出模拟器在 adb 里的名字", () => {
  assert.equal(emulatorId(5554), "emulator-5554");
});

test("streamAdb 把输出按到达顺序交给 onData，进程结束时回调 onExit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emu-adb-"));
  const bin = join(dir, "adb");
  await writeFile(bin, "#!/bin/sh\necho a\nsleep 0.1\necho b\n");
  await chmod(bin, 0o755);
  let out = "";
  const code = await new Promise<number | null>((res) => streamAdb(bin, ["track-devices"], { onData: (s) => (out += s), onExit: res }));
  assert.equal(out, "a\nb\n");
  assert.equal(code, 0);
});

test("killAdbChildren 结束 streamAdb 起的长进程", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emu-adb-"));
  const bin = join(dir, "adb");
  await writeFile(bin, "#!/bin/sh\nexec sleep 30\n");
  await chmod(bin, 0o755);
  const exited = new Promise<void>((res) => streamAdb(bin, ["track-devices"], { onData: () => {}, onExit: () => res() }));
  await sleep(100);
  killAdbChildren();
  await Promise.race([exited, sleep(1000).then(() => { throw new Error("长进程没有被结束"); })]);
});

test("execAdbBuffer 原样返回二进制输出（截图 PNG）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emu-adb-"));
  const bin = join(dir, "adb");
  await writeFile(bin, "#!/bin/sh\nprintf '\\211PNG\\r\\n\\032\\n\\000\\377'\n");
  await chmod(bin, 0o755);
  const out = await execAdbBuffer(bin, ["exec-out", "screencap", "-p"], 2000, () => {});
  assert.deepEqual([...out], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
});

test("execAdbBuffer 超时仍归为 AdbUnresponsive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emu-adb-"));
  const bin = join(dir, "adb");
  await writeFile(bin, "#!/bin/sh\nexec sleep 30\n");
  await chmod(bin, 0o755);
  await assert.rejects(execAdbBuffer(bin, ["exec-out", "screencap", "-p"], 300, () => {}), AdbUnresponsive);
});

test("deviceBuffer 和 device 共用同一条设备队列", async () => {
  const order: string[] = [];
  let release!: () => void;
  const adb = createAdb({
    exec: async (args) => (order.push(`str ${args.slice(2).join(" ")}`), await new Promise<void>((r) => (release = r)), ""),
    execBuffer: async (args) => (order.push(`buf ${args.slice(2).join(" ")}`), Buffer.from([1])),
  });
  const a = adb.device("R5CR10WN52H")(["shell", "true"]);
  const b = adb.deviceBuffer("R5CR10WN52H")(["exec-out", "screencap", "-p"]);
  await sleep(10);
  assert.deepEqual(order, ["str shell true"]);
  release();
  await a;
  assert.deepEqual([...(await b)], [1]);
  assert.deepEqual(order, ["str shell true", "buf exec-out screencap -p"]);
});

/** 假 exec：按参数决定超时还是成功，记下每次调用。 */
function scriptedExec(hang: (args: string[]) => boolean) {
  const calls: string[] = [];
  return {
    calls,
    exec: async (args: string[]) => {
      calls.push(args.join(" "));
      if (hang(args)) throw new AdbUnresponsive();
      return "";
    },
  };
}

test("同一台设备连续两次超时后自动 adb reconnect 一次，不排在卡住的命令后面", async () => {
  const f = scriptedExec((a) => a[2] === "shell");
  const logs: string[] = [];
  const adb = createAdb({ exec: f.exec, log: (s) => logs.push(s), now: () => 0 });
  const dev = adb.device("emulator-5554");
  await assert.rejects(dev(["shell", "a"]), AdbUnresponsive);
  assert.ok(!f.calls.includes("-s emulator-5554 reconnect"));
  await assert.rejects(dev(["shell", "b"]), AdbUnresponsive);
  assert.equal(f.calls.filter((c) => c === "-s emulator-5554 reconnect").length, 1);
  assert.ok(logs.some((l) => l.includes("adb reconnect")));
});

test("自动重连 30 秒内最多一次；中间有一次成功就重新计数", async () => {
  let t = 0;
  let hang = true;
  const f = scriptedExec((a) => a[2] === "shell" && hang);
  const adb = createAdb({ exec: f.exec, log: () => {}, now: () => t });
  const dev = adb.device("emulator-5554");
  const reconnects = () => f.calls.filter((c) => c.endsWith(" reconnect")).length;
  for (let i = 0; i < 4; i++) await dev(["shell", "x"]).catch(() => {});
  assert.equal(reconnects(), 1);
  t = 29_999;
  await dev(["shell", "x"]).catch(() => {});
  assert.equal(reconnects(), 1);
  t = 30_000;
  await dev(["shell", "x"]).catch(() => {});
  assert.equal(reconnects(), 2, "冷却过了还卡着：下一次超时就再重连");
  // 时好时坏：成功只清计数，不清冷却
  t = 40_000;
  hang = false;
  await dev(["shell", "x"]);
  hang = true;
  await dev(["shell", "x"]).catch(() => {});
  await dev(["shell", "x"]).catch(() => {});
  assert.equal(reconnects(), 2, "上次重连才过 10 秒，不再重连");
  t = 70_000;
  hang = false;
  await dev(["shell", "x"]);
  hang = true;
  await dev(["shell", "x"]).catch(() => {});
  assert.equal(reconnects(), 2, "成功过一次，之前的超时不再算");
  await dev(["shell", "x"]).catch(() => {});
  assert.equal(reconnects(), 3);
});

test("真机（不是 emulator-）超时不自动重连", async () => {
  const f = scriptedExec(() => true);
  const adb = createAdb({ exec: f.exec, execBuffer: async () => { throw new AdbUnresponsive(); }, log: () => {}, now: () => 0 });
  for (let i = 0; i < 3; i++) await adb.device("R5CT1234")(["shell", "x"]).catch(() => {});
  for (let i = 0; i < 3; i++) await adb.deviceBuffer("R5CT1234")(["exec-out", "screencap", "-p"]).catch(() => {});
  assert.ok(!f.calls.some((c) => c.endsWith(" reconnect")));
});

test("重连完成后通知订阅了这台设备的模块，取消订阅后不再通知", async () => {
  const f = scriptedExec((a) => a[2] === "shell");
  const adb = createAdb({ exec: f.exec, log: () => {}, now: () => 0 });
  let a = 0;
  let b = 0;
  const offA = adb.onReconnect("emulator-5554", () => a++);
  adb.onReconnect("emulator-5556", () => b++);
  const dev = adb.device("emulator-5554");
  await dev(["shell", "x"]).catch(() => {});
  await dev(["shell", "x"]).catch(() => {});
  await sleep(0);
  assert.equal(a, 1);
  assert.equal(b, 0);
  offA();
  const adb2 = createAdb({ exec: f.exec, log: () => {}, now: () => 0 });
  const off2 = adb2.onReconnect("emulator-5554", () => a++);
  off2();
  await adb2.device("emulator-5554")(["shell", "x"]).catch(() => {});
  await adb2.device("emulator-5554")(["shell", "x"]).catch(() => {});
  await sleep(0);
  assert.equal(a, 1);
});

test("别的失败、长任务超时、别的设备都不触发重连", async () => {
  const calls: string[] = [];
  const adb = createAdb({
    exec: async (args) => {
      calls.push(args.join(" "));
      if (args.includes("bad")) throw new Error("exit 1");
      throw new AdbUnresponsive();
    },
    log: () => {},
    now: () => 0,
  });
  await adb.device("emulator-5554")(["shell", "bad"]).catch(() => {});
  await adb.device("emulator-5554")(["shell", "bad"]).catch(() => {});
  await adb.long("emulator-5554")(["install", "a.apk"], 1000).catch(() => {});
  await adb.long("emulator-5554")(["install", "a.apk"], 1000).catch(() => {});
  await adb.device("emulator-5554")(["shell", "x"]).catch(() => {});
  await adb.device("emulator-5556")(["shell", "x"]).catch(() => {});
  assert.ok(!calls.some((c) => c.endsWith(" reconnect")));
});
