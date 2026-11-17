import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogcatHub, dumpLogcat, parseApps, readLogcat, type LogcatDeps } from "../src/logcat.ts";
import type { AdbStreamHandlers } from "../src/adb.ts";
import type { LogFilter, LogLine } from "../../shared/logcat.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ALL: LogFilter = { pkg: null, level: "V", text: "" };
const line = (pid: number, tag: string, msg: string, level = "I") => `11-16 18:00:52.531  ${pid}  ${pid} ${level} ${tag}: ${msg}\n`;

/** 假 adb：记下每台设备的进程，可以推数据、让它退出。 */
function fakes(over: Partial<LogcatDeps> = {}) {
  const procs: Array<{ id: string; h: AdbStreamHandlers; stopped: boolean }> = [];
  const pids = new Map<string, number[]>();
  const deps: LogcatDeps = {
    stream: (id, h) => {
      const p = { id, h, stopped: false };
      procs.push(p);
      return { stop: () => void (p.stopped = true) };
    },
    pidof: async (_id, pkg) => pids.get(pkg) ?? [],
    batchMs: 10,
    pidRefreshMs: 1000,
    restartMs: [20, 40],
    log: () => {},
    ...over,
  };
  const live = (id: string) => procs.filter((p) => p.id === id && !p.stopped);
  const push = (id: string, s: string) => { for (const p of live(id)) p.h.onData(s); };
  return { deps, procs, pids, live, push };
}

function collector() {
  const batches: Array<{ lines: LogLine[]; reset: boolean }> = [];
  return { batches, cb: (lines: LogLine[], reset: boolean) => void batches.push({ lines, reset }), all: () => batches.flatMap((b) => b.lines) };
}

test("同一台设备两个订阅者只起一个进程，各收各的过滤结果", async () => {
  const f = fakes();
  const hub = createLogcatHub(f.deps);
  const a = collector();
  const b = collector();
  hub.subscribe("R5", ALL, a.cb);
  hub.subscribe("R5", { pkg: null, level: "W", text: "" }, b.cb);
  await sleep(5);
  assert.equal(f.procs.length, 1);
  f.push("R5", line(1, "A", "info", "I") + line(1, "B", "warn", "W"));
  await sleep(30);
  assert.deepEqual(a.all().map((l) => l.tag), ["A", "B"]);
  assert.deepEqual(b.all().map((l) => l.tag), ["B"]);
  hub.close();
});

test("最后一个订阅者 close 后进程结束；再订阅会重新起", async () => {
  const f = fakes();
  const hub = createLogcatHub(f.deps);
  const s1 = hub.subscribe("R5", ALL, () => {});
  const s2 = hub.subscribe("R5", ALL, () => {});
  s1.close();
  assert.equal(f.live("R5").length, 1);
  s2.close();
  assert.equal(f.live("R5").length, 0);
  hub.subscribe("R5", ALL, () => {});
  assert.equal(f.procs.length, 2);
  hub.close();
});

test("一行被切在两次 data 之间（含中文）也能完整解析", async () => {
  const f = fakes();
  const hub = createLogcatHub(f.deps);
  const a = collector();
  hub.subscribe("R5", ALL, a.cb);
  await sleep(5);
  const s = line(7, "中文标签", "你好，世界");
  f.push("R5", s.slice(0, 30));
  f.push("R5", s.slice(30));
  await sleep(30);
  assert.deepEqual(a.all().map((l) => [l.tag, l.msg]), [["中文标签", "你好，世界"]]);
  hub.close();
});

test("10000 行在一个合批窗口内只回调一次", async () => {
  const f = fakes({ batchMs: 50 });
  const hub = createLogcatHub(f.deps);
  const a = collector();
  hub.subscribe("R5", ALL, a.cb);
  await sleep(5);
  const before = a.batches.length;
  f.push("R5", Array.from({ length: 10000 }, (_, i) => line(1, "T", `m${i}`)).join(""));
  await sleep(80);
  const after = a.batches.slice(before).filter((b) => !b.reset);
  assert.equal(after.length, 1);
  assert.equal(after[0].lines.length, 10000);
  hub.close();
});

