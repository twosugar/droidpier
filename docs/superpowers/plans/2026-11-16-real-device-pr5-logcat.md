# 真机支持 PR 5（日志面板）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 页面右侧新增「日志」面板，模拟器和真机都能看 logcat：按 App、级别、tag / 文本过滤，暂停、清空、跟随滚动；刷屏时页面不卡。

**Architecture:**
- 网关：`gateway/src/logcat.ts` 按设备管一个 `adb logcat` 长进程（有页面订阅才起，没人订阅就结束），逐行解析，留最近 5 万行，按每个订阅者的过滤条件每 100ms 合批发给页面；按 App 过滤时用 `pidof` 和 `ActivityManager` 的「Start proc」日志跟上 pid 变化。
- 协议只加不改：新消息 `logcatOpen / logcatFilter / logcatClose / logcatApps`（页面 → 网关）、`logcat / logcatApps`（网关 → 页面），`GATEWAY_LEVEL` 升到 3，页面按它决定显不显示日志面板。
- 页面：右侧面板改成「H5 调试 / 日志」两个标签页；日志列表用 nsh 的 `List`（虚拟滚动、只渲染可见行），级别用颜色区分。

**Tech Stack:** 不新增依赖。Node 22 直接跑 TS，`node:test`；页面 nsh TSX（`List`、`Select`、`Input`、`Toggle`）；构建 bun。

**Spec:** `docs/superpowers/specs/2026-11-13-real-device-design.md`，第 2 节第 3 条与成功标准第 3 条、6.2「logcat」一段、6.3「日志面板」、6.4、7 节 PR 5 与验证（「logcat 行解析和过滤」「日志面板刷屏时的 CPU」）

**前置：** PR 1–4、#42、#43 已合入。分支 `feat/logcat-panel` 从 `main`（`31f8ddc`）切出。

## Global Constraints

- 注释、日志、界面文案用中文；只用可擦除 TS 语法；`gateway/`、`host/`、`shared/` 的 import 写 `.ts`，`ui/` 不写；副作用放在依赖注入对象后面（`AGENTS.md`）。
- 不新增依赖。
- 协议只加不改，`PROTOCOL_VERSION` 保持 `1`。旧页面不认识的新消息会被忽略；新页面遇到旧网关（`GATEWAY_LEVEL` < 3）不显示日志面板（spec 6.4）。
- logcat 进程只在有页面订阅时运行：`adb -s <id> logcat -v threadtime -T 500`，走 `adb.stream`（长进程，不进设备队列、不设总超时）；没有订阅者就结束（spec 6.2、成功标准「日志面板关着时网关不占 CPU」）。
- 合批间隔 100ms、网关保留 5 万行（spec 6.2 的数值，按「我的数值」写在常量注释里注明出处）。
- 模拟器和真机共用同一套代码，不看 `kind`。
- 提交信息 `<area>: <英文祈使句>`；PR 描述写 `## Protocol`。

## 本计划的取舍（写计划时定的）

1. **消息名用仓库现有的驼峰写法**：spec 6.4 写的是 `logcat.open / close / filter`、`logcat.lines`，仓库里 `ClientMsg` / `ServerMsg` 的 `t` 都是驼峰（`renameAvd`、`stopAvd`），这里用 `logcatOpen`、`logcatFilter`、`logcatClose`、`logcat`。
2. **过滤在网关做，页面再限量**：网关按订阅者的过滤条件先过滤再发（spec 6.2）；页面最多留 2 万行，超出丢最旧的。打开面板或改过滤条件时，网关从保留的 5 万行里按新条件挑最近的至多 5000 行一次发过来（`reset: true`），避免一条消息过大。
3. **按 App 过滤的 pid**：订阅时 `pidof <包名>` 查一次，之后每 3 秒再查一次；同时解析 `ActivityManager` 的 `Start proc <pid>:<包名>/` 日志，看到就立刻把新 pid 加进去（spec 的「看到 ActivityManager 的启动日志时重新查」，直接用日志里的 pid 更快）。
4. **包名下拉的选项**：新请求 `logcatApps`（带 rid），网关回 `{ foreground, apps }`：前台 App 用 `webviews.ts` 已有的 `FOREGROUND_CMD` + `parseResumedPkg`，运行中的 App 用 `adb shell ps -A -o USER,NAME` 取 USER 以 `u0_a` 开头的进程名（去掉 `:` 后的子进程名、去重、排序）。下拉第一项「全部 App」，打开面板时默认选前台 App（spec 6.3），读不到前台时选「全部 App」。
5. **暂停、清空、跟随都在页面做**：暂停时继续收、先攒着不显示，恢复时一次补上（攒的也受 2 万行上限）；清空只清页面上的行；跟随时有新行就滚到底，用户往上滚离开底部就自动关掉跟随，点「跟随」再打开。
6. **logcat 进程意外退出**（拔线、adb 被杀）且还有订阅者：2 秒后重启一次，仍失败就每 5 秒重试；订阅者全走光就不再重试。重启后照样从 `-T 500` 开始，页面会收到重复的旧行，用「时间 + pid + tid + 内容」去重太贵，这一版接受重复（PR 描述里写明）。
7. **积压**：页面连接的发送缓冲超过 1 MiB 时，这一批不发，计数；下一批带 `dropped: <行数>`，页面在列表里插一行「省略了 N 行」。
8. **WebMCP 的 `droidpier_read_logcat`** 属于 PR 6，这一版不做。

