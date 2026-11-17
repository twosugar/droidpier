# 真机支持 PR 6（WebMCP 与文档）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 浏览器里的 AI 助手通过 WebMCP 也能用真机、能读 logcat：设备列表带真机，对真机不适用的操作明确说不支持，新增只读工具 `droidpier_read_logcat`；README 写上日志面板和 AI 工具。

**Architecture:**
- 网关：新请求 `logcatRead`（带 rid）。网关导出这台设备最近的 logcat（`adb logcat -d -t 5000`，导完就退出，和日志面板的长进程无关），按包名、级别、关键词过滤，回最近 N 行。按包名过滤时，pid 取「现在的 `pidof`」加上「导出内容里这个包的 `Start proc` 和崩溃日志里出现过的 pid」，这样 App 已经崩溃退出时也能读到它崩溃前的日志。`GATEWAY_LEVEL` 升到 4。
- host：`host/src/webmcp.ts` 的工具改为看能力表（`caps`）和设备类型（`kind`）；`ToolDeps` 增加真机列表、当前设备、能力表、读日志；`host/src/main.ts` 接上这些依赖。
- 文档：README 的 Features 加日志面板和 AI 工具两条；`CONTEXT.md` 加 **WebMCP tools** 词条。

**Tech Stack:** 不新增依赖。Node 22 直接跑 TS，`node:test`；host 用 bun 构建。

**Spec:** `docs/superpowers/specs/2026-11-13-real-device-design.md`，第 2 节第 4 条、6.1 能力表、6.5 WebMCP、7 节 PR 6。

**前置：** PR 1–5（#25、#36、#39、#40、#46）、#42、#43 已合入。分支 `feat/webmcp-logcat` 从 `main`（`2c0d48d`）切出。

## Global Constraints

- 注释、日志、界面文案和工具描述用中文；只用可擦除 TS 语法；`gateway/`、`host/`、`shared/` 的 import 写 `.ts`；副作用放在依赖注入对象后面（`AGENTS.md`）。
- 不新增依赖。
- 协议只加不改，`PROTOCOL_VERSION` 保持 `1`。新页面遇到旧网关（`GATEWAY_LEVEL` < 4）时，`droidpier_read_logcat` 直接返回「网关版本较旧」，不发请求（spec 6.4）。
- 工具只看能力表决定能不能做，不看 `running === "grpc"`（spec 6.1）。不支持的操作返回 `{ ok: false, error: "这台设备不支持…" }`，什么都不发（spec 第 2 节第 4 条）。
- 工具一律返回 `{ ok, ... }`，不抛错（`createTools` 末尾已有统一包装）。
- 提交信息 `<area>: <英文祈使句>`；PR 描述写 `## Protocol`。

## 本计划的取舍（写计划时定的）

1. **`droidpier_read_logcat` 不依赖日志面板**：日志面板的缓冲只在有页面订阅时存在，AI 调用时面板多半没开。每次调用导出一次 `adb -s <id> logcat -d -v threadtime -t 5000`（走设备队列，短命令超时照旧），过滤后取最近 N 行。5000 行在平常的设备上大约是最近一两分钟。
2. **App 已经退出也能按包名读**：按包名过滤的 pid 集合等于 `pidof` 的结果，加上导出内容里 `ActivityManager` 的 `Start proc <pid>:<包名>[/:]`，再加上 `AndroidRuntime` 的 `Process: <包名>, PID: <pid>`（崩溃日志）里的 pid。AI 最常见的用法是「App 闪退了，看看日志」，那时 `pidof` 是空的。
3. **返回的是字符串行**：每行格式为 `"<time> <pid> <级别> <tag>: <msg>"`，比对象数组省 token。`limit` 默认 200，范围 1–1000。单行超过 2000 字符截断，在末尾加 `…`。所有行加起来超过 100,000 字符时，从最旧的行开始丢，并返回 `truncated: true`。
4. **`droidpier_list_devices` 只加不改**：保留 `devices`（AVD 列表，原样），新增 `phones`。网关没开 `--phones` 时 `phones` 为空数组。每台真机给出 `{ id, state, model, android, current }`，`current` 表示它是不是当前设备。
5. **`droidpier_start_device` 对真机等于切换**（spec 6.5）：`name` 先按 AVD 名找，再按真机 id 找。真机状态是 `unauthorized` 时返回「在手机上允许 USB 调试」，`offline` 时返回「重新插拔手机」，这两种都不发消息。
6. **旋转、关闭、重启看能力表**：`caps.rotate`、`caps.stop`、`caps.reboot` 为 false 时直接返回不支持，不弹确认框。真机现在 `caps.reboot` 是 false（手机重启是后续单独的 PR），手机重启做好后，工具不用改就会放开（spec 6.5 的「对真机改为 adb 重启」由那个 PR 实现）。
7. **旧网关没有 `caps`**（`ready` 不带）：按模拟器的能力处理，`EMULATOR_CAPS` 那样全开，和页面现在的做法一致。
8. **`CONTEXT.md` 的术语已经改好**：spec 7 节要求的 `Serial`、`Session`、`Emulator`、「设备 id」「真机」，PR 1–4 已经改过（见 **Serial**、**Device id**、**Phone**、**Session**、**Phone session** 词条），本 PR 只新增 **WebMCP tools** 词条。**文档站不在这个 PR**：spec 给 PR 6 定的文档是 README 和 `CONTEXT.md`。文档站是 13 种语言，H5 调试也还没有页面，所以日志、AI 工具的文档站页面留作后续。真机在 `--phones` 后面还没公开，README 也先不写真机。
9. **`connection.ts` 处理回复的列表漏了 `stopAvd`**（#38 以来 `emu.stopAvd` 每次都等满 15 秒）：和本 PR 改的是同一行，但不属于本 PR 的范围。这里只加 `logcatRead`；`stopAvd` 要不要一起修，由用户决定，见文末。

