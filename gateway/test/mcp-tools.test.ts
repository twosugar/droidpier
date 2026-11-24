import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpTools, type McpDeps } from "../src/mcp-tools.ts";
import type { CdpClient } from "../src/cdp.ts";
import type { WebViewPage } from "../../shared/protocol.ts";

const PAGE: WebViewPage = { socket: "webview_devtools_remote_1", id: "p1", title: "Demo", url: "https://example.com/", visible: true, pkg: "com.example" };
const BG: WebViewPage = { ...PAGE, id: "p2", title: "", url: "about:blank", visible: false };

/** 假的调试连接：handle 决定每条命令的回话，emit 推事件。 */
function fakeCdp(handle: (method: string, params: any) => any) {
  const listeners = new Map<string, Array<(p: any) => void>>();
  let closedResolve!: () => void;
  const f = {
    calls: [] as Array<{ method: string; params: any }>,
    closes: 0,
    emit: (event: string, p: any) => listeners.get(event)?.forEach((cb) => cb(p)),
    end: () => closedResolve(),
    cdp: {
      send: async (method: string, params?: any) => {
        f.calls.push({ method, params });
        return handle(method, params);
      },
      on: (event: string, cb: (p: any) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), cb]);
        return () => {};
      },
      close: () => void f.closes++,
      closed: new Promise<void>((r) => (closedResolve = r)),
    } as CdpClient,
  };
  return f;
}

function setup(webkit: boolean, handle: (method: string, params: any) => any = () => ({})) {
  const f = fakeCdp(handle);
  let connects = 0;
  const deps: McpDeps = {
    current: async () => ({ id: "emulator-5554", name: "Pixel 8", platform: webkit ? "ios" : "android", kind: "emulator", width: 1080, height: 2400 }),
    pages: async () => [PAGE, BG],
    connect: async () => (connects++, { cdp: f.cdp, webkit }),
    screenshot: async () => Buffer.from("png-bytes"),
  };
  const tools = createMcpTools(deps);
  const run = (name: string, args: Record<string, unknown> = {}) => tools.find((t) => t.name === name)!.run(args);
  return { f, run, connects: () => connects, deps };
}
const text = (c: Array<{ type: string; text?: string }>) => c.map((x) => x.text).join("\n");

test("device_status 说当前设备；没有设备时直接说没连", async () => {
  const s = setup(false);
  assert.match(text(await s.run("device_status")), /Pixel 8.*android/s);
  s.deps.current = async () => null;
  await assert.rejects(s.run("device_status"), /没有连接设备/);
});

test("list_pages 列出页面的 page 参数、标题、地址和是否在前台", async () => {
  const s = setup(false);
  const out = JSON.parse(text(await s.run("list_pages")));
  assert.deepEqual(out, [
    { page: "webview_devtools_remote_1/p1", title: "Demo", url: "https://example.com/", visible: true, app: "com.example" },
    { page: "webview_devtools_remote_1/p2", title: "", url: "about:blank", visible: false, app: "com.example" },
  ]);
});