test("subscribe / setFilter 先用 reset 回放缓冲里匹配的最近行（至多 replay 行）", async () => {
  const f = fakes({ replay: 3 });
  const hub = createLogcatHub(f.deps);
  hub.subscribe("R5", ALL, () => {});
  await sleep(5);
  f.push("R5", line(1, "X", "1") + line(1, "Y", "2") + line(1, "X", "3") + line(1, "X", "4") + line(1, "X", "5"));
  await sleep(30);
  const b = collector();
  const sub = hub.subscribe("R5", { pkg: null, level: "V", text: "x" }, b.cb);
  await sleep(5);
  assert.equal(b.batches[0].reset, true);
  assert.deepEqual(b.batches[0].lines.map((l) => l.msg), ["3", "4", "5"]);
  sub.setFilter({ pkg: null, level: "V", text: "y" });
  await sleep(5);
  assert.deepEqual(b.batches.at(-1), { lines: [b.batches.at(-1)!.lines[0]], reset: true });
  assert.equal(b.batches.at(-1)!.lines[0].msg, "2");
  hub.close();
});

test("缓冲超过 keep 丢最旧的", async () => {
  const f = fakes({ keep: 3, replay: 100 });
  const hub = createLogcatHub(f.deps);
  hub.subscribe("R5", ALL, () => {});
  await sleep(5);
  f.push("R5", ["1", "2", "3", "4", "5"].map((m) => line(1, "T", m)).join(""));
  await sleep(30);
  const b = collector();
  hub.subscribe("R5", ALL, b.cb);
  await sleep(5);
  assert.deepEqual(b.batches[0].lines.map((l) => l.msg), ["3", "4", "5"]);
  hub.close();
});

test("按包名过滤：Start proc 日志里的新 pid 立刻生效，不等重查", async () => {
  const f = fakes();
  f.pids.set("com.a", [100]);
  const hub = createLogcatHub(f.deps);
  const a = collector();
  hub.subscribe("R5", { pkg: "com.a", level: "V", text: "" }, a.cb);
  await sleep(5);
  f.push("R5", line(100, "App", "old") + line(1456, "ActivityManager", "Start proc 200:com.a/u0a300 for pre-top-activity {com.a/com.a.Main}") + line(200, "App", "new") + line(300, "Other", "x"));
  await sleep(30);
  assert.deepEqual(a.all().map((l) => l.msg), ["old", "new"]);
  hub.close();
});

test("按包名过滤：定时重查 pidof 的结果会替换 pid 集合", async () => {
  const f = fakes({ pidRefreshMs: 20 });
  f.pids.set("com.a", [100]);
  const hub = createLogcatHub(f.deps);
  const a = collector();
  hub.subscribe("R5", { pkg: "com.a", level: "V", text: "" }, a.cb);
  await sleep(5);
  f.pids.set("com.a", [101]);
  await sleep(40);
  f.push("R5", line(100, "App", "gone") + line(101, "App", "now"));
  await sleep(30);
  assert.deepEqual(a.all().map((l) => l.msg), ["now"]);
  hub.close();
});

/** 手动控制返回时机的 pidof：calls 里每次调用一个 resolve。 */
function slowPidof() {
  const calls: Array<(p: number[]) => void> = [];
  return { calls, pidof: () => new Promise<number[]>((r) => void calls.push(r)) };
}
const START_200 = line(1456, "ActivityManager", "Start proc 200:com.a/u0a300 for pre-top-activity {com.a/com.a.Main}");

test("按包名过滤：首次 pidof 还没回来时出现的 Start proc，查询回来后新 pid 仍然有效", async () => {
  const p = slowPidof();
  const f = fakes({ pidof: p.pidof });
  const hub = createLogcatHub(f.deps);
  const a = collector();
  hub.subscribe("R5", { pkg: "com.a", level: "V", text: "" }, a.cb);
  f.push("R5", START_200);
  await sleep(5);
  p.calls[0]([100]);
  await sleep(5);
  f.push("R5", line(200, "App", "new"));
  await sleep(30);
  assert.deepEqual(a.all().map((l) => l.msg), ["new"]);
  hub.close();
});

