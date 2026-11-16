import type { Rotation, WebViewPage } from "../../shared/protocol.ts";

/**
 * DevTools 的“选择元素”模式。
 *
 * 前端（devtools_app.html，不带画面镜像）进入这个模式后，等着被审查的页面自己拦下鼠标：移动时高亮、点下去时选中。
 * Android WebView 对注入的触摸不这样做，触摸照常进页面、点到页面自己的点击处理（2026-11-16 实测，Chrome 113 的标签页倒会拦）。
 * CDP 的 Input.dispatchMouseEvent 在 WebView 里会被这个模式拦下：mouseMoved 高亮，mousePressed 让前端收到
 * Overlay.inspectNodeRequested、在 Elements 里选中（同一实测）。所以模式开着时页面不发触摸，改由网关在前端的
 * 调试会话里补发鼠标事件，坐标从设备像素换成页面的 CSS 像素。
 */

/** 从经过代理的一条 CDP 消息看模式变化：开了 true，关了 false，和模式无关 null。fromFrontend：前端发给页面的。 */
export function inspectModeChange(fromFrontend: boolean, text: string): boolean | null {
  let m: { method?: unknown; params?: { mode?: unknown } };
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  if (fromFrontend && m.method === "Overlay.setInspectMode") {
    const mode = m.params?.mode;
    if (mode === "none") return false;
    return mode === "searchForNode" || mode === "searchForUAShadowDOM";
  }
  if (!fromFrontend && m.method === "Overlay.inspectModeCanceled") return false;
  return null;
}

/**
 * 设备竖屏面板上的坐标（和触摸消息同一套，shared/input-map.ts 的 toDevice）换成页面视口里的 CSS 坐标。
 * rotation 是 Android 显示方向，按 toDevice 的约定写成顺时针角度（pickMapping 换算）；rect 是 WebView 在屏幕上的位置
 * （按显示方向的设备像素），dpr 是一个 CSS 像素占几个设备像素；落在 WebView 外返回 null。
 */
export function toPageCss(
  p: { x: number; y: number },
  device: { width: number; height: number },
  rotation: Rotation,
  rect: NonNullable<WebViewPage["rect"]>,
  dpr: number,
): { x: number; y: number } | null {
  const { width: w, height: h } = device;
  // toDevice 的逆：竖屏面板坐标 → 人眼看到的（转过之后的）屏幕坐标
  const [sx, sy] =
    rotation === 90 ? [h - p.y, p.x] :
    rotation === 180 ? [w - p.x, h - p.y] :
    rotation === 270 ? [p.y, w - p.x] :
    [p.x, p.y];
  if (sx < rect.x || sy < rect.y || sx >= rect.x + rect.width || sy >= rect.y + rect.height || !(dpr > 0)) return null;
  return { x: Math.round(((sx - rect.x) / dpr) * 10) / 10, y: Math.round(((sy - rect.y) / dpr) * 10) / 10 };
}

/**
 * 映射用的显示方向和缩放。
 * 显示方向不一定是模拟器的物理方向（App 锁竖屏、关了自动旋转）：页面给了 screen.orientation.angle 就用它，
 * 它是 Android 的显示角度（逆时针），换成 toDevice 的顺时针；拿不到（比如停在断点上）时按物理方向猜。
 * WebView 放不进这个方向的屏幕说明猜错了，返回 null，页面照常发触摸。scale = WebView 宽（设备像素）/ 视口宽（CSS 像素）。
 */
export function pickMapping(m: {
  rect: NonNullable<WebViewPage["rect"]>;
  device: { width: number; height: number };
  physical: Rotation;
  angle: number | undefined;
  cssWidth: number;
}): { rotation: Rotation; scale: number } | null {
  const rotation = (m.angle === 0 || m.angle === 90 || m.angle === 180 || m.angle === 270 ? (360 - m.angle) % 360 : m.physical) as Rotation;
  const [dw, dh] = rotation % 180 ? [m.device.height, m.device.width] : [m.device.width, m.device.height];
  const { x, y, width, height } = m.rect;
  // 允许 1 像素的取整误差
  if (x < 0 || y < 0 || x + width > dw + 1 || y + height > dh + 1) return null;
  const scale = width / m.cssWidth;
  return Number.isFinite(scale) && scale > 0 ? { rotation, scale } : null;
}

/**
 * 模式开着时页面可能被双指缩放：get() 先返回当前比例，离上次问超过 1 秒就顺手再问一次视口宽，下一次用新值。
 * 问不到（停在断点上）或答得不对时保留原值；不用定时器，模式关掉后没有东西要清。
 */
