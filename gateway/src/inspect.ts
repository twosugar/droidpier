import type { HighlightBox, Rotation, WebViewPage } from "../../shared/protocol.ts";

/**
 * DevTools 的“选择元素”模式。
 *
 * 前端（devtools_app.html，不带画面镜像）进入这个模式后，等着被审查的页面自己拦下鼠标：移动时高亮、点下去时选中。
 * Android WebView 对注入的触摸不这样做，触摸照常进页面、点到页面自己的点击处理；Chrome 113 的标签页会拦下点击，但没有鼠标就不会高亮（2026-11-16 实测）。
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

/** toPageCss 的逆运算：页面视口里的 CSS 坐标 → 竖屏面板坐标（不取整，不夹边界，元素可以在屏幕外）。 */
export function toPanel(
  css: { x: number; y: number },
  device: { width: number; height: number },
  rotation: Rotation,
  rect: NonNullable<WebViewPage["rect"]>,
  dpr: number,
): { x: number; y: number } {
  const { width: w, height: h } = device;
  const sx = rect.x + css.x * dpr;
  const sy = rect.y + css.y * dpr;
  return rotation === 90 ? { x: sy, y: h - sx } :
    rotation === 180 ? { x: w - sx, y: h - sy } :
    rotation === 270 ? { x: w - sy, y: sx } :
    { x: sx, y: sy };
}

type Rgba = { r: number; g: number; b: number; a?: number };
/** 前端没给任何颜色时用的四色，取自 Chrome DevTools 的元素高亮。 */
const DEFAULT_COLORS: Record<"margin" | "border" | "padding" | "content", Rgba> = {
  margin: { r: 246, g: 178, b: 107, a: 0.66 },
  border: { r: 255, g: 229, b: 153, a: 0.66 },
  padding: { r: 147, g: 196, b: 125, a: 0.55 },
  content: { r: 111, g: 168, b: 220, a: 0.66 },
};
const LABEL_MAX = 60;
const TRANSPARENT = "rgba(0,0,0,0)";

/**
 * DOM.getBoxModel 的结果换成要画的高亮。config 是前端 Overlay.highlightNode 的 highlightConfig：
 * 四层都发（页面按里面一层挖空成环，见 host/src/highlight.ts），没给颜色的层透明；一层都没给时（或没有 config，
 * 选择元素模式下网关自己取的）用默认四色；showInfo 为 false 时不要标注。
 */
export function highlightBox(
  model: { content: number[]; padding: number[]; border: number[]; margin: number[]; width: number; height: number },
  node: { localName?: string; nodeName?: string; attributes?: string[] },
  config: any,
  toPanelPoint: (p: { x: number; y: number }) => { x: number; y: number },
): HighlightBox {
  const layers = ["margin", "border", "padding", "content"] as const;
  const given = layers.filter((l) => config?.[`${l}Color`]);
  const colors: Partial<Record<(typeof layers)[number], Rgba>> = given.length
    ? Object.fromEntries(given.map((l) => [l, config[`${l}Color`]]))
    : DEFAULT_COLORS;
  const quads = layers.map((l) => {
    const q = model[l];
    const points: number[] = [];
    for (let i = 0; i + 1 < q.length; i += 2) {
      const p = toPanelPoint({ x: q[i], y: q[i + 1] });
      points.push(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10);
    }
    const c = colors[l];
    return { points, color: c ? `rgba(${c.r},${c.g},${c.b},${c.a ?? 1})` : TRANSPARENT };
  });
  let label: string | null = null;
  if (config?.showInfo !== false) {
    const attrs = node.attributes ?? [];
    const attr = (name: string) => { const i = attrs.indexOf(name); return i >= 0 && i % 2 === 0 ? attrs[i + 1] : undefined; };
    const id = attr("id");
    const classes = (attr("class") ?? "").split(/\s+/).filter(Boolean);
    label = `${node.localName || (node.nodeName ?? "").toLowerCase()}${id ? `#${id}` : ""}${classes.map((c) => `.${c}`).join("")}`.slice(0, LABEL_MAX);
  }
  return { quads, label, size: `${Math.round(model.width)} × ${Math.round(model.height)}` };
}

/** adb shell wm size 的输出：有 Override size（改过分辨率）时用它，否则用 Physical size；都读不出时 null。 */
export function parseWmSize(out: string): { width: number; height: number } | null {
  const pick = (label: string) => {
    const m = out.match(new RegExp(`${label} size:\\s*(\\d+)x(\\d+)`));
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  };
  return pick("Override") ?? pick("Physical");
}

/**
 * /json 和窗口信息给的位置是屏幕像素；真机的画面是 scrcpy 缩小过的视频（长边最多 1920），device 是视频尺寸，
 * 位置要按同一比例缩到视频像素，后面的换算才对得上（2026-11-17 三星 SM-G9910：屏幕 1080x2400，视频 864x1920）。
 * display 是 wm size 的屏幕尺寸（自然方向），按短边算比例；不知道时、或和 device 一样大（模拟器）时原样返回。
 */
