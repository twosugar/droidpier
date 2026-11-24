// 把 iOS 页面的调试通道包成和 Android 一样的 CdpClient（gateway/src/cdp.ts）：命令发给当前的页面目标，
// 换页（WebKit 会换一个新目标）后跟到新目标上，并把之前开过的 *.enable 再发一遍，事件才不会断。
import type { CdpClient } from "./cdp.ts";
import type { InspectorChannel } from "./ios-inspector.ts";
import { CHANNEL_RESET } from "./shared-channel.ts";

export function webkitCdp(ch: InspectorChannel, timeoutMs = 10_000): CdpClient {
  let target: string | null = null;
  let targetWaiters: Array<() => void> = [];
  let nextId = 1;
  let gone = false;
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  const listeners = new Map<string, Set<(p: any) => void>>();
  // 开过的域：换到新目标时再开
  const enabled = new Map<string, object | undefined>();
  let closedResolve!: () => void;
  const closed = new Promise<void>((r) => (closedResolve = r));
  // 通道重置过（gateway/src/shared-channel.ts）：新通道上出现页面目标时把开过的域再开一遍
  let replay = false;
  const failAll = (why: string) => {
    for (const w of pending.values()) w.reject(new Error(why));
    pending.clear();
  };
  const emit = (event: string, params: unknown) => {
    for (const cb of listeners.get(event) ?? []) cb(params);
  };

  const post = (targetId: string, id: number, method: string, params?: object) =>
    ch.send(JSON.stringify({ id, method: "Target.sendMessageToTarget", params: { targetId, message: JSON.stringify({ id, method, ...(params ? { params } : {}) }) } }));

  const setTarget = (id: string) => {
    target = id;
    for (const w of targetWaiters.splice(0)) w();
  };

  ch.onMessage((raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const p = msg.params ?? {};
    if (msg.method === CHANNEL_RESET) {
      target = null;
      replay = enabled.size > 0;
      failAll("调试连接重置了（页面里的调试界面刚打开或关上），再试一次");
      emit(CHANNEL_RESET, {});
    } else if (msg.method === "Target.targetCreated" && p.targetInfo?.type === "page" && !p.targetInfo.isProvisional) {
      setTarget(p.targetInfo.targetId);
      if (replay) {
        replay = false;
        for (const [method, params] of enabled) post(p.targetInfo.targetId, nextId++, method, params);
      }
    }
    else if (msg.method === "Target.didCommitProvisionalTarget" && p.newTargetId) {
      setTarget(p.newTargetId);
      for (const [method, params] of enabled) post(p.newTargetId, nextId++, method, params);
    } else if (msg.method === "Target.targetDestroyed" && p.targetId === target) target = null;
    else if (msg.method === "Target.dispatchMessageFromTarget" && typeof p.message === "string") {
      let inner: any;
      try {
        inner = JSON.parse(p.message);
      } catch {
        return;
      }
      if (inner.id !== undefined) {
        const w = pending.get(inner.id);
        pending.delete(inner.id);
        if (!w) return;
        if (inner.error) w.reject(new Error(inner.error.message ?? JSON.stringify(inner.error)));
        else w.resolve(inner.result ?? {});
      } else if (inner.method) emit(inner.method, inner.params ?? {});
    }
  });
  const end = () => {
    if (gone) return;
    gone = true;
    failAll("调试连接断开了");
    closedResolve();
  };
  ch.onClose(end);

  return {
    async send(method, params) {
      if (gone) throw new Error("调试连接断开了");
      const deadline = Date.now() + timeoutMs;
      if (!target) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => {
            targetWaiters = targetWaiters.filter((w) => w !== done);
            reject(new Error("等页面超时：调试连接上一直没有页面"));
          }, timeoutMs);
          const done = () => (clearTimeout(t), resolve());
          targetWaiters.push(done);
        });
      }
      const id = nextId++;
      const result = new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} 超时：页面没有回话`));
        }, Math.max(0, deadline - Date.now()));
        pending.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
      });
      post(target!, id, method, params);
      const r = await result;
      if (method.endsWith(".enable")) enabled.set(method, params);
      else if (method.endsWith(".disable")) enabled.delete(method.replace(/\.disable$/, ".enable"));
      return r;
    },
    on(event, cb) {
      const set = listeners.get(event) ?? new Set();
      set.add(cb);
      listeners.set(event, set);
      return () => set.delete(cb);
    },
    close: () => {
      end();
      ch.close();
    },
    closed,
  };
}
