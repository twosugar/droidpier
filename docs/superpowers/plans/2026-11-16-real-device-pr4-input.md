# 真机支持 PR 4（真机输入和剪贴板）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 带 `--phones` 时，切到真机后能在页面上点、滑、滚动、按键（返回 / 主页 / 最近 / 电源 / 音量 / 功能键）、打字（含中文）、粘贴，手机和 Mac 的剪贴板双向同步。不带 `--phones` 时一切照旧。

**Architecture:**
- 网关：`PhoneSession` 把页面现有的 `touch` / `key` / `text` / `clip` 翻译成 scrcpy 控制消息写进控制连接；控制连接上回传的设备消息（手机剪贴板）解析后走现有 `onClipboard` → `clip` 消息同步到 Mac。
- 协议只加不改：新增页面 → 网关的 `scroll` 消息，能力表新增 `scroll`。真机的 `input`、`clipboard`、`scroll` 置为 `true`。
- 页面：能力表有 `scroll` 时滚轮发原生 `scroll`（模拟器仍用滑动模拟）；设备底部三键按 `caps.input` 禁用；真机行文案去掉「暂不能操作」。

**Tech Stack:** 不新增依赖。Node 22 直接跑 TS，`node:test`；页面 nsh TSX；构建 bun。

**Spec:** `docs/superpowers/specs/2026-11-13-real-device-design.md`，第 2 节（剪贴板互通）、6.1（能力表）、6.2「输入」一段、6.3（按键区）、6.4（`scroll`）、「原型实测」的控制消息、7 节 PR 4 与验证

**前置：** PR 3（twosugar/droidpier#39）尚未合入。新分支 `feat/phone-input` 从 `feat/phone-video`（`168b994`）切出；PR 3 合入后变基到 main 再开 PR。行号以 `168b994` 为准，以符号名找位置。

## Global Constraints

- 注释、日志、界面文案用中文；只用可擦除 TS 语法；`gateway/`、`host/`、`shared/` 的 import 写 `.ts`，`ui/` 不写。
- 不新增依赖。
- 协议只加不改，`PROTOCOL_VERSION` 保持 `1`（spec 6.4）。旧网关不认识 `scroll` 会记一行「忽略非法消息」，所以页面只在 `caps.scroll === true` 时发它。
- 模拟器通路不变：模拟器的 `touch` / `key` / `text` / `clip` / 滚轮滑动行为一个字节都不改。
- scrcpy 控制消息以 v5.0.1 服务端源码为准（`server/src/main/java/com/genymobile/scrcpy/control/`，写计划时逐条核对过），所有多字节整数**大端**：

  | 消息 | 字节 |
  | --- | --- |
  | 按键 `0` | `[0][action u8][keycode i32][repeat i32][metaState i32]`，共 14 字节 |
  | 文字 `1` | `[1][len u32][utf8]`，客户端单条上限 300 字节（`INJECT_TEXT_MAX_LENGTH`） |
  | 触摸 `2` | `[2][action u8][pointerId i64][x i32][y i32][w u16][h u16][pressure u16][actionButton i32][buttons i32]`，共 32 字节 |
  | 滚动 `3` | `[3][x i32][y i32][w u16][h u16][hscroll i16][vscroll i16][buttons i32]`，共 21 字节；`hscroll`/`vscroll` 是 `[-1,1]` 的定点数，服务端再乘 16 |
  | 设剪贴板 `9` | `[9][sequence u64][paste u8][len u32][utf8]`；文本上限 `(1 << 18) - 14 = 262130` 字节，超了服务端抛异常、控制线程退出 |
  | 设备消息（服务端 → 网关） | 剪贴板 `[0][len u32][utf8]`；剪贴板确认 `[1][sequence u64]`；UHID 输出 `[2][id u16][len u16][data]` |

- 触摸、滚动附带的 `w`/`h` 必须等于服务端**当前视频尺寸**，否则服务端静默丢弃（`PositionMapper.map`）。
- 提交信息 `<area>: <英文祈使句>`；PR 描述写 `## Protocol`。

## 本计划的取舍（写计划时定的）

