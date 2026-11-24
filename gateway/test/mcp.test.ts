import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpServer, type McpTool } from "../src/mcp.ts";

const echo: McpTool = {
  name: "echo",
  description: "原样返回",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  run: async (args) => [{ type: "text", text: String(args.text) }],
};
const boom: McpTool = {
  name: "boom",
  description: "总是失败",
  inputSchema: { type: "object", properties: {} },
  run: async () => {
    throw new Error("设备没连上");
  },
};
const server = () => createMcpServer({ name: "droidpier", version: "1.2.3", instructions: "说明", tools: () => [echo, boom] });
const call = async (line: string) => {
  const out = await server().handle(line);
  return out === null ? null : JSON.parse(out);
};

test("initialize：回协议版本、工具能力、名字和说明；客户端要的版本认识就用它的", async () => {
  const r = await call(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } } }));
  assert.deepEqual(r, {
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "droidpier", version: "1.2.3" }, instructions: "说明" },
  });
  const unknown = await call(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }));
  assert.equal(unknown.result.protocolVersion, "2025-06-18");
});

test("tools/list 列出每个工具的名字、说明和参数格式", async () => {
  const r = await call(JSON.stringify({ jsonrpc: "2.0", id: "a", method: "tools/list" }));
  assert.deepEqual(r.result.tools.map((t: { name: string }) => t.name), ["echo", "boom"]);
  assert.deepEqual(r.result.tools[0], { name: "echo", description: "原样返回", inputSchema: echo.inputSchema });
});

test("tools/call：成功给 content；工具抛错时 isError 带原因，不算协议错误；不认识的工具是协议错误", async () => {
  const ok = await call(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } }));
  assert.deepEqual(ok.result, { content: [{ type: "text", text: "hi" }] });
  const bad = await call(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom", arguments: {} } }));
  assert.deepEqual(bad.result, { content: [{ type: "text", text: "设备没连上" }], isError: true });
  const none = await call(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } }));
  assert.equal(none.error.code, -32602);
});

test("通知不回话；ping 回空结果；不认识的方法 -32601；不是 JSON -32700", async () => {
  assert.equal(await call(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })), null);
  assert.deepEqual((await call(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" }))).result, {});
  assert.equal((await call(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "resources/list" }))).error.code, -32601);
  const parse = await call("{oops");
  assert.equal(parse.error.code, -32700);
  assert.equal(parse.id, null);
});