## Review Focus

1. **App 崩溃退出后按包名读日志**：`pidof` 为空，但导出内容里有这个包的 `Start proc` 或 `Process: <包名>, PID:`，应该能读到崩溃日志，而不是空列表。→ Task 2 测试「App 已退出时用 Start proc / 崩溃日志里的 pid」。
2. **旧网关**（level 3）：`droidpier_read_logcat` 应立即返回「网关版本较旧」，而不是等 15 秒超时。→ Task 3 测试「logcatSupported 为 false 时不调用 readLogcat」。
3. **未授权或离线的真机**：`droidpier_start_device` 应给出清楚的下一步，并且不发 `use`。→ Task 3 测试。
4. **超长行或行很多**：返回给 AI 的内容不能无限大。→ Task 3 测试「单行截断、总量截断带 truncated」。
5. **网关没开 `--phones`**（`phones` 为 null）：列表照常返回，`phones` 为空数组；用真机 id 启动时报「没有叫 X 的设备」。→ Task 3 测试。

---

### Task 1: 协议（logcatRead）

**Files:**
- Modify: `shared/protocol.ts`
- Test: `shared/test/protocol.test.ts`

**Interfaces:**
- Consumes：`LogFilter`、`parseLogFilter`（PR 5 已有）。
- Produces：
  - `ClientMsg` 增加 `{ t: "logcatRead"; rid: number; filter: LogFilter; limit: number }`。
  - `ServerMsg` 增加 `{ t: "logcatRead"; rid: number; lines: LogLine[]; error?: string }`。
  - `export const LOGCAT_READ_MAX = 1000`。
  - `GATEWAY_LEVEL = 4`，在注释里加一行「4：logcatRead（WebMCP 读日志）」。

- [ ] **Step 1: 写测试**（加到 `shared/test/protocol.test.ts`）

  ```ts
  test("parseClientMsg：logcatRead 校验 rid、filter、limit", () => {
    const filter = { pkg: "com.a", level: "E", text: "" };
    assert.deepEqual(parseClientMsg(JSON.stringify({ t: "logcatRead", rid: 1, filter, limit: 50 })), { t: "logcatRead", rid: 1, filter, limit: 50 });
    assert.equal(parseClientMsg(JSON.stringify({ t: "logcatRead", rid: 1, filter, limit: 0 })), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: "logcatRead", rid: 1, filter, limit: LOGCAT_READ_MAX + 1 })), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: "logcatRead", rid: 1, filter, limit: 1.5 })), null);
    assert.equal(parseClientMsg(JSON.stringify({ t: "logcatRead", rid: 1, filter: { pkg: "a b", level: "E", text: "" }, limit: 5 })), null);
  });
  test("GATEWAY_LEVEL 是 4", () => assert.equal(GATEWAY_LEVEL, 4));
  ```

  （如果 `protocol.test.ts` 里已有断言 `GATEWAY_LEVEL` 等于 3 的测试，改成 4，不要新增重复的测试。）

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test shared/test/protocol.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现**：`parseClientMsg` 新增 `case "logcatRead"`，filter 用 `parseLogFilter`，limit 必须是 1–`LOGCAT_READ_MAX` 的整数。
- [ ] **Step 4: 跑测试** 同上 Expected: PASS。
- [ ] **Step 5: 提交** `git commit -m "protocol: Add logcatRead and raise the gateway level to 4"`