1. **`text()` 一律走「设剪贴板 + 粘贴」**（`[9]`，`paste=1`，`sequence=0`）。spec 6.2 写的是「ASCII 用 inject text」，但页面只在两种情况下发 `text`：含非 ASCII 的输入，和 ⌘V 粘贴（`shared/input-map.ts` 的 `pasteToMsgs`，注释写明逐字按键会被输入框自动补全改坏）。逐字的 ASCII 已经走 `key` + `keypress`。这样真机和模拟器的 `text()` 语义一致（模拟器也是写剪贴板 + `KEYCODE_PASTE`），代价同样是覆盖手机剪贴板。粘贴键要 Android 7+；更老的手机只写剪贴板不粘贴，PR 描述写明。
2. **单个 ASCII 字符的 `keypress` 走 inject text**（`[1]`），命名键（`GoBack`、`Enter` 等）走按键消息：`keydown` → action 0，`keyup` → action 1，`keypress` → 先 0 后 1。表里没有的键名 reject「不认识的按键：<键名>」，`server.ts` 现有的 `key` 分支会把它变成页面上的「按键没有发出」。
3. **触摸用 `pointerId = -2`**（scrcpy 的 `POINTER_ID_GENERIC_FINGER`，服务端按触摸屏事件注入），按下 / 移动 `pressure = 0xffff`，抬起 `0`，`actionButton`、`buttons` 都是 `0`。页面每次移动都发 `down: true`，会话自己记「是否按着」：没按着时 `down: true` → `ACTION_DOWN(0)`；按着时 `down: true` → `ACTION_MOVE(2)`；`down: false` → `ACTION_UP(1)`，没按着时忽略。
4. **坐标换算**：页面发的是竖屏面板像素（`toDevice` 的惯例），会话按当前视频尺寸和 `rotation` 反算到视频帧像素；换算函数 `toVideo` 放在 `shared/input-map.ts`，和 `toDevice` 互为反函数。
5. **滚动**：新消息 `{ t: "scroll"; x; y; dx; dy }`，`x`/`y` 是竖屏面板像素，`dx`/`dy` 是浏览器 `WheelEvent` 的 CSS 像素位移（已按 `deltaMode` 换算）。网关换算成 scrcpy 的滚动量：`hscroll = dx / 100`、`vscroll = -dy / 100`（Android 的 `AXIS_VSCROLL` 正值是往上滚，浏览器 `deltaY` 正值是往下滚），夹到 `[-16, 16]`。100 是「一格滚轮 ≈ 100px」的估值，真机验收时按手感调，调了在常量注释里写出处。页面把 16ms 内的滚轮事件累加成一条。
6. **能力表加 `scroll`**（模拟器 `false`，真机 `true`），页面看它决定滚轮发 `scroll` 还是滑动模拟，不看 `kind`（spec 6.1「页面只看能力表」）。DeviceCaps 是 PR 3 新增、还没合入的类型，加字段仍是只加不改。
7. **`getClipboard()`** 返回最近一次从手机收到、或写给手机的文本（服务端开了剪贴板自动同步时不回复 `GET_CLIPBOARD`，见 `Controller.getClipboard`）。`serverArgs` 显式加 `clipboard_autosync=true`（v5.0.1 默认就是 true，写出来免得以后默认值变了）。
8. **真机重启**仍不做（PR 3 取舍 5 延续），留在「后续」。

## Review Focus

1. **按着时手机转屏**：视频尺寸变了，之后的移动 / 抬起带的是新尺寸、按下时是旧尺寸——服务端按尺寸丢事件，手机上会留一个永远按着的手指。期望：会话收到尺寸变化的会话包时，若正按着，先用**新尺寸**在最后一点（换算到新尺寸）发一次 `ACTION_UP`，并清掉「按着」；之后到用户松手前的按下 / 移动都不发（页面这时还按旧方向算坐标），松手后再按才是新的按下（整体审查时改正）。→ Task 4 测试。
2. **粘贴超长文本**：超过 262130 字节时服务端会抛异常、控制线程退出，整个会话断掉。期望：网关先按 UTF-8 字节数检查，超限 reject「文字太长，手机剪贴板最多约 256KB」，不写进控制连接，会话不断。→ Task 3、Task 4 测试。
3. **设备消息被切成任意块**：手机剪贴板里的中文、emoji 可能被拆在两次 `data` 之间，甚至拆在一个 UTF-8 字符中间。期望：解析器按长度攒齐再解码，回调的文本完整。→ Task 3 测试。
4. **会话关闭后或控制连接还没连上时来了输入**：期望：直接忽略（resolve），不对已销毁的套接字写、不抛错。→ Task 4 测试。
5. **页面能发出的键名必须都在对照表里**：`TOOL_KEYS`（WebMCP）、功能键、快捷键里的 `Power` / `GoHome` / `AppSwitch` / `GoBack` / 音量。期望：每个都映射到 keycode。→ Task 1 测试枚举这些键名。