## Review Focus

1. **刷屏**：一秒几千行时，网关每 100ms 只发一条消息，页面不卡、只留 2 万行。→ Task 3 测试「10000 行在一个合批窗口内只发一次」；Task 6 测试页面行数上限。
2. **App 重启后 pid 变了**：按包名过滤时，新进程的日志要能接着显示，不能等 3 秒。→ Task 3 测试「Start proc 日志里的新 pid 立刻生效」。
3. **一行被切在两次 data 之间**（含中文）：拼接后完整解析，不丢、不坏。→ Task 3 测试行切分。
4. **面板开着时切换设备**：日志跟着切到新设备，旧设备没人订阅时进程结束。→ Task 4 测试。
5. **两个页面开着面板、过滤条件不同**：同一台设备只起一个 logcat 进程，各自收到按自己条件过滤的行。→ Task 3 测试。

---

### Task 1: logcat 行解析与过滤（shared，纯函数）

**Files:**
- Create: `shared/logcat.ts`
- Test: `shared/test/logcat.test.ts`

**Interfaces:**
- Produces（`shared/logcat.ts`）：
  - `export type LogLevel = "V" | "D" | "I" | "W" | "E" | "F"`（logcat 的 `A` 归为 `F`）
  - `export type LogLine = { n: number; time: string; pid: number; tid: number; level: LogLevel; tag: string; msg: string }`（`n` 是网关给的递增序号，页面用作 key）
  - `export function parseLogcatLine(s: string): Omit<LogLine, "n"> | null`：按 `-v threadtime` 解析；分隔行（`--------- beginning of …`）和认不出的行返回 `null`。tag 取到第一个「`: `」为止（tag 里可能有 `::`），去掉尾部空格；行尾没有「`: `」而以「`:`」结尾时 msg 为空串。
  - `export type LogFilter = { pkg: string | null; level: LogLevel; text: string }`（页面发给网关的过滤条件；`text` 不区分大小写，匹配 tag 或 msg）
  - `export function levelAtLeast(l: LogLevel, min: LogLevel): boolean`
  - `export function matchLog(line: Omit<LogLine, "n">, f: { pids: ReadonlySet<number> | null; level: LogLevel; text: string }): boolean`（`pids` 为 null 表示不按 App 过滤）