export function scaleRect(rect: Rect, device: { width: number; height: number }, display: { width: number; height: number } | null): Rect {
  if (!display) return rect;
  const k = Math.min(device.width, device.height) / Math.min(display.width, display.height);
  if (!Number.isFinite(k) || k <= 0 || Math.abs(k - 1) < 1e-6) return rect;
  const r = (n: number) => Math.round(n * k * 10) / 10;
  return { x: r(rect.x), y: r(rect.y), width: r(rect.width), height: r(rect.height) };
}

/**
 * 页面列表里悬停时整页的高亮：WebView 在屏幕上的整块区域（显示方向的设备像素），一层默认的内容色、不带标签。
 * 拿不到显示角度，按物理方向放（pickMapping）；放不进屏幕时返回 null，不画。
 */
export function pageBox(rect: Rect, device: { width: number; height: number }, physical: Rotation): HighlightBox | null {
  const m = pickMapping({ rect, device, physical, angle: undefined, cssWidth: rect.width });
  if (!m) return null;
  const points: number[] = [];
  for (const [x, y] of [[0, 0], [rect.width, 0], [rect.width, rect.height], [0, rect.height]]) {
    const p = toPanel({ x, y }, device, m.rotation, rect, 1);
    points.push(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10);
  }
  const c = DEFAULT_COLORS.content;
  return { quads: [{ points, color: `rgba(${c.r},${c.g},${c.b},${c.a})` }], label: null, size: "" };
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
 * 模式开着时会变的位置和缩放（双指缩放、浏览器地址栏随滚动收起展开）：get() 先返回当前值，离上次问超过 1 秒就顺手再问一次，
 * 下一次用新值。问不到（停在断点上）或答 null 时保留原值；不用定时器，模式关掉后没有东西要清。
 */
export function liveValue<T>(initial: T, ask: () => Promise<T | null>, now: () => number = Date.now) {
  let value = initial;
  let last = now();
  let asking = false;
  return {
    get(): T {
      if (!asking && now() - last > 1000) {
        asking = true;
        last = now();
        ask()
          .then((v) => {
            if (v !== null) value = v;
          }, () => {})
          .finally(() => (asking = false));
      }
      return value;
    },
  };
}

type Rect = NonNullable<WebViewPage["rect"]>;

/**
 * 浏览器标签页的网页在屏幕上的位置和缩放。/json 不给标签页的位置，用窗口内容区（app：去掉状态栏和导航栏，
 * dumpsys window 的 mAppBounds）和 Page.getLayoutMetrics 推：地址栏收起展开时网页的底边不动，贴着内容区底边，
 * 高度是 layoutViewport（设备像素）。缩放 = 网页宽（设备像素）/ cssVisualViewport 宽（2026-11-16 Chrome 113 实测）。
 * 软键盘弹出、或浏览器把工具栏放在底部时网页不贴底，位置会偏，这里不处理。
 */
export function browserView(app: Rect, metrics: any): { rect: Rect; scale: number } | null {
  const width = Math.min(app.width, Math.round(Number(metrics?.layoutViewport?.clientWidth)));
  const height = Math.min(app.height, Math.round(Number(metrics?.layoutViewport?.clientHeight)));
  const scale = width / Number(metrics?.cssVisualViewport?.clientWidth);
  if (!(width > 0 && height > 0 && Number.isFinite(scale) && scale > 0)) return null;
  return { rect: { x: app.x, y: app.y + app.height - height, width, height }, scale };
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
  /** 一次 mouseMoved 发完后调用（CSS 坐标），网关据此取鼠标下的节点画高亮。 */
  moved?(at: { x: number; y: number }): void;
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
      if (!stopped && !nextMove) deps.moved?.(at);
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

/** 一个 DevTools 会话的位置换算：设备面板坐标 ↔ 页面 CSS 坐标；toCss 在 WebView 外或会话变了时给 null。 */
export type Mapping = {
  toCss(p: { x: number; y: number }): { x: number; y: number } | null;
  toPanel(p: { x: number; y: number }): { x: number; y: number };
};
type Session = { send(method: string, params: object): Promise<any> };
export type HighlightTarget = { nodeId?: number; backendNodeId?: number; objectId?: string; config?: object };

/**
 * 一个页面连接上的 DevTools 和它的选择元素模式、元素高亮，同一时间只认最新连上的那个。
 * notify 给页面发 inspectMode；notifyHighlight 给页面发要画的高亮（null 清掉）；
 * locate 算位置换算，算不出时 null（页面照常发触摸、不画高亮）。
 * 高亮的位置在一轮划过（到 hideHighlight 为止）里只算一次，转屏（relocate）后作废重算；算不出时不缓存。
 * 高亮请求只留最新一条，上一条的盒模型还没取回时不排队。
 */
export function createInspectorSlot<S extends Session = Session>(deps: {
  notify(on: boolean, mapped: boolean): void;
  notifyHighlight(box: HighlightBox | null): void;
  locate(session: S): Promise<Mapping | null>;
}) {
  type Inspector = {
    session: S; on: boolean; gen: number; input: ReturnType<typeof createInspectInput> | null;
    view: Promise<Mapping | null> | null;
    hl: { gen: number; busy: boolean; next: HighlightTarget | null; shown: boolean };
  };
  let cur: Inspector | null = null;

  // 算不出的结果不缓存（WebView 暂时不在屏幕上、adb 一时没答）：下一次划过再算
  const view = (me: Inspector) => {
    if (me.view) return me.view;
    const p = deps.locate(me.session).catch(() => null);
    me.view = p;
    void p.then((m) => { if (!m && me.view === p) me.view = null; });
    return p;
  };
  const clearHighlight = (me: Inspector) => {
    me.hl.gen++;
    me.hl.next = null;
    // 鼠标离开元素树：这一轮划过结束，位置下一轮重新算（WebView 可能挪了）；选择元素模式开着时位置由 compute 管
    if (!me.on) me.view = null;
    if (me.hl.shown) {
      me.hl.shown = false;
      deps.notifyHighlight(null);
    }
  };
  const ids = (t: HighlightTarget) => (t.nodeId !== undefined ? { nodeId: t.nodeId } : t.backendNodeId !== undefined ? { backendNodeId: t.backendNodeId } : { objectId: t.objectId });
  const runHighlight = async (me: Inspector, t: HighlightTarget) => {
    me.hl.busy = true;
    const gen = me.hl.gen;
    let box: HighlightBox | null = null;
    try {
      const map = await view(me);
      if (map) {
        const [bm, desc] = await Promise.all([me.session.send("DOM.getBoxModel", ids(t)), me.session.send("DOM.describeNode", ids(t))]);
        if (bm?.model) box = highlightBox(bm.model, desc?.node ?? {}, t.config, (p) => map.toPanel(p));
      }
    } catch {
      box = null;
    }
    me.hl.busy = false;
    if (cur === me && me.hl.gen === gen) {
      if (box || me.hl.shown) deps.notifyHighlight(box);
      me.hl.shown = !!box;
    }
    const next = me.hl.next;
    me.hl.next = null;
    if (next && cur === me) void runHighlight(me, next);
  };
  const highlight = (me: Inspector, t: HighlightTarget | null) => {
    if (cur !== me) return;
    if (!t) return clearHighlight(me);
    if (me.hl.busy) me.hl.next = t;
    else void runHighlight(me, t);
  };
  // 有的 WebView 进了选择元素模式也不在屏幕上画（2026-11-17 三星 WebView 99）：鼠标停下后取它下面的节点，由网关画
  const hover = (me: Inspector, at: { x: number; y: number }) => {
    me.session.send("DOM.getNodeForLocation", { x: Math.round(at.x), y: Math.round(at.y), ignorePointerEventsNone: true }).then(
      (r) => { if (me.on && typeof r?.backendNodeId === "number") highlight(me, { backendNodeId: r.backendNodeId }); },
      () => {},
    );
  };

  const reset = (me: Inspector) => {
    me.gen++;
    me.input?.stop();
    me.input = null;
  };
  const compute = (me: Inspector) => {
    const gen = me.gen;
    deps.locate(me.session).catch(() => null).then((map) => {
      if (cur !== me || me.gen !== gen || !me.on) return;
      me.view = Promise.resolve(map);
      me.input = map ? createInspectInput({ map: (p) => map.toCss(p), send: (m, p) => me.session.send(m, p), moved: (at) => hover(me, at) }) : null;
      deps.notify(true, !!map);
    });
  };

  return {
    /** 新的 DevTools 连上了；上一个还开着模式时先告诉页面关了，免得页面一直停在选择元素模式；它画着的高亮也清掉。 */
    open(session: S) {
      if (cur) {
        reset(cur);
        clearHighlight(cur);
        if (cur.on) deps.notify(false, false);
      }
      const me: Inspector = { session, on: false, gen: 0, input: null, view: null, hl: { gen: 0, busy: false, next: null, shown: false } };
      cur = me;
      return {
        mode(on: boolean): void {
          if (cur !== me) return;
          me.on = on;
          reset(me);
          if (on) compute(me);
          else {
            clearHighlight(me);
            deps.notify(false, false);
          }
        },
        /** 前端的 Overlay.highlightNode（null：hideHighlight）。 */
        highlight(t: HighlightTarget | null): void {
          highlight(me, t);
        },
        close(): void {
          if (cur !== me) return;
          clearHighlight(me);
          cur = null;
          reset(me);
          if (me.on) deps.notify(false, false);
        },
      };
    },
    pointer(e: InspectPointer): void {
      if (cur?.on) cur.input?.pointer(e);
    },
    /** 转屏等让位置作废时调：清掉高亮、丢掉缓存的位置；模式开着时先告诉页面不映射，再重新算。 */
    relocate(): void {
      const me = cur;
      if (!me) return;
      clearHighlight(me);
      me.view = null;
      if (!me.on) return;
      reset(me);
      deps.notify(true, false);
      compute(me);
    },
  };
}