---

### Task 1: 键名对照表与坐标反算（shared，纯函数）

**Files:**
- Create: `shared/android-keys.ts`
- Modify: `shared/input-map.ts`（新增 `toVideo`）
- Test: `shared/test/android-keys.test.ts`、`shared/test/input-map.test.ts`

**Interfaces:**
- Produces:
  - `export function androidKeycode(key: string): number | null`（`shared/android-keys.ts`），表内值（Android `KeyEvent` 常量）：
    `GoBack 4`、`GoHome 3`、`AppSwitch 187`、`Power 26`、`AudioVolumeUp 24`、`AudioVolumeDown 25`、`Enter 66`、`Backspace 67`、`Delete 112`、`Tab 61`、`Escape 111`、`ArrowUp 19`、`ArrowDown 20`、`ArrowLeft 21`、`ArrowRight 22`、`Home 122`、`End 123`、`PageUp 92`、`PageDown 93`。
  - `export function toVideo(p: { x: number; y: number }, device: Size, rotation: Rotation, video: Size): { x: number; y: number }`（`shared/input-map.ts`）：竖屏面板像素 → 视频帧像素，四舍五入并夹到 `[0, w-1] × [0, h-1]`。`toDevice` 的反函数：先按 `device` 归一化得到 `(rx, ry)`，再按 rotation 还原成画面上的 `(u, v)`（0：`u=rx, v=ry`；90：`u=1-ry, v=rx`；180：`u=1-rx, v=1-ry`；270：`u=ry, v=1-rx`），乘 `video` 宽高。