test("按包名过滤：重查 pidof 期间出现的 Start proc，不会被查询结果冲掉", async () => {
  const p = slowPidof();
  const f = fakes({ pidof: p.pidof, pidRefreshMs: 10 });
  const hub = createLogcatHub(f.deps);
  const a = collector();
  hub.subscribe("R5", { pkg: "com.a", level: "V", text: "" }, a.cb);
  p.calls[0]([100]);
  await sleep(25);
  assert.equal(p.calls.length, 2);
  f.push("R5", START_200);
  await sleep(5);
  p.calls[1]([100]);
  await sleep(5);
  f.push("R5", line(200, "App", "new"));
  await sleep(30);
  assert.deepEqual(a.all().map((l) => l.msg), ["new"]);
  hub.close();
});

test("按包名过滤：上一次重查没回来时不再发新的 pidof", async () => {
  const p = slowPidof();
  const f = fakes({ pidof: p.pidof, pidRefreshMs: 10 });
  const hub = createLogcatHub(f.deps);
  hub.subscribe("R5", { pkg: "com.a", level: "V", text: "" }, () => {});
  p.calls[0]([100]);
  await sleep(80);
  assert.equal(p.calls.length, 2);
  hub.close();
});

test("进程意外退出且还有订阅者：restartMs 后重启；订阅者都走了就不再重启", async () => {
  const f = fakes();
  const hub = createLogcatHub(f.deps);
  const s = hub.subscribe("R5", ALL, () => {});
  f.procs[0].h.onExit(1);
  await sleep(30);
  assert.equal(f.procs.length, 2);
  f.procs[1].h.onExit(1);
  s.close();
  await sleep(60);
  assert.equal(f.procs.length, 2);
  hub.close();
});

test("parseApps：只取 u0_a 用户的进程，去掉 :子进程，丢掉不像包名的，去重排序（SM-G9910 的 ps 输出）", () => {
  const out = [
    "USER         NAME                       ",
    "root         init",
    "u0_a57       com.android.systemui",
    "u0_a278      .qtidataservices",
    "u0_a284      com.qualcomm.qti.services.systemhelper:systemhelper_service",
    "u0_a284      com.qualcomm.qti.services.systemhelper",
    "u0_a138      com.sec.android.app.launcher",
  ].join("\n");
  assert.deepEqual(parseApps(out), ["com.android.systemui", "com.qualcomm.qti.services.systemhelper", "com.sec.android.app.launcher"]);
});

test("readLogcat：按级别和关键词过滤，只留最后 limit 行", () => {
  const dump = line(1, "A", "x1", "E") + line(1, "A", "x2", "I") + line(1, "A", "x3", "E") + line(1, "B", "y", "E");
  assert.deepEqual(readLogcat(dump, [], { pkg: null, level: "E", text: "x" }, 1).map((l) => l.msg), ["x3"]);
});

test("readLogcat：App 已退出时用 Start proc / 崩溃日志里的 pid", () => {
  const dump = line(1456, "ActivityManager", "Start proc 300:com.a/u0a300 for pre-top-activity {com.a/com.a.Main}")
    + line(300, "App", "before crash")
    + line(400, "AndroidRuntime", "Process: com.a, PID: 400", "E") + line(400, "AndroidRuntime", "java.lang.NullPointerException", "E")
    + line(500, "Other", "noise");
  assert.deepEqual(readLogcat(dump, [], { pkg: "com.a", level: "V", text: "" }, 100).map((l) => l.msg),
    ["before crash", "Process: com.a, PID: 400", "java.lang.NullPointerException"]);
});

test("readLogcat：pidof 给的 pid 也算", () => {
  assert.deepEqual(readLogcat(line(7, "App", "hi"), [7], { pkg: "com.a", level: "V", text: "" }, 10).map((l) => l.msg), ["hi"]);
});

test("dumpLogcat：5000 行超过 adb 输出上限时改读 1000 行；其他错误原样抛", async () => {
  const asked: number[] = [];
  const tooBig = Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  const out = await dumpLogcat(async (n) => {
    asked.push(n);
    if (n > 1000) throw tooBig;
    return "ok";
  });
  assert.equal(out, "ok");
  assert.deepEqual(asked, [5000, 1000]);
  await assert.rejects(dumpLogcat(async () => { throw tooBig; }), /日志行太长/);
  await assert.rejects(dumpLogcat(async () => { throw new Error("device offline"); }), /device offline/);
});