test("evaluate（Android）：awaitPromise、returnByValue 交给页面，返回 JSON；异常时工具失败带说明", async () => {
  const s = setup(false, (method, params) =>
    params?.expression === "boom()" ? { result: { type: "object" }, exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: boom is not defined" } } } : { result: { type: "object", value: { a: 1 } } },
  );
  assert.equal(text(await s.run("evaluate", { expression: "({a:1})" })), '{"a":1}');
  const call = s.f.calls.find((c) => c.method === "Runtime.evaluate")!;
  assert.deepEqual(call.params, { expression: "({a:1})", returnByValue: true, awaitPromise: true });
  await assert.rejects(s.run("evaluate", { expression: "boom()" }), /ReferenceError: boom is not defined/);
  // 没给 page 时用唯一在前台的页面；同一页面只连一次
  assert.equal(s.connects(), 1);
});

test("evaluate（iOS）：WebKit 没有 awaitPromise 参数：先拿对象，Promise 用 awaitPromise 等，对象用 callFunctionOn 按值取回；wasThrown 当异常", async () => {
  const s = setup(true, (method, params) => {
    if (method === "Runtime.evaluate" && params.expression === "fetchIt()") return { result: { type: "object", className: "Promise", objectId: "o1" }, wasThrown: false };
    if (method === "Runtime.awaitPromise") return { result: { type: "number", value: 42 }, wasThrown: false };
    if (method === "Runtime.evaluate" && params.expression === "({a:1})") return { result: { type: "object", className: "Object", objectId: "o2" }, wasThrown: false };
    if (method === "Runtime.callFunctionOn") return { result: { type: "object", value: { a: 1 } }, wasThrown: false };
    if (method === "Runtime.evaluate" && params.expression === "1+1") return { result: { type: "number", value: 2 }, wasThrown: false };
    if (method === "Runtime.evaluate" && params.expression === "bad") return { result: { type: "object", description: "TypeError: x" }, wasThrown: true };
    return {};
  });
  assert.equal(text(await s.run("evaluate", { expression: "fetchIt()" })), "42");
  const ev = s.f.calls.find((c) => c.method === "Runtime.evaluate")!.params;
  assert.deepEqual(ev, { expression: "fetchIt()", objectGroup: "droidpier-mcp", returnByValue: false });
  assert.deepEqual(s.f.calls.find((c) => c.method === "Runtime.awaitPromise")!.params, { promiseObjectId: "o1", returnByValue: true });
  assert.equal(text(await s.run("evaluate", { expression: "({a:1})" })), '{"a":1}');
  assert.deepEqual(s.f.calls.find((c) => c.method === "Runtime.callFunctionOn")!.params, { objectId: "o2", functionDeclaration: "function () { return this; }", returnByValue: true });
  assert.equal(text(await s.run("evaluate", { expression: "1+1" })), "2");
  await assert.rejects(s.run("evaluate", { expression: "bad" }), /TypeError: x/);
  assert.ok(s.f.calls.some((c) => c.method === "Runtime.releaseObjectGroup" && c.params.objectGroup === "droidpier-mcp"));
});

test("page 参数：写错时说有哪些页面；不给且前台不止一个页面时要求指定", async () => {
  const s = setup(false);
  await assert.rejects(s.run("evaluate", { page: "nope/1", expression: "1" }), /没有这个页面.*webview_devtools_remote_1\/p1/s);
  s.deps.pages = async () => [PAGE, { ...PAGE, id: "p3" }];
  await assert.rejects(s.run("evaluate", { expression: "1" }), /前台有 2 个页面/);
});

test("console_logs（Android）：连上后开 Runtime 收集 console 和未捕获异常，按序号增量取", async () => {
  const s = setup(false, () => ({ result: { value: 1 } }));
  const first = JSON.parse(text(await s.run("console_logs", {})));
  assert.deepEqual(first, { next: 0, logs: [] });
  assert.ok(s.f.calls.some((c) => c.method === "Runtime.enable"));
  s.f.emit("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "hello" }, { type: "number", value: 2 }] });
  s.f.emit("Runtime.consoleAPICalled", { type: "error", args: [{ type: "object", description: "Error: x" }] });
  s.f.emit("Runtime.exceptionThrown", { exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: y" } } });
  const all = JSON.parse(text(await s.run("console_logs", {})));
  assert.deepEqual(all.logs.map((l: any) => [l.seq, l.level, l.text]), [[0, "log", "hello 2"], [1, "error", "Error: x"], [2, "error", "TypeError: y"]]);
  const more = JSON.parse(text(await s.run("console_logs", { since: 2 })));
  assert.deepEqual(more.logs.map((l: any) => l.seq), [2]);
  assert.equal(more.next, 3);
});

test("console_logs（iOS）：开 Console 域，收 Console.messageAdded", async () => {
  const s = setup(true);
  await s.run("console_logs", {});
  assert.ok(s.f.calls.some((c) => c.method === "Console.enable"));
  s.f.emit("Console.messageAdded", { message: { level: "warning", text: "careful", url: "https://example.com/a.js", line: 3 } });
  const out = JSON.parse(text(await s.run("console_logs", {})));
  assert.deepEqual(out.logs, [{ seq: 0, level: "warning", text: "careful", source: "https://example.com/a.js:3" }]);
});

test("连接断了下次重新连；screenshot 给 PNG 图片", async () => {
  const s = setup(false, () => ({ result: { value: 1 } }));
  await s.run("evaluate", { expression: "1" });
  s.f.end();
  await new Promise((r) => setTimeout(r, 0));
  await s.run("evaluate", { expression: "1" });
  assert.equal(s.connects(), 2);
  const shot = await s.run("screenshot");
  assert.deepEqual(shot, [{ type: "image", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" }]);
});
