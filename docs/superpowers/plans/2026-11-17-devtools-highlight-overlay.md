# DevTools 高亮画在设备画面上 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 H5 调试里，鼠标划过 Elements 树中的节点，或者在「选择元素」模式下划过设备画面时，页面上的设备画面要画出这个元素的高亮框和「标签名 宽 × 高」标注，效果和 `chrome://inspect` 左侧镜像上的一样。不管设备的 WebView 自己会不会画。

**为什么：**
- 这台三星 SM-G9910 的 WebView 是 99.0.4844.88。它收到 `Overlay.highlightNode` 和 `Overlay.highlightRect` 都回复成功，但屏幕上什么都不画。
  - 2026-11-17 实测：直连 `webview_devtools_remote` 发命令，再用 `adb screencap` 截屏，看不到高亮；用 `Runtime.evaluate` 给同一个元素加红框，红框能显示。
- 这台手机没有可用的 Google Play，WebView 升级不了。
- `chrome://inspect` 用的是 `inspector.html`，它的设备镜像（ScreencastView）会在镜像上自己画高亮。我们换成了 `devtools_app.html`（`gateway/src/devtools-proxy.ts:154`），这块镜像不在了，所以要由 droidpier 自己画。

**Architecture:**
- **网关**
  - `proxyDevtools` 看到前端发出的 `Overlay.highlightNode` / `Overlay.hideHighlight` 时调用新的钩子 `onHighlight`。消息仍然原样转发，WebView 能画的设备照样会画。
  - 网关在同一个调试会话里自己发命令，取元素的盒模型（`DOM.getBoxModel`）和名字（`DOM.describeNode`）。
  - 用已有的位置换算（`gateway/src/inspect.ts` 的 `locate`：WebView 在屏幕上的位置、缩放、显示方向）把 CSS 坐标换成「竖屏面板坐标」（和 touch 消息同一套），发给页面 `{ t: "highlight", box }`。
  - 「选择元素」模式下，鼠标移动时网关本来就会发 `mouseMoved`。现在再加一步：用 `DOM.getNodeForLocation` 找到鼠标下的节点，走同样的流程。
- **Host**：在 canvas 上叠一层不接收鼠标的 `<div>`，把面板坐标换成画布上的位置，画 margin、border、padding、content 四层框和标注；收到 `box: null` 时清掉。
- **协议**：只加不改。新增网关发给页面的 `highlight` 消息；旧页面不认识它，忽略即可；新页面连旧网关时收不到，行为和现在一样。`PROTOCOL_VERSION`、`GATEWAY_LEVEL` 都不变。

**Tech Stack:** 不新增依赖；`node:test`；host 用 bun 构建，页面是 nsh TSX。

## Global Constraints

- 注释、日志、界面文案用中文；只用可擦除 TS 语法；`gateway/`、`host/`、`shared/` 的 import 写 `.ts`，`ui/` 不写。
- DevTools 的流量很大：只对含 `"Overlay.highlightNode"` 或 `"Overlay.hideHighlight"` 的消息做 JSON 解析（`gateway/src/devtools-proxy.ts:67` 已有的做法）。
- 高亮请求「只留最新」：上一次的盒模型还没取回来时，新的请求只覆盖待办，不排队，和 `createInspectInput` 的 move 一样。
- 颜色：用前端 `highlightConfig` 里的 `contentColor`、`paddingColor`、`borderColor`、`marginColor`（`{r,g,b,a}`）。没给的层不画；全都没给时，用 Chrome 默认的四色（content `rgba(111,168,220,.66)`、padding `rgba(147,196,125,.55)`、border `rgba(255,229,153,.66)`、margin `rgba(246,178,107,.66)`）。`showInfo` 为 false 时不画标注。
- 检查：`npm test`；类型检查（基线 2 个 `Uint8Array` 错误）；`nsh check ui`（基线 8 个错误）；`npm run build:host`、`npm run build:ui`。
- 提交信息 `<area>: <英文祈使句>`。

## 本计划的取舍