- [ ] **Step 1: 写测试**（样例取自 2026-11-16 SM-G9910 / 模拟器的真实输出）

  ```ts
  test("parseLogcatLine：threadtime 行", () => {
    assert.deepEqual(parseLogcatLine("11-16 18:00:52.531  1456  1885 I ActivityManager: Killing 5050:com.x/u0a187 (adj 999)"),
      { time: "11-16 18:00:52.531", pid: 1456, tid: 1885, level: "I", tag: "ActivityManager", msg: "Killing 5050:com.x/u0a187 (adj 999)" });
  });
  test("parseLogcatLine：tag 里有 ::，按第一个「: 」切", () => {
    assert.equal(parseLogcatLine("11-16 18:02:18.694  3586  3661 D engine::api::beacon::sink::http: message=fail")?.tag, "engine::api::beacon::sink::http");
  });
  test("parseLogcatLine：tag 带尾部空格、msg 为空、级别 A 归为 F", () => {
    assert.equal(parseLogcatLine("11-16 18:00:52.531  1  2 W Tag     : hi")?.tag, "Tag");
    assert.equal(parseLogcatLine("11-16 18:00:52.531  1  2 E Tag:")?.msg, "");
    assert.equal(parseLogcatLine("11-16 18:00:52.531  1  2 A Tag: boom")?.level, "F");
  });
  test("parseLogcatLine：分隔行和乱行返回 null", () => {
    assert.equal(parseLogcatLine("--------- beginning of main"), null);
    assert.equal(parseLogcatLine("garbage"), null);
  });
  test("matchLog：级别下限、pid、文本（不区分大小写，匹配 tag 或 msg）", () => {
    const l = parseLogcatLine("11-16 18:00:52.531  100  2 W WebView: Loading URL")!;
    assert.equal(matchLog(l, { pids: null, level: "W", text: "" }), true);
    assert.equal(matchLog(l, { pids: null, level: "E", text: "" }), false);
    assert.equal(matchLog(l, { pids: new Set([100]), level: "V", text: "webview" }), true);
    assert.equal(matchLog(l, { pids: new Set([101]), level: "V", text: "" }), false);
    assert.equal(matchLog(l, { pids: null, level: "V", text: "url" }), true);
    assert.equal(matchLog(l, { pids: null, level: "V", text: "nope" }), false);
  });
  ```

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test shared/test/logcat.test.ts` Expected: FAIL（模块不存在）。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试** 同上 Expected: PASS。
- [ ] **Step 5: 提交** `git commit -m "shared: Parse and filter logcat lines"`

### Task 2: 协议

**Files:**
- Modify: `shared/protocol.ts`
- Test: `shared/test/protocol.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `LogLevel`、`LogLine`、`LogFilter`。
- Produces：
  - `GATEWAY_LEVEL` 升到 `3`，注释加一行「3：日志面板（logcatOpen / logcatFilter / logcatClose / logcatApps）」。
  - `ClientMsg` 新增：`{ t: "logcatOpen"; filter: LogFilter }`、`{ t: "logcatFilter"; filter: LogFilter }`、`{ t: "logcatClose" }`、`{ t: "logcatApps"; rid: number }`。
  - `ServerMsg` 新增：`{ t: "logcat"; lines: LogLine[]; reset: boolean; dropped?: number }`（`reset` 为 true 时页面先清空再放这些行）、`{ t: "logcatApps"; rid: number; foreground: string | null; apps: string[] }`。
  - `parseClientMsg` 校验 filter：`pkg` 为 null 或匹配 `/^[A-Za-z][\w.]*$/` 且不超过 200 字符；`level` 是六个之一；`text` 是字符串、截到 200 字符。不合法返回 null；多余字段丢掉。

- [ ] **Step 1: 写测试**

  ```ts
  test("parseClientMsg：logcatOpen / logcatFilter 校验过滤条件", () => {
    assert.deepEqual(parseClientMsg('{"t":"logcatOpen","filter":{"pkg":"com.a.b","level":"W","text":"x","z":1}}'),
      { t: "logcatOpen", filter: { pkg: "com.a.b", level: "W", text: "x" } });
    assert.deepEqual(parseClientMsg('{"t":"logcatFilter","filter":{"pkg":null,"level":"V","text":""}}'),
      { t: "logcatFilter", filter: { pkg: null, level: "V", text: "" } });
    assert.equal(parseClientMsg('{"t":"logcatOpen","filter":{"pkg":"../x","level":"V","text":""}}'), null);
    assert.equal(parseClientMsg('{"t":"logcatOpen","filter":{"pkg":null,"level":"Q","text":""}}'), null);
  });
  test("parseClientMsg：logcatClose、logcatApps", () => {
    assert.deepEqual(parseClientMsg('{"t":"logcatClose"}'), { t: "logcatClose" });
    assert.deepEqual(parseClientMsg('{"t":"logcatApps","rid":3}'), { t: "logcatApps", rid: 3 });
  });
  ```

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test shared/test/protocol.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑全部单测** Run: `npm test` Expected: PASS（`server.test.ts` 里 `gateway` 消息的 `level` 期望同步改成 3）。
- [ ] **Step 5: 提交** `git commit -m "protocol: Add logcat messages and raise the gateway level to 3"`

### Task 3: 网关的 logcat 管理（按设备一个进程，多订阅者）