export function liveScale(rectWidth: number, initial: number, cssWidth: () => Promise<number>, now: () => number = Date.now) {
  let scale = initial;
  let last = now();
  let asking = false;
  return {
    get(): number {
      if (!asking && now() - last > 1000) {
        asking = true;
        last = now();
        cssWidth()
          .then((w) => {
            const next = rectWidth / w;
            if (Number.isFinite(next) && next > 0) scale = next;
          }, () => {})
          .finally(() => (asking = false));
      }
      return scale;
    },
  };
}

export type InspectPointer = { kind: "move" | "down" | "up"; x: number; y: number };

/**
 * 选择元素模式下页面发来的指针，换成发给 WebView 的鼠标事件。
 * - move：mouseMoved（高亮）；上一条还没回复时只留最新一条，不排队。
 * - down 记下位置，up 时在按下的位置补一次 mousePressed + mouseReleased（选中）。前端收到选中后自己关掉模式。
 * - 落在 WebView 外的忽略。
 */
export function createInspectInput(deps: {
  /** 设备坐标 → CSS 坐标，WebView 外或还不知道位置时 null。 */
  map(p: { x: number; y: number }): { x: number; y: number } | null;
  send(method: string, params: object): Promise<unknown>;
}) {
  let moving = false;
  let nextMove: { x: number; y: number } | null = null;
  let downAt: { x: number; y: number } | null = null;
  let stopped = false;

  const move = (at: { x: number; y: number }) => {
    if (stopped) return;
    if (moving) {
      nextMove = at;
      return;
    }
    moving = true;
    deps.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }).catch(() => {}).finally(() => {
      moving = false;
      const n = nextMove;
      nextMove = null;
      if (n) move(n);
    });
  };

  return {
    /** 模式关了、位置作废：排着的移动和之后的指针都不再发。 */
    stop(): void {
      stopped = true;
      nextMove = null;
      downAt = null;
    },
    pointer(e: InspectPointer): void {
      if (stopped) return;
      const at = deps.map(e);
      if (e.kind === "move") {
        if (at) move(at);
        return;
      }
      if (e.kind === "down") {
        downAt = at;
        return;
      }
      const p = downAt;
      downAt = null;
      if (!p) return;
      nextMove = null;
      const base = { x: p.x, y: p.y, button: "left", clickCount: 1 };
      deps.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base }).catch(() => {});
      deps.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base }).catch(() => {});
    },
  };
}

type Map = (p: { x: number; y: number }) => { x: number; y: number } | null;
type Session = { send(method: string, params: object): Promise<unknown> };

/**
 * 一个页面连接上的 DevTools 和它的选择元素模式，同一时间只认最新连上的那个。
 * notify 给页面发 inspectMode；locate 算设备坐标到 CSS 坐标的映射，算不出时 null（页面照常发触摸）。
 */
export function createInspectorSlot<S extends Session = Session>(deps: {
  notify(on: boolean, mapped: boolean): void;
  locate(session: S): Promise<Map | null>;
}) {
  type Inspector = { session: S; on: boolean; gen: number; input: ReturnType<typeof createInspectInput> | null };
  let cur: Inspector | null = null;

  const reset = (me: Inspector) => {
    me.gen++;
    me.input?.stop();
    me.input = null;
  };
  const compute = (me: Inspector) => {
    const gen = me.gen;
    deps.locate(me.session).catch(() => null).then((map) => {
      if (cur !== me || me.gen !== gen || !me.on) return;
      me.input = map ? createInspectInput({ map, send: (m, p) => me.session.send(m, p) }) : null;
      deps.notify(true, !!map);
    });
  };

  return {
    /** 新的 DevTools 连上了；上一个还开着模式时先告诉页面关了，免得页面一直停在选择元素模式。 */
    open(session: S) {
      if (cur) {
        reset(cur);
        if (cur.on) deps.notify(false, false);
      }
      const me: Inspector = { session, on: false, gen: 0, input: null };
      cur = me;
      return {
        mode(on: boolean): void {
          if (cur !== me) return;
          me.on = on;
          reset(me);
          if (on) compute(me);
          else deps.notify(false, false);
        },
        close(): void {
          if (cur !== me) return;
          cur = null;
          reset(me);
          if (me.on) deps.notify(false, false);
        },
      };
    },
    pointer(e: InspectPointer): void {
      if (cur?.on) cur.input?.pointer(e);
    },
    /** 转屏等让位置作废时调：先告诉页面不映射，再重新算。 */
    relocate(): void {
      const me = cur;
      if (!me?.on) return;
      reset(me);
      deps.notify(true, false);
      compute(me);
    },
  };
}