1. **模拟器也画**：模拟器 WebView 124 自己会画（`gateway/src/inspect.ts` 的注释，2026-11-16 实测），两层叠在同一位置，颜色会深一点。不按设备类型区分：旧的模拟器镜像、其他旧手机同样可能不画，统一由网关画最省事。
2. **位置只在请求时算一次**：页面滚动后高亮会留在原位，Chrome 镜像上也是在下一次 hover 时才更新。用户在画面上按下、滚轮或按键时，host 清掉高亮，避免看到错位的框。
3. **映射复用 `locate`**：把 `createInspectorSlot` 的 `locate` 从「只给设备 → CSS 的函数」扩成同时给 `toCss` 和 `toPanel`。模式没开时也可以按需算，算出来的结果按 DevTools 会话缓存，转屏（`relocate`）后作废。
4. **只处理 `highlightNode` 和 `hideHighlight`**：`highlightRect`、`highlightQuad`、`highlightFrame` 前端很少用（DevTools 里的 Layers 等面板），先不画。

## Review Focus

1. **Elements 树里快速划过很多行**：画面上的框跟着最后一行走，不卡顿，不留下旧框。→ Task 2 的「只留最新」测试。
2. **DevTools 关掉、换了页面、设备断开、转屏**：高亮清掉，不残留。→ Task 2 测试。
3. **元素不在屏幕内，或者没有盒模型**（`display:none`，`DOM.getBoxModel` 报错）：清掉高亮，不报错。→ Task 2 测试。
4. **转屏后的坐标**：`toPanel` 是 `toPageCss` 的逆运算，4 个方向往返都要一致。→ Task 1 测试。
5. **旧页面连新网关**：收到不认识的 `highlight` 消息不出错。→ Task 3 检查 host 收到未知消息时的处理。

---

### Task 1: 坐标和盒模型换算（纯函数）

**Files:**
- Modify: `gateway/src/inspect.ts`、`shared/input-map.ts`
- Test: `gateway/test/inspect.test.ts`、`shared/test/input-map.test.ts`（没有就按现有测试目录的命名新建）

**Interfaces:**
- Produces：
  - `toPanel(css: {x:number;y:number}, device, rotation: Rotation, rect, scale: number): {x:number;y:number}`：`toPageCss` 的逆运算，CSS 坐标 → 竖屏面板坐标，不取整，不夹边界。
  - `highlightBox(model: { content:number[]; padding:number[]; border:number[]; margin:number[]; width:number; height:number }, node: { localName?: string; nodeName?: string; attributes?: string[] }, config: object | undefined, toPanel: (p)=>{x,y}): HighlightBox`
  - `HighlightBox`（放在 `shared/protocol.ts`）：`{ quads: Array<{ points: number[]; color: string }>; label: string | null; size: string }`。`quads` 从外到内依次是 margin、border、padding、content，`points` 是 8 个面板坐标数字。`label` 形如 `p#id.cls1.cls2`，最长 60 个字符，`showInfo` 为 false 时为 null。`size` 形如 `328 × 225`（CSS 像素，四舍五入）。
  - `fromDevice(p, rect, device, rotation): {x,y}`（`shared/input-map.ts`）：`toDevice` 的逆运算，面板坐标 → 画布上的 client 坐标。

- [ ] **Step 1: 写测试**：
  - `toPanel(toPageCss(p)) ≈ p`：4 个方向各取一点，`rect` 带偏移、`scale` 取 3。
  - `fromDevice(toDevice(c)) ≈ c`：4 个方向，误差不超过 1 像素。
  - `highlightBox`：
    - 给出四层 quad 和 `highlightConfig.contentColor` 时，输出的 content 层颜色是 `rgba(...)`，其他层用 config 里的颜色；
    - config 为空时用默认四色；
    - `attributes: ["id","a","class","x y"]` 得到 `p#a.x.y`；
    - `showInfo:false` 时 `label` 为 null；
    - `size` 是 `"328 × 225"`。
- [ ] **Step 2: 跑测试，确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试，全部通过**。
- [ ] **Step 5: 提交** `gateway: Map DevTools box models to the device panel`

### Task 2: 网关把高亮发给页面

**Files:**
- Modify: `gateway/src/devtools-proxy.ts`（`onHighlight` 钩子）、`gateway/src/inspect.ts`（`createInspectorSlot` 的 `locate` 返回 `{ toCss, toPanel }`，新增高亮的「只留最新」处理；选择元素模式下 move 之后取鼠标下的节点）、`gateway/src/server.ts`（接线，发 `highlight` 消息）、`shared/protocol.ts`（`{ t: "highlight"; box: HighlightBox | null }`）
- Test: `gateway/test/devtools-proxy.test.ts`、`gateway/test/inspect.test.ts`、`gateway/test/server.test.ts`