**Files:**
- Create: `gateway/src/logcat.ts`
- Test: `gateway/test/logcat.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parseLogcatLine`、`matchLog`、`LogLine`、`LogFilter`；`gateway/src/adb.ts` 的 `AdbStream`、`AdbStreamHandlers`。
- Produces（`gateway/src/logcat.ts`）：

  ```ts
  export type LogcatDeps = {
    /** 起 adb -s <id> logcat -v threadtime -T 500（adb.stream）。 */
    stream(id: string, h: AdbStreamHandlers): AdbStream;
    /** adb -s <id> shell pidof <pkg>，没运行时返回 []。 */
    pidof(id: string, pkg: string): Promise<number[]>;
    batchMs?: number;      // 默认 100
    keep?: number;         // 默认 50000
    replay?: number;       // 默认 5000
    pidRefreshMs?: number; // 默认 3000
    restartMs?: number[];  // 默认 [2000, 5000]
    log?(s: string): void;
  };
  export type LogcatSub = { setFilter(f: LogFilter): void; close(): void };
  export function createLogcatHub(deps: LogcatDeps): {
    subscribe(id: string, f: LogFilter, onBatch: (lines: LogLine[], reset: boolean) => void): LogcatSub;
    /** 结束全部进程和定时器（网关退出时）。 */
    close(): void;
  };
  ```

  行为：
  - 同一个 `id` 的第一个订阅者起进程，最后一个 `close()` 后停进程、清定时器、丢掉这台设备的缓冲。
  - 进程输出按行切（保留未完的半行），`parseLogcatLine` 解析后给递增的 `n`，放进环形缓冲（超过 `keep` 丢最旧的）。
  - 每 `batchMs` 对每个订阅者：把这一窗口里匹配它过滤条件的新行合成一次 `onBatch(lines, false)`；没有就不调。
  - `subscribe` 和 `setFilter`：先解析 `pkg` 的 pid（`pidof`），再从缓冲里挑匹配的最近至多 `replay` 行调一次 `onBatch(lines, true)`（没有匹配也调，传空数组，好让页面清空）。
  - 订阅了 `pkg` 的：每 `pidRefreshMs` 重查 pid；看到 `tag === "ActivityManager"` 且 msg 匹配 `/^Start proc (\d+):([\w.]+)[/:]/` 的行，包名相同就立刻把这个 pid 加进去（取舍 3），这一行之后的同 pid 日志就能匹配上。
  - 进程退出而还有订阅者：按 `restartMs` 重启（取舍 6）。

- [ ] **Step 1: 写测试**（假 `stream`：记下启动次数，返回可手动推数据和退出的句柄；假 `pidof`；`batchMs: 10`）

  ```ts
  test("同一台设备两个订阅者只起一个进程，各收各的过滤结果", ...);
  test("最后一个订阅者 close 后进程结束；再订阅会重新起", ...);
  test("一行被切在两次 data 之间（含中文）也能完整解析", ...);
  test("10000 行在一个合批窗口内只回调一次", ...);
  test("subscribe / setFilter 先用 reset 回放缓冲里匹配的最近行（至多 replay 行）", ...);
  test("缓冲超过 keep 丢最旧的", ...);
  test("按包名过滤：Start proc 日志里的新 pid 立刻生效，不等重查", ...);
  test("按包名过滤：定时重查 pidof 的结果会替换 pid 集合", ...);
  test("进程意外退出且还有订阅者：restartMs 后重启；订阅者都走了就不再重启", ...);
  ```

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test gateway/test/logcat.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试** 同上 Expected: PASS。
- [ ] **Step 5: 提交** `git commit -m "gateway: Run one logcat per device and fan filtered batches out to pages"`

### Task 4: 网关接入（server.ts / main.ts）

**Files:**
- Modify: `gateway/src/server.ts`、`gateway/src/main.ts`
- Test: `gateway/test/server.test.ts`

