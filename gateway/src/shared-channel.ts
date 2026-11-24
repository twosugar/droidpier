// iOS 页面的调试通道给几方共用（页面里的调试界面、MCP 的 AI）。
// WebKit 一个页面同一时间只认一条调试通道，新连上的会把旧的顶掉（2026-11-22、11-24 iOS 18.3 模拟器实测），
// 所以这里只开一条，各方的请求编号改写成不重复的再发，回话按编号送回发请求的那方，事件（没有 id 的）发给每一方。
// 消息分两层：外层是 Target 域，页面上的命令包在 Target.sendMessageToTarget 的 message 里，回话在
// Target.dispatchMessageFromTarget 里，两层的编号都要改写。
//
// 调试界面（frontend）加入或离开、通道上还有别的使用方时，底层通道关掉重开（重置）：
// - 调试界面会开「新页面启动时先暂停」（Target.setPauseOnStart）、下断点，平时它自己放行；它走了这些还留在通道上，
//   页面换页时新页面停在启动处没人放行，一直不加载（2026-11-24 iOS 18.3 模拟器复现）。
// - WebKit 的各个域只在通道上第一次 enable 时补发已有的状态（脚本、样式、历史 console），后加入的调试界面拿不到。
// 别的使用方先收到 Droidpier.channelReset（没回的请求都作废），再收到新通道上的页面目标。
import type { InspectorChannel } from "./ios-inspector.ts";

/** frontend：页面里的调试界面（WebInspectorUI），会留下暂停、断点等状态；tool：MCP 这类只发命令、收事件的。 */
export type ConsumerKind = "frontend" | "tool";
/** 重置时发给其余使用方的消息。 */
export const CHANNEL_RESET = "Droidpier.channelReset";

type TargetInfo = { targetId: string; isProvisional?: boolean; [k: string]: unknown };
type Link = { ch: InspectorChannel; consumers: Set<Consumer>; targets: Map<string, TargetInfo>; retired: boolean };
type Consumer = { kind: ConsumerKind; link: Link; deliver(m: string): void; closed(): void };

const parse = (m: string): any => {
  try {
    return JSON.parse(m);
  } catch {
    return null;
  }
};
const createdMsg = (t: TargetInfo) => JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: t } });

export function createSharedChannel(open: () => Promise<InspectorChannel>) {
  let link: Link | null = null;
  let opening: Promise<Link> | null = null;
  // 重置、加入按顺序来：同时两个调试界面进出时不交叉重开
  let queue: Promise<unknown> = Promise.resolve();
  let nextId = 1;
  // 改写后的编号 → 谁发的、原来的编号、在哪条通道上；外层、里层各一张
  type Pending = { c: Consumer; id: unknown; l: Link };
  const outer = new Map<number, Pending>();
  const inner = new Map<number, Pending>();
  const forget = (match: (p: Pending) => boolean) => {
    for (const map of [outer, inner]) for (const [k, v] of map) if (match(v)) map.delete(k);
  };

  const onUnderlying = (l: Link, raw: string) => {
    const msg = parse(raw);
    if (!msg) return;
    if (msg.id !== undefined) {
      const to = outer.get(msg.id);
      outer.delete(msg.id);
      if (to && to.l === l && l.consumers.has(to.c)) to.c.deliver(JSON.stringify({ ...msg, id: to.id }));
      return;
    }
    const p = msg.params ?? {};
    if (msg.method === "Target.dispatchMessageFromTarget" && typeof p.message === "string") {
      const im = parse(p.message);
      if (im?.id !== undefined) {
        const to = inner.get(im.id);
        inner.delete(im.id);
        if (to && to.l === l && l.consumers.has(to.c)) to.c.deliver(JSON.stringify({ ...msg, params: { ...p, message: JSON.stringify({ ...im, id: to.id }) } }));
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
        const l: Link = { ch, consumers: new Set(), targets: new Map(), retired: false };
        link = l;
        opening = null;
        ch.onMessage((m) => {
          if (!l.retired) onUnderlying(l, m);
        });
        ch.onClose(() => {
          // 重置时自己关的旧通道：使用方已经搬走了
          if (l.retired) return;
          l.retired = true;
          if (link === l) link = null;
          forget((p) => p.l === l);
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

  /** 关掉 old 重开一条，把 old 上的使用方（除了 leaving）搬过去。重开失败时它们都收到关闭。 */
  const reset = async (old: Link) => {
    old.retired = true;
    if (link === old) link = null;
    forget((p) => p.l === old);
    old.ch.close();
    let next: Link;
    try {
      next = await connect();
    } catch {
      for (const c of [...old.consumers]) c.closed();
      old.consumers.clear();
      return;
    }
    for (const c of old.consumers) {
      c.link = next;
      next.consumers.add(c);
      c.deliver(JSON.stringify({ method: CHANNEL_RESET }));
      for (const t of next.targets.values()) c.deliver(createdMsg(t));
    }
    old.consumers.clear();
  };

  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const r = queue.then(f);
    queue = r.catch(() => {});
    return r;
  };

  return {
    /** 接入一方：拿到的通道和 ios-inspector 的 open() 用法一样。 */
    attach(kind: ConsumerKind = "tool"): Promise<InspectorChannel> {
      return serial(async () => {
        let l = link ?? (await connect());
        if (kind === "frontend" && l.consumers.size > 0) {
          await reset(l);
          l = link ?? (await connect());
        }
        const msgCbs: Array<(m: string) => void> = [];
        const closeCbs: Array<() => void> = [];
        // 先到的消息存着，onMessage 挂上时一次交出去：已有的页面目标先补给它（它错过了 targetCreated）
        const early: string[] = [...l.targets.values()].map(createdMsg);
        let gone = false;
        const c: Consumer = {
          kind,
          link: l,
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
            const cur = c.link;
            const msg = parse(raw);
            if (!msg || msg.id === undefined) return void cur.ch.send(raw);
            const id = nextId++;
            outer.set(id, { c, id: msg.id, l: cur });
            if (msg.method === "Target.sendMessageToTarget" && typeof msg.params?.message === "string") {
              const im = parse(msg.params.message);
              if (im?.id !== undefined) {
                const iid = nextId++;
                inner.set(iid, { c, id: im.id, l: cur });
                msg.params = { ...msg.params, message: JSON.stringify({ ...im, id: iid }) };
              }
            }
            cur.ch.send(JSON.stringify({ ...msg, id }));
          },
          onMessage: (cb) => {
            msgCbs.push(cb);
            for (const m of early.splice(0)) cb(m);
          },
          onClose: (cb) => void closeCbs.push(cb),
          close: () => {
            if (gone) return;
            gone = true;
            forget((p) => p.c === c);
            const cur = c.link;
            cur.consumers.delete(c);
            if (cur.retired) return;
            if (cur.consumers.size === 0) {
              cur.retired = true;
              if (link === cur) link = null;
              cur.ch.close();
            } else if (kind === "frontend") void serial(() => reset(cur));
          },
        };
      });
    },
  };
}