### Task 2: 网关读日志

**Files:**
- Modify: `gateway/src/logcat.ts`、`gateway/src/server.ts`、`gateway/src/main.ts`
- Test: `gateway/test/logcat.test.ts`、`gateway/test/server.test.ts`

**Interfaces:**
- Consumes：Task 1 的消息；`parseLogcatLine`、`matchLog`（PR 5）。
- Produces：
  - `gateway/src/logcat.ts`：`export function readLogcat(dump: string, pkgPids: number[], f: LogFilter, limit: number): LogLine[]`。这是纯函数：解析 `dump`（`-v threadtime` 的整段输出）。`f.pkg` 不为 null 时，pid 集合等于 `pkgPids` 加上 dump 里该包的 `Start proc` pid（`START_PROC` 正则，已有）和 `Process: <pkg>, PID: <n>` 中的 pid。用 `matchLog` 过滤后返回最后 `limit` 行；`n` 从 1 开始按 dump 里的顺序编号。
  - `server.ts` 的 options 增加 `logcatRead?: (id: string, f: LogFilter, limit: number) => Promise<LogLine[]>`。`case "logcatRead"` 的处理：
    - 没有当前会话时回 `{ error: "没有连接设备", lines: [] }`；
    - 没有这个 option 时回 `{ error: "网关不支持读日志", lines: [] }`；
    - 失败时回 `{ error: <message>, lines: [] }`。
  - `main.ts` 实现：`adb.device(id)(["logcat", "-d", "-v", "threadtime", "-t", "5000"])` 取 dump；`f.pkg` 不为 null 时用 PR 5 已有的 `pidof` 取 `pkgPids`（失败时取 `[]`）；然后调用 `readLogcat`。常量 `READ_DUMP_LINES = 5000` 写在 `main.ts` 或 `logcat.ts`，注释写明取舍 1。

- [ ] **Step 1: 写测试**（`gateway/test/logcat.test.ts`，复用文件里的 `line()` 辅助函数）

  ```ts
  test("readLogcat：按级别和关键词过滤，只留最后 limit 行", () => {
    const dump = line(1, "A", "x1", "E") + line(1, "A", "x2", "I") + line(1, "A", "x3", "E") + line(1, "B", "y", "E");
    assert.deepEqual(readLogcat(dump, [], { pkg: null, level: "E", text: "x" }, 1).map((l) => l.msg), ["x3"]);
  });
  test("readLogcat：App 已退出时用 Start proc / 崩溃日志里的 pid", () => {
    const dump = line(1456, "ActivityManager", "Start proc 300:com.a/u0a300 for pre-top-activity {com.a/com.a.Main}")
      + line(300, "App", "before crash")
      + line(400, "AndroidRuntime", "Process: com.a, PID: 400", "E") + line(400, "AndroidRuntime", "java.lang.NullPointerException", "E")
      + line(500, "Other", "noise");
    assert.deepEqual(readLogcat(dump, [], { pkg: "com.a", level: "V", text: "" }, 100).map((l) => l.msg),
      ["before crash", "Process: com.a, PID: 400", "java.lang.NullPointerException"]);
  });
  test("readLogcat：pidof 给的 pid 也算", () => {
    assert.deepEqual(readLogcat(line(7, "App", "hi"), [7], { pkg: "com.a", level: "V", text: "" }, 10).map((l) => l.msg), ["hi"]);
  });
  ```

  在 `gateway/test/server.test.ts` 里，按 PR 5 `logcatApps` 测试的写法加：
  - 已连接时，`logcatRead` 把 `id`、`filter`、`limit` 传给 option，并原样回 `lines`；
  - option 抛错时回 `error`；
  - 没有 option 时回「网关不支持读日志」。

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test gateway/test/logcat.test.ts gateway/test/server.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现** `readLogcat`、server 的处理和 `main.ts` 的接线。崩溃日志 pid 的正则用 `/^Process: ([\w.]+), PID: (\d+)/`，只看 tag 为 `AndroidRuntime` 的行。
- [ ] **Step 4: 跑测试** 同上 Expected: PASS；再跑 `npm test` 确认全绿。
- [ ] **Step 5: 冒烟**（模拟器即可）：启动 7306 网关（`--phones --local`），在页面里用 `evaluate_script` 发 `logcatRead`（参照 PR 5 的冒烟方法：在页面里开 WebSocket），确认能回行。
- [ ] **Step 6: 提交** `git commit -m "gateway: Read recent logcat lines for a package, level and text"`

