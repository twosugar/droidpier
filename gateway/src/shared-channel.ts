// iOS 页面的调试通道给几方共用（页面里的调试界面、MCP 的 AI）。
// WebKit 一个页面同一时间只认一条调试通道，新连上的会把旧的顶掉（2026-11-22、11-24 iOS 18.3 模拟器实测），
// 所以这里只开一条，各方的请求编号改写成不重复的再发，回话按编号送回发请求的那方，事件（没有 id 的）发给每一方。
// 消息分两层：外层是 Target 域，页面上的命令包在 Target.sendMessageToTarget 的 message 里，回话在
// Target.dispatchMessageFromTarget 里，两层的编号都要改写。
import type { InspectorChannel } from "./ios-inspector.ts";

type Consumer = { deliver(m: string): void; closed(): void };
type TargetInfo = { targetId: string; isProvisional?: boolean; [k: string]: unknown };
type Link = { ch: InspectorChannel; consumers: Set<Consumer>; targets: Map<string, TargetInfo> };

export function createSharedChannel(open: () => Promise<InspectorChannel>) {
  let link: Link | null = null;
  let opening: Promise<Link> | null = null;
  let nextId = 1;
  // 改写后的编号 → 谁发的、原来的编号；外层、里层各一张
  const outer = new Map<number, { c: Consumer; id: unknown }>();
  const inner = new Map<number, { c: Consumer; id: unknown }>();

  const parse = (m: string): any => {
    try {
      return JSON.parse(m);
    } catch {
      return null;
    }
  };

  const onUnderlying = (l: Link, raw: string) => {
    const msg = parse(raw);
    if (!msg) return;
    if (msg.id !== undefined) {
      const to = outer.get(msg.id);
      outer.delete(msg.id);
      if (to && l.consumers.has(to.c)) to.c.deliver(JSON.stringify({ ...msg, id: to.id }));
      return;
    }
    const p = msg.params ?? {};
    if (msg.method === "Target.dispatchMessageFromTarget" && typeof p.message === "string") {
      const im = parse(p.message);
      if (im?.id !== undefined) {
        const to = inner.get(im.id);
        inner.delete(im.id);
        if (to && l.consumers.has(to.c)) to.c.deliver(JSON.stringify({ ...msg, params: { ...p, message: JSON.stringify({ ...im, id: to.id }) } }));
        return;
      }
    } else if (msg.method === "Target.targetCreated" && p.targetInfo?.targetId) {
      l.targets.set(p.targetInfo.targetId, { ...p.targetInfo });
    } else if (msg.method === "Target.targetDestroyed") {
      l.targets.delete(p.targetId);
    } else if (msg.method === "Target.didCommitProvisionalTarget") {
      // 换页：临时目标转正，旧目标作废
      if (p.oldTargetId) l.targets.delete(p.oldTargetId);
      const t = l.targets.get(p.newTargetId);
      if (t) t.isProvisional = false;
    }
    for (const c of l.consumers) c.deliver(raw);
  };

  const connect = () =>
    (opening ??= open().then(
      (ch): Link => {
        const l: Link = { ch, consumers: new Set(), targets: new Map() };
        link = l;
        opening = null;
        ch.onMessage((m) => onUnderlying(l, m));
        ch.onClose(() => {
          if (link === l) link = null;
          for (const c of [...l.consumers]) c.closed();
          l.consumers.clear();
        });
        return l;
      },
      (e) => {
        opening = null;
        throw e;
      },
    ));

  return {
    /** 接入一方：拿到的通道和 ios-inspector 的 open() 用法一样。 */
    async attach(): Promise<InspectorChannel> {
      const l = link ?? (await connect());
      const msgCbs: Array<(m: string) => void> = [];
      const closeCbs: Array<() => void> = [];
      // 先到的消息存着，onMessage 挂上时一次交出去：已有的页面目标先补给它（它错过了 targetCreated）
      const early: string[] = [...l.targets.values()].map((t) => JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: t } }));
      let gone = false;
      const c: Consumer = {
        deliver: (m) => (msgCbs.length ? msgCbs.forEach((cb) => cb(m)) : early.push(m)),
        closed: () => {
          if (gone) return;
          gone = true;
          for (const cb of closeCbs) cb();
        },
      };
      l.consumers.add(c);
      return {
        send: (raw) => {
          if (gone) return;
          const msg = parse(raw);
          if (!msg || msg.id === undefined) return void l.ch.send(raw);
          const id = nextId++;
          outer.set(id, { c, id: msg.id });
          if (msg.method === "Target.sendMessageToTarget" && typeof msg.params?.message === "string") {
            const im = parse(msg.params.message);
            if (im?.id !== undefined) {
              const iid = nextId++;
              inner.set(iid, { c, id: im.id });
              msg.params = { ...msg.params, message: JSON.stringify({ ...im, id: iid }) };
            }
          }
          l.ch.send(JSON.stringify({ ...msg, id }));
        },
        onMessage: (cb) => {
          msgCbs.push(cb);
          for (const m of early.splice(0)) cb(m);
        },
        onClose: (cb) => void closeCbs.push(cb),
        close: () => {
          if (gone) return;
          gone = true;
          l.consumers.delete(c);
          for (const map of [outer, inner]) for (const [k, v] of map) if (v.c === c) map.delete(k);
          if (l.consumers.size === 0 && link === l) {
            link = null;
            l.ch.close();
          }
        },
      };
    },
  };
}