**Interfaces:**
- Consumes: Task 2 的消息；Task 3 的 `createLogcatHub`；`webviews.ts` 的 `FOREGROUND_CMD`（改成导出）和 `parseResumedPkg`。
- Produces：
  - `server.ts` 的 options 新增可选 `logcat?: ReturnType<typeof createLogcatHub>` 和 `apps?(id: string): Promise<{ foreground: string | null; apps: string[] }>`（没有时 `logcatOpen` 回 `error`「网关不支持日志」）。
  - 每个连接最多一个订阅：
    - `logcatOpen`：记下过滤条件；有会话就 `subscribe(session.id, …)`，回调里发 `{ t: "logcat", lines, reset }`（发送缓冲超过 1 MiB 时按取舍 7 计数、下一批带 `dropped`）。
    - `logcatFilter`：`setFilter`；`logcatClose` 和连接关闭：`close()`。
    - 这个连接接上另一台设备时：关掉旧订阅，按原过滤条件订阅新设备（spec「切换设备」）。
    - `logcatApps`：回 `{ t: "logcatApps", rid, foreground, apps }`，失败时 `foreground: null, apps: []`。
  - `main.ts`：用 `adb.stream(["-s", id, "logcat", "-v", "threadtime", "-T", "500"], h)` 和 `adb.device(id)(["shell", "pidof", pkg])`（返回码非零视为 `[]`）建 hub；`apps` 用 `FOREGROUND_CMD` 和 `ps -A -o USER,NAME`（取舍 4）；网关退出时 `hub.close()`。