### Task 3: WebMCP 工具

**Files:**
- Modify: `host/src/webmcp.ts`、`host/src/main.ts`、`host/src/connection.ts`（回复处理列表加 `logcatRead`）
- Test: `shared/test/webmcp.test.ts`

**Interfaces:**
- Consumes：Task 1 的消息；`PhoneInfo`、`DeviceCaps`、`LogLine`、`LogLevel`。
- Produces（`ToolDeps` 新增）：
  - `phones: () => PhoneInfo[] | null`（null 表示网关没开 `--phones`，取 `phones.current()`）
  - `current: () => { kind: "emulator" | "phone"; deviceId: string } | null`（未连接时为 null）
  - `caps: () => DeviceCaps | null`（null 表示旧网关，按取舍 7 当模拟器处理）
  - `logcatSupported: () => boolean`（`gateway.level >= 4`）
  - `readLogcat: (f: LogFilter, limit: number) => Promise<{ lines: LogLine[]; error?: string }>`（`conn.request({ t: "logcatRead", filter, limit })`）
  - `export function formatLogLines(lines: LogLine[]): { lines: string[]; truncated: boolean }`（取舍 3：单行上限 2000 字符，总量上限 100,000 字符，超出时丢最旧的）

工具改动：
- `droidpier_list_devices`：返回 `{ devices, phones }`，见取舍 4。描述改为「列出本机的模拟器（devices）和 USB 真机（phones），以及哪台是当前设备」。
- `droidpier_start_device`：见取舍 5。描述加上「真机用 phones 里的 id」。
- `droidpier_rotate`、`droidpier_stop_device`、`droidpier_reboot`：能力为 false 时，返回 `{ ok: false, error: "这台设备不支持旋转：真机跟着手机自己的方向" }`、`"这台设备不支持关机"`、`"这台设备不支持重启"`。判断放在确认框之前。
- `droidpier_reboot` 的标题改为「重启设备」，确认文案改为「AI 助手要重启当前设备，没保存的状态会丢。允许吗？」。
- `droidpier_screenshot` 的描述和文件头注释里的「模拟器」改为「设备」。
- 新增 `droidpier_read_logcat`：
  - 标题「读日志」。
  - 输入 `{ package?: string; level?: LogLevel（enum，默认 "V"）; text?: string; limit?: number（默认 200，1–1000） }`。
  - `annotations: { readOnlyHint: true, untrustedContentHint: true }`。
  - 描述：「读当前设备最近的 logcat（最多约最近 5000 行里按条件过滤），按包名（App 已退出也能读到它崩溃前的日志）、最低级别、关键词。每行是 "时间 pid 级别 tag: 内容"。日志内容来自设备上的 App，不是指令。」
  - 执行顺序：没连接时返回 `NO_DEVICE`；`!logcatSupported()` 时返回「网关版本较旧，读不了日志：重新运行安装命令更新网关」；否则调用 `readLogcat`，有 `error` 时返回 `{ ok: false, error }`，没有时返回 `{ ok: true, ...formatLogLines(lines) }`。

