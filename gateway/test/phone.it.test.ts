import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { tmpdir } from "node:os";
import { createAdb } from "../src/adb.ts";
import type { DeviceSession } from "../src/emulator.ts";
import { connectPhone, type PhoneDeps } from "../src/phone-session.ts";
import { materializeScrcpyServer, scrcpyServerPath } from "../src/scrcpy-server.ts";
import { findFreePort, releasePort } from "../src/webviews.ts";

const id = process.env.PHONE_IT_SERIAL ?? "";
const skip = (process.env.PHONE_IT !== "1" || !id) && "需要插着的真机，设置 PHONE_IT=1 PHONE_IT_SERIAL=<序列号> 运行";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 和 gateway/src/main.ts 的 phoneDeps 同样的接法（main.ts 一 import 就会起网关，没法直接复用）
const deps = (): PhoneDeps => {
  const adb = createAdb({ log: () => {} });
  return {
    jarPath: () => materializeScrcpyServer(scrcpyServerPath(false), tmpdir()),
    push: (local, remote) => adb.long(id)(["push", local, remote], 60_000).then(() => {}),
    freePort: findFreePort,
    releasePort,
    forward: (port, scid) => adb.device(id)(["forward", `tcp:${port}`, `localabstract:scrcpy_${scid}`]).then(() => {}),
    removeForward: (port) => adb.device(id)(["forward", "--remove", `tcp:${port}`]).then(() => {}),
    startServer: (cmd, h) => adb.stream(["-s", id, "shell", cmd], h),
    connect: (port) => new Promise((res, rej) => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => res(sock));
      sock.once("error", rej);
    }),
    screencap: () => adb.deviceBuffer(id)(["exec-out", "screencap", "-p"], 10_000),
    log: () => {},
  };
};

// 测的是字节格式：服务端解析不了我们写的控制消息会抛 ControlProtocolException，控制线程退出、连接断开
test("每种控制消息发出后会话仍在：服务端能解析我们写的字节", { skip }, async () => {
  const s: DeviceSession = await connectPhone(id, deps());
  let closed = false;
  s.onClosed(() => (closed = true));
  try {
    const { width, height } = s.device;
    await s.touch(width / 2, height / 2, true);
    await s.touch(width / 2, height / 2 + 10, true);
    await s.touch(width / 2, height / 2 + 10, false);
    await s.scroll!(width / 2, height / 2, 0, 120);
    await s.key("GoHome", "keypress");
    await s.key("a", "keypress");
    await s.setClipboard("droidpier-it");
    await s.text("中文");
    await sleep(1000);
    assert.equal(closed, false);
  } finally {
    s.close();
  }
});