- [ ] **Step 1: 写测试**（假 hub：记录 subscribe / setFilter / close 调用，并能手动触发 onBatch）

  ```ts
  test("logcatOpen 订阅当前设备，批次以 logcat 消息发给这个页面", ...);
  test("logcatFilter 改过滤条件；logcatClose 和断开连接都会 close 订阅", ...);
  test("面板开着时切到另一台设备：旧订阅 close，用原条件订阅新设备", ...);
  test("logcatApps 回前台 App 和运行中的 App", ...);
  test("gateway 消息的 level 是 3", ...);
  ```

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test gateway/test/server.test.ts` Expected: FAIL（新加的几条）。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑全部单测** Run: `npm test` Expected: PASS。
- [ ] **Step 5: 提交** `git commit -m "gateway: Stream logcat to pages that open the log panel"`

### Task 5: host 转发

**Files:**
- Modify: `host/src/connection.ts`、`host/src/main.ts`

**Interfaces:**
- Consumes: Task 2 的消息。
- Produces：
  - `connection.ts`：收到 `logcat` 调 `opts.onLogcat?.(m.lines, m.reset, m.dropped ?? 0)`；`logcatApps` 走现有的 `request` / rid 回复机制（同 `stopAvd`）。
  - `main.ts`：
    - `player.hostEvent("emu.logcat", { lines, reset, dropped })`；
    - `host.call` 新增 `emu.logcatOpen`、`emu.logcatFilter`（参数 `{ filter }`）、`emu.logcatClose`、`emu.logcatApps`（返回 `{ foreground, apps }`，超时或旧网关返回 `{ foreground: null, apps: [] }`）；
    - `emu.status` 里加 `logcat: boolean`（网关报的 level ≥ 3，常量 `LOGCAT_LEVEL = 3` 写在 `AVD_STOP_LEVEL` 旁边）。
  - 网关连接断开再连上时，页面若开着面板，由 UI 重新发 `emu.logcatOpen`（Task 6）。

- [ ] **Step 1: 构建确认** Run: `bun run build:host` Expected: 通过（host 没有单测，逻辑放在 Task 6 的纯函数里测）。
- [ ] **Step 2: 提交** `git commit -m "host: Relay logcat messages between the page and the gateway"`

### Task 6: 页面（日志面板）

**Files:**
- Create: `ui/log-store.ts`（纯函数）
- Modify: `ui/App.tsx`
- Test: `shared/test/log-store.test.ts`

**Interfaces:**
- Consumes: Task 1 的类型；Task 5 的 host 事件和调用。
- Produces：
  - `ui/log-store.ts`：
    - `export const MAX_LINES = 20000`
    - `export type LogRow = LogLine | { n: number; skipped: number }`（`skipped` 是「省略了 N 行」那一行，`n` 取负数自减，避免和网关序号撞）
    - `export function applyBatch(rows: readonly LogRow[], batch: { lines: LogLine[]; reset: boolean; dropped: number }): LogRow[]`：reset 时从空开始；`dropped > 0` 先插一行 skipped；超过 `MAX_LINES` 丢最前面的。
    - `export function levelColor(l: LogLevel): "muted" | "text" | "warn" | "danger"`（V、D → muted；I → text；W → warn；E、F → danger，对应 `App.tsx` 的 `C` 颜色键）
  - `App.tsx`：
    - 工具栏在「H5 控制台」开关旁加「日志」开关（新图标 `logs`，lucide 的 `scroll-text` 路径），只在 `emu.status` 的 `logcat` 为 true 时显示。
    - 右侧面板：`h5Open()` 和新的 `logOpen()` 任一为真就显示；两个都开时顶部是「H5 调试 / 日志」标签页（`sideTab` 信号，打开哪个就切到哪个）。H5 控制台自动打开时，如果日志面板开着，只打开不切换标签页。
    - 日志面板顶部：包名 `Select`（「全部 App」+ `emu.logcatApps` 的结果，默认前台 App；打开下拉时再查一次）、级别 `Select`（V/D/I/W/E/F，默认 V）、搜索 `Input`（输入停 300ms 后才发 `emu.logcatFilter`）、暂停、清空、跟随三个按钮。
    - 列表：`List` 渲染行，等宽字体，`时间 pid-tid 级别 tag: 内容`，级别列和 tag 按 `levelColor` 上色，长内容换行；skipped 行显示「省略了 N 行」。跟随时有新行 `scrollToEnd`；`onScroll` 发现离底部超过 40pt 就关掉跟随。
    - 暂停时收到的批次先用 `applyBatch` 攒在另一个数组里，恢复时并入。
    - 面板打开时发 `emu.logcatOpen`，关闭、切走页面时发 `emu.logcatClose`；网关重连（`emu.status` 的 state 回到 connected）时若开着就重发 `emu.logcatOpen`。

- [ ] **Step 1: 写测试**

  ```ts
  test("applyBatch：reset 清空后放新行，否则追加", ...);
  test("applyBatch：超过 MAX_LINES 丢最前面的", () => {
    const rows = applyBatch([], { lines: lines(20005), reset: false, dropped: 0 });
    assert.equal(rows.length, 20000);
    assert.equal((rows[0] as LogLine).n, 5);
  });
  test("applyBatch：dropped 时先插一行「省略了 N 行」", ...);
  test("levelColor：W 是 warn，E 和 F 是 danger，V 和 D 是 muted", ...);
  ```

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test shared/test/log-store.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现** `log-store.ts` 和 `App.tsx` 的改动。
- [ ] **Step 4: 跑测试和构建** Run: `npm test`、`bun run build:host`、`bun run build:ui` Expected: 全部通过。
- [ ] **Step 5: 提交** `git commit -m "ui: Add a log panel next to the H5 console"`

### Task 7: 文档与验收

**Files:**
- Modify: `CONTEXT.md`（新增 **Log panel** 条目：网关按设备一个 logcat 进程，有订阅才运行，过滤在网关做）

- [ ] **Step 1: 改 `CONTEXT.md`**。
- [ ] **Step 2: 页面验收**（`--phones --local`，三星 SM-G9910 和模拟器各一遍）：
  - 打开日志面板，先出现最近的日志；默认选中前台 App，只显示它的日志；改成「全部 App」、改级别、输入关键字都即时生效。
  - 在长桥 App 里操作，能看到它的日志；从多任务里划掉 App 再打开（pid 变了），新进程的日志接着出来。
  - 暂停后不再滚动，恢复后补上；清空；往上翻时自动停止跟随，点「跟随」回到底部。
  - 刷屏：`adb shell 'for i in $(seq 1 20000); do log -t DPFLOOD line$i; done'`，面板选「全部 App」、关键字 DPFLOOD。页面不卡，列表最多 2 万行。用 `top -l 2 -pid <网关 pid>` 和浏览器任务管理器看 CPU，记下数值写进 PR 描述（spec 成功标准 3）。
  - 关掉面板：`ps` 里不再有 `adb ... logcat`；两个页面同时开着面板，只有一个 logcat 进程。
  - 面板开着时在侧栏切换设备，日志跟着换。
  - 旧网关（`GATEWAY_LEVEL` 2，用已安装的 7300 网关的页面看）不显示「日志」按钮。
- [ ] **Step 3: 提交** `git commit -m "docs: Describe the log panel"`

## 后续

- WebMCP `droidpier_read_logcat`（PR 6）。
- logcat 重启后的重复行去重（取舍 6）。
- 按 tag 单独过滤、保存 / 导出日志（spec 没要求，等有人要）。