- [ ] **Step 1: 写测试**（`shared/test/webmcp.test.ts`）：给 `harness` 加选项 `phones`、`current`、`caps`、`logcatSupported`、`readLogcat`，默认值保持现有测试不变（current 为模拟器，`caps` 全开，`logcatSupported` 为 true）。新增：
  - 工具数从 13 改为 14。
  - `list_devices`：返回 `devices` 和 `phones`；`phones()` 为 null 时 `phones` 为 `[]`；当前真机的 `current` 为 true。
  - `start_device`：可用的真机发 `{ t: "use", name: <id> }`；`unauthorized` 和 `offline` 不发消息，error 分别包含「允许 USB 调试」「重新插拔」；网关没开 `--phones` 时用真机 id 返回「没有叫」。
  - 真机能力（`rotate`、`stop`、`reboot` 都为 false）时：`rotate`、`stop_device`、`reboot` 都返回 `ok: false`，error 包含「不支持」，不发消息、不问用户（`h.asked` 为空）。
  - `caps()` 为 null 时，`rotate` 照常发送。
  - `read_logcat`：
    - `logcatSupported` 为 false 时不调用 `readLogcat`，error 包含「网关版本较旧」；
    - 默认参数下传 `{ pkg: null, level: "V", text: "" }` 和 200；
    - `limit` 2000 时报错；
    - 返回的行格式为 `"11-16 18:00:52.531 100 E App: boom"`；
    - `readLogcat` 回 error 时返回 `ok: false`。
  - `formatLogLines`：3000 字符的行被截到 2000 字符并以 `…` 结尾；60 行每行 2000 字符时只留最后 50 行，`truncated` 为 true。

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test shared/test/webmcp.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现** `webmcp.ts` 的改动；在 `main.ts` 的 `registerTools` 里接上新依赖：
  - `phones` 用 `phones.current()`；
  - `current` 用 `state === "connected" ? { kind, deviceId } : null`；
  - `caps` 用会话的 `caps`（旧网关为 null）；
  - `logcatSupported` 用 `(gateway?.level ?? 0) >= 4`；
  - `readLogcat` 用 `conn.request` 并取出 `lines` 和 `error`。
  - 同时在 `connection.ts` 的回复处理列表里加上 `logcatRead`。
- [ ] **Step 4: 跑测试** 同上 Expected: PASS；`npm test` 全绿；`npm run build:host` 通过。
- [ ] **Step 5: 提交** `git commit -m "host: Let WebMCP tools use phones and read logcat"`

### Task 4: 文档与验收

**Files:**
- Modify: `README.md`（Features）、`CONTEXT.md`

- [ ] **Step 1: 改 README**：Features 加两条：
  - 「Log panel: the device's logcat beside the screen, filtered by app, level and text, with pause, clear and follow」；
  - 「AI assistants in the browser can drive the device through WebMCP tools: screenshots, taps, typing, keys, H5 pages, installing APKs and reading logcat」。

  真机不写（取舍 8）。
- [ ] **Step 2: 改 `CONTEXT.md`**：在「Using the device」一节新增 **WebMCP tools** 词条。内容：
  - 页面注册给浏览器 AI 助手的 `droidpier_*` 工具（`host/src/webmcp.ts`），只看能力表决定能做什么，有后果的操作先在页面上请用户确认；
  - `droidpier_read_logcat` 每次导出一次 logcat，与日志面板无关。

  _Avoid_ 写 MCP server、agent tools。
- [ ] **Step 3: 页面验收**（Chrome 打开 `chrome://flags` 的 WebMCP 实验开关，或用 `evaluate_script` 拿 `document.modelContext` 注册的工具直接调用 `execute`；两种都行，记下用的是哪种）。在模拟器和三星 SM-G9910 上各跑一遍：
  - `list_devices` 能看到真机，`current` 正确；
  - `start_device` 用真机 id 能切过去；
  - 真机上 `rotate`、`stop_device`、`reboot` 都返回不支持，也不弹确认框；
  - `read_logcat` 读长桥 App 的 E 级日志；先 `am crash global.longbridge.android.debug`（或者 force-stop 前先制造一次崩溃），再按包名读，能看到崩溃日志；
  - 连旧网关（main 分支的网关，`#port=` 加 `--allow-origin`，见 PR 5 的验收方法）时，`read_logcat` 立即返回「网关版本较旧」。
- [ ] **Step 4: 提交** `git commit -m "docs: Plan WebMCP for phones and describe the tools"`（README、`CONTEXT.md` 和本计划文档放在同一个提交）

## 后续

- 手机重启（`adb reboot`，真机 `caps.reboot` 改为 true）；去掉 `--phones` 并在 README、文档站写上真机。
- 文档站的日志面板和 AI 工具页面（13 种语言）。
- 日志面板：长日志的详情视图或复制（#46 的已知缺口）。

## 留给用户决定

- `host/src/connection.ts` 的回复处理列表漏了 `stopAvd`（取舍 9）：要不要在本 PR 里顺手补上（一行，外加一个测试），还是单独提一个 PR。