- [ ] **Step 1: 写测试**

  ```ts
  test("androidKeycode：页面能发出的键名都有 keycode", () => {
    const keys = [...TOOL_KEYS, "Home", "End", "PageUp", "PageDown"]; // TOOL_KEYS 来自 host/src/webmcp.ts
    for (const k of keys) assert.equal(typeof androidKeycode(k), "number", k);
  });
  test("androidKeycode：返回 / 主页 / 最近 / 回车 / 删除的值", () => {
    assert.deepEqual(["GoBack", "GoHome", "AppSwitch", "Enter", "Backspace", "Delete"].map(androidKeycode), [4, 3, 187, 66, 67, 112]);
  });
  test("androidKeycode：不认识的键名返回 null", () => assert.equal(androidKeycode("F5"), null));

  test("toVideo：竖屏时等比映射", () => {
    assert.deepEqual(toVideo({ x: 100, y: 200 }, { width: 864, height: 1920 }, 0, { width: 864, height: 1920 }), { x: 100, y: 200 });
    assert.deepEqual(toVideo({ x: 432, y: 960 }, { width: 1080, height: 2400 }, 0, { width: 864, height: 1920 }), { x: 346, y: 768 });
  });
  test("toVideo：横屏（90）时换到横向视频", () => {
    assert.deepEqual(toVideo({ x: 100, y: 200 }, { width: 864, height: 1920 }, 90, { width: 1920, height: 864 }), { x: 1720, y: 100 });
  });
  test("toVideo 是 toDevice 的反函数（0 / 90 / 180 / 270）", () => {
    // 对每个 rotation：画面上一点 → toDevice → toVideo，回到原像素（±1）
  });
  test("toVideo：夹到视频范围内", () => {
    assert.deepEqual(toVideo({ x: 864, y: 1920 }, { width: 864, height: 1920 }, 0, { width: 864, height: 1920 }), { x: 863, y: 1919 });
  });
  ```

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test shared/test/android-keys.test.ts shared/test/input-map.test.ts` Expected: FAIL（模块 / 导出不存在）。
- [ ] **Step 3: 实现** `androidKeycode`、`toVideo`。
- [ ] **Step 4: 跑测试** 同上 Expected: PASS。
- [ ] **Step 5: 提交** `git commit -m "shared: Map key names to Android keycodes and panel points to video pixels"`

### Task 2: 协议（`scroll` 消息与能力）

**Files:**
- Modify: `shared/protocol.ts`（`ClientMsg`、`parseClientMsg`、`DeviceCaps`）、`gateway/src/emulator.ts`（`EMULATOR_CAPS` 加 `scroll: false`）
- Test: `shared/test/protocol.test.ts`；`gateway/test/server.test.ts` 里 `EMU_CAPS` 等能力表期望同步加 `scroll`

**Interfaces:**
- Produces:
  - `ClientMsg` 新增 `| { t: "scroll"; x: number; y: number; dx: number; dy: number }`，注释：「真机原生滚动：x、y 同 touch，dx、dy 是滚轮的 CSS 像素位移。只在 `caps.scroll` 为 true 时发」。
  - `DeviceCaps` 新增 `scroll: boolean`。
  - `parseClientMsg`：四个字段都是有限数才收，多余字段丢掉。

- [ ] **Step 1: 写测试**

  ```ts
  test("parseClientMsg：scroll 只收四个有限数", () => {
    assert.deepEqual(parseClientMsg('{"t":"scroll","x":1,"y":2,"dx":0,"dy":-120,"z":1}'), { t: "scroll", x: 1, y: 2, dx: 0, dy: -120 });
    assert.equal(parseClientMsg('{"t":"scroll","x":1,"y":2,"dy":3}'), null);
    assert.equal(parseClientMsg('{"t":"scroll","x":"1","y":2,"dx":0,"dy":3}'), null);
  });
  ```

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test shared/test/protocol.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现**，并给 `EMULATOR_CAPS` 加 `scroll: false`、`PHONE_CAPS` 暂加 `scroll: false`（Task 4 再打开）。
- [ ] **Step 4: 跑全部单测** Run: `npm test` Expected: PASS（`server.test.ts` 里 `ready` 的能力表期望同步改过）。
- [ ] **Step 5: 提交** `git commit -m "protocol: Add native scroll for devices that support it"`

### Task 3: scrcpy 控制消息编码与设备消息解析（纯函数）

**Files:**
- Modify: `gateway/src/scrcpy.ts`
- Test: `gateway/test/scrcpy.test.ts`

**Interfaces:**
- Produces（都在 `gateway/src/scrcpy.ts`，格式见 Global Constraints 的表）：
  - `export type Action = 0 | 1 | 2`（DOWN / UP / MOVE）
  - `export function injectKeycode(action: 0 | 1, keycode: number): Buffer`（repeat、meta 为 0）
  - `export function injectText(text: string): Buffer`
  - `export function injectTouch(action: Action, x: number, y: number, video: Size): Buffer`（pointerId `-2n`；pressure 抬起为 0，其余 `0xffff`）
  - `export function injectScroll(x: number, y: number, video: Size, hscroll: number, vscroll: number): Buffer`：入参是 `[-16, 16]` 的滚动量，先夹到范围、除以 16，再编码成 i16 定点（等于 1 时写 `0x7fff`，否则 `Math.round(v * 0x8000)` 并夹到 `[-0x8000, 0x7fff]`）
  - `export const CLIPBOARD_MAX_BYTES = (1 << 18) - 14`
  - `export function setClipboard(text: string, paste: boolean): Buffer`：sequence 写 0；UTF-8 超过 `CLIPBOARD_MAX_BYTES` 时抛 `Error("文字太长，手机剪贴板最多约 256KB")`
  - `export type DeviceEvent = { kind: "clipboard"; text: string } | { kind: "ack"; sequence: bigint }`
  - `export function createDeviceMessageParser(onEvent: (e: DeviceEvent) => void): { push(chunk: Buffer): void }`：任意切块喂入；UHID 输出按长度跳过不回调；遇到未知类型抛错（调用方据此关会话）。
  - `serverArgs` 加 `clipboard_autosync=true`，删掉「剪贴板这一版不开」的说法。

- [ ] **Step 1: 写测试**（逐字节断言）

  ```ts
  test("injectKeycode：14 字节，GoBack 按下", () => {
    assert.deepEqual([...injectKeycode(0, 4)], [0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
  test("injectText：类型 1 + 长度 + UTF-8", () => {
    assert.deepEqual([...injectText("a")], [1, 0, 0, 0, 1, 0x61]);
  });
  test("injectTouch：32 字节，pointerId -2，按下压力 0xffff、抬起 0，带视频宽高", () => {
    const down = injectTouch(0, 100, 200, { width: 864, height: 1920 });
    assert.equal(down.length, 32);
    assert.equal(down.readUInt8(1), 0);
    assert.equal(down.readBigInt64BE(2), -2n);
    assert.deepEqual([down.readInt32BE(10), down.readInt32BE(14), down.readUInt16BE(18), down.readUInt16BE(20), down.readUInt16BE(22)], [100, 200, 864, 1920, 0xffff]);
    assert.equal(injectTouch(1, 100, 200, { width: 864, height: 1920 }).readUInt16BE(22), 0);
  });
  test("injectScroll：21 字节，滚动量 /16 后编码，超出夹到 ±16", () => {
    const b = injectScroll(10, 20, { width: 864, height: 1920 }, 0, -1.2);
    assert.equal(b.length, 21);
    assert.equal(b.readInt16BE(15), Math.round((-1.2 / 16) * 0x8000));
    assert.equal(injectScroll(0, 0, { width: 1, height: 1 }, 0, 99).readInt16BE(15), 0x7fff);
  });
  test("setClipboard：sequence 0、paste 标志、长度、UTF-8", () => {
    const b = setClipboard("中", true);
    assert.deepEqual([...b], [9, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 3, 0xe4, 0xb8, 0xad]);
  });
  test("setClipboard：超过 262130 字节抛错", () => {
    assert.throws(() => setClipboard("a".repeat(CLIPBOARD_MAX_BYTES + 1), false), /文字太长/);
  });
  test("设备消息：剪贴板文本被切在 UTF-8 字符中间也能完整还原", () => {
    // [0][len][utf8("复制👍")] 逐字节 push，回调一次，text === "复制👍"
  });
  test("设备消息：ack 和 UHID 输出不影响后面的剪贴板消息", () => {
    // [1][u64 7] + [2][u16 1][u16 2][2 字节] + [0][len]["x"] 一次 push → 回调 ack(7n) 和 clipboard("x")
  });
  test("serverArgs 带 clipboard_autosync=true", () => {
    assert.match(serverArgs("0000abcd", "/data/local/tmp/x.jar"), / clipboard_autosync=true /);
  });
  ```

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test gateway/test/scrcpy.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试** 同上 Expected: PASS。
- [ ] **Step 5: 提交** `git commit -m "gateway: Encode scrcpy input messages and read device messages"`

### Task 4: PhoneSession 接上输入和剪贴板

**Files:**
- Modify: `gateway/src/phone-session.ts`、`gateway/src/emulator.ts`（`EmulatorSession` 加可选 `scroll?(x: number, y: number, dx: number, dy: number): Promise<void>`）
- Test: `gateway/test/phone-session.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `androidKeycode`、`toVideo`；Task 3 的编码函数和 `createDeviceMessageParser`。
- Produces（会话行为）：
  - `caps`：`{ rotate: false, reboot: false, stop: false, clipboard: true, input: true, scroll: true }`；文件头注释和 `PHONE_CAPS` 注释改掉「只能看画面」。
  - `touch(x, y, down)`：按取舍 3 选 action，坐标经 `toVideo(…, session.device, session.rotation, 当前视频尺寸)`，写 `injectTouch`。
  - `key(key, eventType)`：按取舍 2。
  - `text(text)`：写 `setClipboard(text, true)`，并更新剪贴板缓存；超限时 reject（`setClipboard` 抛的错），不写。
  - `setClipboard(text)`：写 `setClipboard(text, false)`，更新缓存；超限同上。
  - `getClipboard()`：返回缓存（取舍 7）。
  - `onClipboard(cb)`：控制连接的数据交给 `createDeviceMessageParser`；`clipboard` 事件更新缓存并回调所有 cb。解析器抛错时按「控制连接出错」关会话。
  - `scroll(x, y, dx, dy)`：坐标同 `touch`；滚动量按取舍 5，常量 `PX_PER_SCROLL = 100`。
  - 会话包尺寸变化时若正按着：用新尺寸在最后一点发 `ACTION_UP`，清掉「按着」（Review Focus 1）。
  - 会话已关闭、或控制连接还没连上时，所有输入直接 resolve，不写（Review Focus 4）。

- [ ] **Step 1: 写测试**（沿用现有 `phone-session.test.ts` 的假 deps 和 `PassThrough` 控制连接，读控制连接上写出的字节断言）

  ```ts
  test("touch：按下 → 移动 → 抬起依次写 DOWN / MOVE / UP，坐标按视频尺寸", ...);   // 会话包 864x1920，device 864x1920
  test("touch：没按着时的抬起不写", ...);
  test("横屏视频时 touch 坐标经 toVideo 换算", ...);                               // 会话包 1920x864，touch(100,200) → x 1720, y 100
  test("按着时视频尺寸变了：用新尺寸补一个 UP，下一次 down 重新从 DOWN 开始", ...);
  test("key：GoBack keypress 写按下 + 抬起两条；单个字符 keypress 写 inject text", ...);
  test("key：不认识的键名 reject「不认识的按键」，不写", ...);
  test("text：写 set clipboard 且 paste=1；之后 getClipboard 返回这段文字", ...);
  test("text / setClipboard：超长 reject「文字太长」，会话不关", ...);
  test("控制连接回传剪贴板 → onClipboard 回调、getClipboard 更新", ...);
  test("scroll：往下滚 120px 写 vscroll 为负；坐标按视频尺寸", ...);
  test("会话关闭后 touch / key / text 都 resolve 且不写", ...);
  test("caps：真机支持输入、剪贴板、滚动，不支持旋转、重启、关机", ...);
  ```

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test gateway/test/phone-session.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现**。真机验收后补：两次粘贴之间至少隔 `PASTE_GAP_MS = 100`（服务端异步注入粘贴键，连发的文字会互相覆盖剪贴板）。
- [ ] **Step 4: 跑全部单测** Run: `npm test` Expected: PASS（`server.test.ts` 里真机 `ready` 的能力表期望同步改）。
- [ ] **Step 5: 提交** `git commit -m "gateway: Drive a phone with touch, keys, text and clipboard"`

### Task 5: 服务端转发 `scroll`

**Files:**
- Modify: `gateway/src/server.ts`（`switch (m.t)` 加 `case "scroll"`）
- Test: `gateway/test/server.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `scroll` 消息、`caps.scroll`；Task 4 的 `session.scroll`。
- Produces: 会话 `caps.scroll` 为 true 且有 `scroll` 方法时 `enqueue("scroll", (s) => s.scroll!(m.x, m.y, m.dx, m.dy))`；否则忽略（不报错，模拟器上不会发生，旧页面也不会发）。

- [ ] **Step 1: 写测试**

  ```ts
  test("真机会话收到 scroll 时转给 session.scroll", ...);          // FakePhone 记录调用参数
  test("模拟器会话收到 scroll 时忽略，不报错", ...);
  test("真机的 touch / key / text / clip 照常转给会话", ...);       // 证明 PR 3 时代的 no-op 路径已接通
  ```

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test gateway/test/server.test.ts` Expected: FAIL（前两条）。
- [ ] **Step 3: 实现**；`FakePhone` 加 `scroll` 与调用记录。
- [ ] **Step 4: 跑全部单测** Run: `npm test` Expected: PASS。
- [ ] **Step 5: 提交** `git commit -m "gateway: Pass native scroll to phone sessions"`

### Task 6: 页面（滚轮、底部按键、文案）

**Files:**
- Modify: `host/src/main.ts`（滚轮）、`ui/App.tsx`（底部三键）、`ui/phones.ts`（文案）
- Test: `shared/test/phones-ui.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `scroll` 消息、`DeviceCaps.scroll`；host 现有的 `caps` 状态（PR 3）。
- Produces:
  - `host/src/main.ts` 的 `wheel` 监听：`caps?.scroll === true` 时不走 `wheelToSwipe`，把 `deltaMode` 换算后的 `dx`、`dy` 累加，16ms 后发一条 `{ t: "scroll", x, y, dx, dy }`（`x`、`y` 取最后一次事件的 `toDevice` 坐标）；`dx`、`dy` 都为 0 不发；指针按着时照旧丢掉。否则保持现状（模拟器）。
  - `ui/App.tsx` 底部「返回 / 主页 / 最近」三个 `ToolBtn` 的 `disabled` 加 `|| caps()?.input === false`，和电源、音量键一致。
  - `ui/phones.ts`：`phoneStatus(p, true)` 对可用手机返回 `"当前画面"`。

- [ ] **Step 1: 改测试** `phones-ui.test.ts`：

  ```ts
  assert.equal(phoneStatus({ id: "a", state: "device" }, true), "当前画面");
  ```

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test shared/test/phones-ui.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现** 三处改动。
- [ ] **Step 4: 跑测试和构建** Run: `npm test`、`bun run build:host`、`bun run build:ui` Expected: 全部通过。
- [ ] **Step 5: 提交** `git commit -m "ui: Scroll, press keys and type on a phone"`

### Task 7: 真机集成测试、文档、真机验收

**Files:**
- Create: `gateway/test/phone.it.test.ts`
- Modify: `CONTEXT.md`（**Phone session** 条目：去掉「Input is not supported yet」，写明输入和剪贴板走 scrcpy 控制连接）

**Interfaces:**
- Consumes: Task 4 的会话；`gateway/src/main.ts` 的 `phoneDeps(id)`（若不便直接 import，测试里按它的写法组 deps）。

- [ ] **Step 1: 写集成测试**，`PHONE_IT=1 PHONE_IT_SERIAL=<序列号>` 才跑，跳过方式照 `gateway/test/emulator.it.test.ts`：

  ```ts
  test("每种控制消息发出后会话仍在：服务端能解析我们写的字节", { skip }, async (t) => {
    // connectPhone → touch 按下/移动/抬起、scroll、key("GoHome","keypress")、key("a","keypress")、
    // setClipboard("droidpier-it")、text("中文") → 等 1 秒 → 没有触发 onClosed；最后 close()
  });
  ```

  这条测的是字节格式：服务端解析失败会抛 `ControlProtocolException`、控制线程退出、连接断开。

- [ ] **Step 2: 在真机上跑** Run: `PHONE_IT=1 PHONE_IT_SERIAL=R5CR10WN52H node --test gateway/test/phone.it.test.ts` Expected: PASS；不带变量时 SKIP。
- [ ] **Step 3: 改 `CONTEXT.md`**。
- [ ] **Step 4: 真机页面验收**（`--phones --local`，三星 SM-G9910 解锁）：
  - 点击打开 App、长按、拖动列表；返回 / 主页 / 最近三键和 ⌘⌫ / ⇧⌘H / ⌘O；电源（灭屏再点亮）、音量；
  - 触控板和鼠标滚轮滚动长列表，方向和速度合适（不合适就调 `PX_PER_SCROLL`）；
  - 在输入框里打英文、回车、删除、方向键；用输入法打中文；⌘V 粘贴一段中英文混排；
  - 手机上复制一段文字，Mac 剪贴板里出现；Mac 复制后在手机上粘贴；
  - 手机转横屏后点击位置仍准确；按着时转屏后能正常再点；
  - 上游 `7700ba9` 的 H5 控制台自动打开和元素拾取在真机上可用（PR 3 时手机锁屏没验到）；
  - 切回模拟器，点击、滚轮滑动、打字照旧。
- [ ] **Step 5: 提交** `git commit -m "docs: Describe phone input and add a phone integration test"`

## 后续

- 真机重启（`adb reboot`，spec 6.1 / 6.5）。
- 按页面尺寸重启 scrcpy 服务端（spec 6.2「长边差 20% 才重启」）。
- WebMCP 按能力表处理真机（PR 6）；日志面板（PR 5）。
- 去掉 `--phones`，真机默认开启（spec 7 节，PR 4 合入并真机验收后的小 PR）。
- PR 3 遗留的 Minor（见 twosugar/droidpier#39 描述）。
