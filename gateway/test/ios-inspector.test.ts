import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createIosInspector, createWirParser, legacyProtocolVersion, wirFrame } from "../src/ios-inspector.ts";

test("legacyProtocolVersion：取不超过模拟器版本的最大命令表；比所有都旧时为 null", () => {
  const have = ["13.0", "17.4", "18.0", "18.2", "18.4", "26.0", "27.0"];
  assert.equal(legacyProtocolVersion("iOS 18.3", have), "18.2");
  assert.equal(legacyProtocolVersion("iOS 27.1", have), "27.0");
  assert.equal(legacyProtocolVersion("iOS 27.0", have), "27.0");
  assert.equal(legacyProtocolVersion("iOS 12.4", have), null);
  assert.equal(legacyProtocolVersion("", have), null);
});

/** 假的 webinspectord：收到请求按选择子回话。 */
function fakeDaemon(script: (selector: string, arg: Record<string, unknown>, reply: (s: string, a: Record<string, unknown>) => void) => void) {
  const toGateway = new PassThrough();
  const fromGateway = new PassThrough();
  const sent: Array<{ selector: string; arg: Record<string, unknown> }> = [];
  const push = toGateway.write.bind(toGateway);
  const reply = (s: string, a: Record<string, unknown>) => push(wirFrame(s, a as never));
  fromGateway.on("data", createWirParser((selector, arg) => {
    sent.push({ selector, arg });
    script(selector, arg, reply);
  }));
  // 网关读 toGateway、写 fromGateway：拼成一个 Duplex
  const sock = Object.assign(toGateway, { write: (c: Buffer) => fromGateway.write(c) }) as unknown as import("node:stream").Duplex;
  return { sock, sent, reply };
}

test("list：报身份、取应用、按应用取页面；只要网页，socket 是应用 id、id 是页面编号", async () => {
  const d = fakeDaemon((s, a, reply) => {
    if (s === "_rpc_getConnectedApplications:") reply("_rpc_reportConnectedApplicationList:", { WIRApplicationDictionaryKey: { "PID:1": { WIRApplicationIdentifierKey: "PID:1", WIRApplicationBundleIdentifierKey: "com.apple.mobilesafari" } } });
    if (s === "_rpc_forwardGetListing:" && a.WIRApplicationIdentifierKey === "PID:1") {
      reply("_rpc_applicationSentListing:", { WIRApplicationIdentifierKey: "PID:1", WIRListingKey: {
        "1": { WIRPageIdentifierKey: 1, WIRTitleKey: "Example", WIRURLKey: "https://example.com/", WIRTypeKey: "WIRTypeWebPage" },
        "2": { WIRPageIdentifierKey: 2, WIRTitleKey: "ctx", WIRURLKey: "", WIRTypeKey: "WIRTypeJavaScript" },
      } });
    }
  });
  const insp = createIosInspector({ connect: async () => d.sock });
  const pages = await insp.list();
  assert.deepEqual(pages, [{ socket: "PID:1", id: "1", title: "Example", url: "https://example.com/", pkg: "com.apple.mobilesafari", visible: true }]);
  assert.deepEqual(d.sent.map((m) => m.selector), ["_rpc_reportIdentifier:", "_rpc_getConnectedApplications:", "_rpc_forwardGetListing:"]);
  insp.close();
});

test("open：建通道、前端消息转成 forwardSocketData；页面数据按 WIRDestinationKey 交给对应通道，onMessage 之前到的先存着", async () => {
  const d = fakeDaemon(() => {});
  const insp = createIosInspector({ connect: async () => d.sock });
  const ch = await insp.open("PID:1", "1");
  await new Promise((r) => setImmediate(r));
  const setup = d.sent.find((m) => m.selector === "_rpc_forwardSocketSetup:")!;
  const sender = setup.arg.WIRSenderKey as string;
  assert.equal(setup.arg.WIRPageIdentifierKey, 1);
  d.reply("_rpc_applicationSentData:", { WIRDestinationKey: sender, WIRMessageDataKey: Buffer.from('{"method":"Target.targetCreated"}') });
  d.reply("_rpc_applicationSentData:", { WIRDestinationKey: "someone-else", WIRMessageDataKey: Buffer.from("x") });
  await new Promise((r) => setImmediate(r));
  const got: string[] = [];
  ch.onMessage((m) => got.push(m));
  assert.deepEqual(got, ['{"method":"Target.targetCreated"}']);
  ch.send('{"id":1,"method":"Target.sendMessageToTarget"}');
  await new Promise((r) => setImmediate(r));
  const data = d.sent.find((m) => m.selector === "_rpc_forwardSocketData:")!;
  assert.equal((data.arg.WIRSocketDataKey as Buffer).toString(), '{"id":1,"method":"Target.sendMessageToTarget"}');
  let closed = 0;
  ch.onClose(() => closed++);
  d.reply("_rpc_applicationDisconnected:", { WIRApplicationIdentifierKey: "PID:2" });
  await new Promise((r) => setImmediate(r));
  assert.equal(closed, 0);
  d.reply("_rpc_applicationDisconnected:", { WIRApplicationIdentifierKey: "PID:1" });
  await new Promise((r) => setImmediate(r));
  assert.equal(closed, 1);
});