**Interfaces:**
- `proxyDevtools(client, url, hooks: { onInspectMode?; onHighlight?(req: { nodeId?: number; backendNodeId?: number; objectId?: string; config?: object } | null) })`。
- `createInspectorSlot` 新增 `notifyHighlight(box: HighlightBox | null)` 依赖，以及打开的会话上的 `highlight(req | null)` 方法。

- [ ] **Step 1: 写测试**：
  - proxy：前端发 `Overlay.highlightNode {nodeId:5, highlightConfig:{...}}` 时，`onHighlight` 收到 `{nodeId:5, config}`；`Overlay.hideHighlight` 时收到 null；两条消息都照样转发给上游。
  - slot：
    - `highlight({nodeId:5})` 依次调用 `DOM.getBoxModel`、`DOM.describeNode`，然后 `notifyHighlight` 收到算好的 box；
    - 上一次还没返回时连发 3 次，只处理第 1 次和最后 1 次；
    - `getBoxModel` 报错时 `notifyHighlight(null)`；
    - DevTools `close()` 或 `relocate()` 时 `notifyHighlight(null)`；
    - 位置算不出（`locate` 返回 null）时 `notifyHighlight(null)`。
  - 选择元素模式：`pointer({kind:"move"})` 之后会用 `DOM.getNodeForLocation` 取节点，再走同一条高亮流程。
  - server：页面连接收到 `{ t: "highlight", box }`；会话断开时收到 `box: null`。
- [ ] **Step 2: 跑测试，确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试** `npm test` 全绿。
- [ ] **Step 5: 提交** `gateway: Send the DevTools highlight to the page`

### Task 3: Host 在画面上画高亮

**Files:**
- Modify: `host/src/connection.ts`（转交 `highlight`）、`host/src/main.ts`（overlay 层和绘制；按下、滚轮、按键时清掉）
- 新建：`host/src/highlight.ts`（把 `HighlightBox` 画成 DOM，纯函数部分可单测）
- Test: `shared/test/highlight.test.ts`（host 的纯函数部分：面板坐标 → 相对画布的 CSS 位置，标注放在框上方，放不下时放下方，并夹在画布内）

- [ ] **Step 1: 写纯函数测试，确认失败，再实现，然后跑通**。
- [ ] **Step 2: overlay 层**：放在 `frame` 里、`canvas` 之上，设 `position:absolute; inset:0; pointer-events:none`。四层 quad 用一个 SVG 画成四个 `<polygon>`；标注是一个小 `<div>`，样式参照 Chrome（白底、等宽字、`标签名` 加灰色的 `宽 × 高`）。
- [ ] **Step 3: 检查** 旧页面收到不认识的消息时的处理（`host/src/connection.ts` 的分支链）：确认是忽略，不报错。`npm run build:host`、`npm run build:ui`、`nsh check ui` 仍是 8 个错误。
- [ ] **Step 4: 提交** `host: Draw the DevTools highlight over the device view`

### Task 4: 验收

- [ ] **Step 1: 三星 SM-G9910（WebView 99）**，打开长桥资讯页，进入 H5 调试：
  - 在 Elements 树里划过 `article` 下的几个 `<p>`，设备画面上出现对应的框和 `p 328 × 225` 这类标注，鼠标移出树后消失；
  - 进入「选择元素」，在画面上划过，框跟着鼠标下的元素走，点下去 Elements 选中；
  - 在画面上滚动后，高亮清掉。
  - 截图写进 PR 描述。
- [ ] **Step 2: 模拟器（Pixel 6 Pro，WebView 124）**：能走到 WebView 页面时，同样核对两层框的位置是否重合。走不到时写明原因（长桥 debug 包要登录，不替用户登录）。
- [ ] **Step 3: 关掉 DevTools、切换设备**：高亮不残留。
- [ ] **Step 4: 提交** `docs: Plan drawing the DevTools highlight`（本计划文档）

## 后续

- `highlightRect`、`highlightQuad`、`highlightFrame`。
- 页面滚动时让高亮跟着元素走（需要订阅滚动或定期重新取盒模型）。
