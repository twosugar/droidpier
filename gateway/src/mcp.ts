// MCP（Model Context Protocol）服务端：每行一条 JSON-RPC 消息，只实现工具（tools）这一部分。
// 规范：https://modelcontextprotocol.io/specification/2025-06-18。传输在 gateway/src/mcp-socket.ts。

/** 工具返回的一段内容：文字，或一张图（base64）。 */
export type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** 一个工具。run 抛错时把错误信息当工具失败（isError）回给 AI，不算协议错误。 */
export type McpTool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run: (args: Record<string, unknown>) => Promise<McpContent[]>;
};

const LATEST = "2025-06-18";
const KNOWN_VERSIONS = new Set([LATEST, "2025-03-26", "2024-11-05"]);

type Id = string | number | null;
const reply = (id: Id, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });
const fail = (id: Id, code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

/** tools 每次取：设备、网关状态变了，工具表可以跟着变。 */
export function createMcpServer(opts: { name: string; version: string; instructions: string; tools: () => McpTool[] }) {
  return {
    /** 处理一行；要回话时返回回话那一行，通知返回 null。 */
    async handle(line: string): Promise<string | null> {
      let msg: { id?: Id; method?: unknown; params?: any };
      try {
        msg = JSON.parse(line);
      } catch {
        return fail(null, -32700, "不是合法的 JSON");
      }
      if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return msg && "id" in msg ? fail(msg.id ?? null, -32600, "不是请求") : null;
      // 没有 id 的是通知（notifications/initialized、notifications/cancelled），不回话
      if (!("id" in msg) || msg.id === undefined) return null;
      const id = msg.id;
      switch (msg.method) {
        case "initialize": {
          const asked = msg.params?.protocolVersion;
          return reply(id, {
            protocolVersion: typeof asked === "string" && KNOWN_VERSIONS.has(asked) ? asked : LATEST,
            capabilities: { tools: {} },
            serverInfo: { name: opts.name, version: opts.version },
            instructions: opts.instructions,
          });
        }
        case "ping":
          return reply(id, {});
        case "tools/list":
          return reply(id, { tools: opts.tools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
        case "tools/call": {
          const tool = opts.tools().find((t) => t.name === msg.params?.name);
          if (!tool) return fail(id, -32602, `没有这个工具：${String(msg.params?.name)}`);
          const args = msg.params?.arguments;
          try {
            return reply(id, { content: await tool.run(args && typeof args === "object" ? args : {}) });
          } catch (e) {
            return reply(id, { content: [{ type: "text", text: (e as Error).message }], isError: true });
          }
        }
        default:
          return fail(id, -32601, `不支持的方法：${msg.method}`);
      }
    },
  };
}
