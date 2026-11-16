# 真机支持 PR 2（设备列表带真机）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 `--phones` 启动网关时，侧栏多出「真机」分组，实时列出 USB 连着的手机及其状态（可用 / 未授权 / 离线），插拔即时更新；这一版只能看，不能连。不带 `--phones` 时一切和现在一样。

**Architecture:**
- 网关新增 adb 长进程接口 `adb.stream`，用它跑 `adb track-devices -l`，由新模块 `phones.ts` 解析成真机列表（排除 `emulator-*`），并为可用的手机补厂商、型号、Android 版本。
- 协议只加不改：新增网关主动推送的 `{ t: "phones", list }`；旧页面忽略它。
- host 把它转成 `emu.phones` 事件，页面在侧栏加「真机」分组；只有收到过 `phones` 消息才显示这个分组。

**Tech Stack:** 不新增依赖。Node 22 直接跑 TS，`node:test`；页面是 nsh TSX。

**Spec:** `docs/superpowers/specs/2026-11-13-real-device-design.md`，第 2 节第 1 条、6.2（adb、设备发现、自动接管）、6.3（侧栏、状态文案）、6.4、7 节的 PR 2

**前置：** PR 1（twosugar/droidpier#25）已合入；在 `feat/phone-device-list`（基于 `1032fbc`）上做。行号以 `1032fbc` 为准，以符号名为准找位置。

## Global Constraints

- 注释、日志、界面文案用中文；只用可擦除 TS 语法；`gateway/`、`host/`、`shared/` 的 import 写 `.ts`，`ui/` 不写。
- 不新增依赖。
- 协议只加不改，`PROTOCOL_VERSION` 保持 `1`；新增的消息和字段都是可选的。
- `--phones` 不写进 `USAGE`（和 `--allow-origin` 一样是隐藏参数），注释写明「真机支持做完前的开关」。不带它时：不启动 `track-devices`、不发 `phones` 消息、页面不显示「真机」分组。
- 真机这一版**不能连**：不推 scrcpy、不建 forward、不点亮屏幕（spec 6.2「不自动连」）。
- 每条短 adb 调用仍走 `adb.device(id)` 的队列和 5 秒超时；只有 `track-devices` 走 `adb.stream`。
- 页面空闲时不能有持续开销：`track-devices` 只在有变化时输出，网关不轮询。
- 提交信息 `<area>: <英文祈使句>`，area 用 `gateway` / `protocol` / `ui` / `docs`；PR 描述写 `## Protocol`。

## 本计划的取舍（写计划时定的）

- **adb 从 SDK 外找、只有真机时不弹安装引导，不放在这个 PR**。原因：后台服务（`droidpier start`）的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`（`gateway/src/service.ts:14`），spec 6.2 说的「退到 PATH 上的 adb」在后台模式下找不到 Homebrew 的 `/opt/homebrew/bin/adb`，需要单独设计查找顺序；它和「列出真机」是两件事，按「一个 PR 只做一件事」拆成后续 PR（见文末）。这一版沿用 SDK 里的 adb。
- **状态只分三种**：`device` → 可用；`unauthorized` → 未授权；其他（`offline`、`recovery`、`sideload`、`no permissions` 等）→ 离线。
- **型号和版本**：手机变成 `device` 时用一条 `adb -s <id> shell getprop …` 取厂商、型号、Android 版本，按设备 id 缓存；取不到时用 `track-devices -l` 行里的 `model:`（下划线换成 `-`）。

## Review Focus

1. **`track-devices` 一次输出被拆成多段、或多段粘在一起**：长度前缀可能跨 `data` 事件。→ Task 2 测试「分两次喂一帧」「一次喂两帧」。
2. **adb server 重启或被杀**（用户跑了 `adb kill-server`）：`track-devices` 进程退出，真机列表要清空并在退避后重连，不能一直显示旧状态。→ Task 2 测试「流结束后列表清空、按退避重启」。
3. **手机从未授权变成可用**：同一个 id 状态变化时要补查型号版本，查的过程中不能把列表卡住。→ Task 2 测试。
4. **网关退出时留下 `adb track-devices` 孤儿进程**。→ Task 1 测试 `killAdbChildren` 会结束 `adb.stream` 起的进程；Task 3 在 `main.ts` 的清理里调用 `phones.stop()`。
5. **旧网关 + 新页面**：页面没收到 `phones` 消息时不显示「真机」分组，空态文案保持原样。→ Task 4 的纯函数测试。

---

### Task 1: adb 长进程接口

**Files:**
- Modify: `gateway/src/adb.ts`
- Test: `gateway/test/adb.test.ts`

**Interfaces:**
- Produces:
  - `export type AdbStream = { stop(): void }`
  - `export function streamAdb(bin: string, args: string[], h: { onData(chunk: string): void; onExit(code: number | null): void }): AdbStream`：用 `spawn` 起进程（stdin 忽略，stdout 按 utf8 交给 `onData`，stderr 丢弃），进程登记在现有的 `children` 集合里，退出时移除并回调 `onExit`；`stop()` 发 SIGTERM。
  - `createAdb()` 的返回值新增 `stream(args, h)`，等于 `streamAdb(adbBin(), args, h)`；`createAdb({ stream })` 可注入（测试用）。

- [ ] **Step 1: 写测试**

  沿用 `adb.test.ts` 里用 `writeFile` + `chmod` 造假可执行文件的做法：

  ```ts
  test("streamAdb 把输出按到达顺序交给 onData，进程结束时回调 onExit", async () => {
    // 假 adb：echo a; sleep 0.1; echo b
    // 断言收到的拼起来是 "a\nb\n"，onExit 收到 0
  });

  test("killAdbChildren 结束 streamAdb 起的长进程", async () => {
    // 假 adb：sleep 30；调用 killAdbChildren() 后 1 秒内 onExit 被调用
  });
  ```

- [ ] **Step 2: 跑测试，确认失败**

  Run: `node --test gateway/test/adb.test.ts`
  Expected: FAIL，`streamAdb` 没有导出。

- [ ] **Step 3: 实现**（按 Interfaces）

- [ ] **Step 4: 跑全部单测**

  Run: `npm test`
  Expected: 全部 PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add gateway/src/adb.ts gateway/test/adb.test.ts
  git commit -m "gateway: Run long-lived adb commands alongside the queued ones"
  ```

### Task 2: 真机列表（解析 + 跟踪）

**Files:**
- Create: `gateway/src/phones.ts`
- Modify: `shared/protocol.ts`（新增 `PhoneInfo` 类型）
- Test: `gateway/test/phones.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `stream(args, h)`；PR 1 的 `adb.device(id)`。
- Produces:
  - `shared/protocol.ts`：

    ```ts
    /** 一台 USB / 无线连着的真机。state：device 可用，unauthorized 没在手机上允许 USB 调试，offline 其他（离线、recovery 等）。 */
    export type PhoneInfo = { id: string; state: "device" | "unauthorized" | "offline"; manufacturer?: string; model?: string; android?: string };
    ```

  - `gateway/src/phones.ts`：
    - `export function takeFrames(buf: string): { frames: string[]; rest: string }`：按 4 位 16 进制长度前缀切帧，剩下不够一帧的原样返回。
    - `export function parseDevices(payload: string): Array<{ id: string; state: PhoneInfo["state"]; trackModel?: string }>`：逐行解析，跳过 `emulator-` 开头的；`trackModel` 取 `model:` 字段并把 `_` 换成 `-`。
    - `export function createPhones(deps: { stream: …; exec: (id: string) => (args: string[]) => Promise<string>; sleep?: (ms: number) => Promise<void>; log?: (s: string) => void }): { start(): void; stop(): void; list(): PhoneInfo[]; onChange(cb: (list: PhoneInfo[]) => void): void }`
    - 重连退避：`[1000, 2000, 5000]` 毫秒，用到最后一个后保持 5000（我定的数值，注释写明）。

- [ ] **Step 1: 写测试**

  用真实输出做夹具（2026-11-13 本机 `adb track-devices -l` 与 `adb devices -l` 实测）：

  ```ts
  const LINE_EMU = "emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:3";
  const LINE_PHONE = "R5CR10WN52H            device 1-1.3 product:o1qzcx model:SM_G9910 device:o1q transport_id:6";
  const frame = (s: string) => s.length.toString(16).padStart(4, "0") + s;

  test("takeFrames：一帧分两次到达时先留着，凑齐再切", ...);   // 断言第一次 frames=[]，第二次 frames=[payload]
  test("takeFrames：两帧粘在一起时切成两帧", ...);
  test("parseDevices：跳过模拟器，真机取 id、状态和 model（下划线换成 -）", () => {
    assert.deepEqual(parseDevices(`${LINE_EMU}\n${LINE_PHONE}\n`), [{ id: "R5CR10WN52H", state: "device", trackModel: "SM-G9910" }]);
  });
  test("parseDevices：unauthorized 保留，recovery / offline 归为 offline", ...);
  test("createPhones：可用的手机补查厂商、型号、版本；未授权的不查", async () => {
    // 假 stream 推一帧（真机 device + 另一台 unauthorized）；假 exec 返回 "samsung\nSM-G9910\n12\n"
    // 断言 list() 为 [{ id: "R5CR10WN52H", state: "device", manufacturer: "samsung", model: "SM-G9910", android: "12" }, { id: "X", state: "unauthorized" }]
    // 断言 exec 只对 R5CR10WN52H 调用过一次，参数是 ["shell", "getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release"]
  });
  test("createPhones：未授权变成可用时补查，查询失败时用 track 行里的型号", ...);
  test("createPhones：同一台手机再次出现不重复查询（按 id 缓存）", ...);
  test("createPhones：流结束后列表清空并通知，按退避重启", async () => {
    // 假 sleep 记录等待时长；流 onExit 两次后断言 sleeps 为 [1000, 2000]，每次结束后 onChange 收到 []
  });
  test("createPhones：stop 之后流结束不再重启", ...);
  ```

- [ ] **Step 2: 跑测试，确认失败**

  Run: `node --test gateway/test/phones.test.ts`
  Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

  `onChange` 只在列表内容变化时回调（按 JSON 比较）。查型号时先用不带型号的条目发一次，查完再发一次，避免慢查询卡住列表。

- [ ] **Step 4: 跑全部单测**

  Run: `npm test`
  Expected: 全部 PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add gateway/src/phones.ts gateway/test/phones.test.ts shared/protocol.ts
  git commit -m "gateway: Track USB phones with adb track-devices"
  ```

### Task 3: `--phones` 开关与推送

**Files:**
- Modify: `gateway/src/cli.ts`（`CliOptions.phones`、解析 `--phones`）
- Modify: `shared/protocol.ts`（`ServerMsg` 新增 `{ t: "phones"; list: PhoneInfo[] }`）
- Modify: `gateway/src/server.ts`（`startServer` 新增可选 `phones`；hello 后发一次；变化时广播）
- Modify: `gateway/src/main.ts`（带 `--phones` 时 `createPhones` 并 `start()`；清理时 `stop()`）
- Test: `gateway/test/cli.test.ts`、`gateway/test/server.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `createPhones` 返回对象、`PhoneInfo`。
- Produces:
  - `CliOptions` 新增 `phones: boolean`，默认 `false`。
  - `startServer(opts)` 新增 `phones?: { list(): PhoneInfo[]; onChange(cb: (list: PhoneInfo[]) => void): void }`。
  - 页面收到的消息：`{ t: "phones"; list: PhoneInfo[] }`。注释写明「只有网关带 --phones 启动时才发；没收到过就当网关不支持真机」。

- [ ] **Step 1: 写测试**

  - `cli.test.ts`：`parseCli(["--phones"])` 的 `options.phones` 为 `true`；不带时为 `false`；`USAGE` 不含 `--phones`；`parseCli(["start", "--phones"])` 的 `args` 保留 `--phones`。
  - `server.test.ts`：
    - 「带 phones 时 hello 后收到一次 phones 列表」：注入 `{ list: () => [P], onChange }`，断言连接收到 `{ t: "phones", list: [P] }`，且在 `env` 之后。
    - 「phones 变化时广播给所有已 hello 的连接」。
    - 「不带 phones 时不发 phones 消息」：断言消息里没有 `t === "phones"`。

- [ ] **Step 2: 跑测试，确认失败**

  Run: `node --test gateway/test/cli.test.ts gateway/test/server.test.ts`
  Expected: FAIL。

- [ ] **Step 3: 实现**（按 Interfaces；`main.ts` 里 `phones` 对象的 `exec` 用 `adb.device`，`stream` 用 `adb.stream`）

- [ ] **Step 4: 跑全部单测**

  Run: `npm test`
  Expected: 全部 PASS。

- [ ] **Step 5: 真机冒烟**（手机插上并解锁）

  Run: `node gateway/src/main.ts --port 7306 --no-open --phones`，另开终端跑一个只发 hello、打印收到消息的小脚本。
  Expected: 收到 `phones`，里面有 `R5CR10WN52H`、`samsung`、`SM-G9910`、`12`；拔线后 1 秒内收到不含它的列表，插回后再出现；手机上点「撤销 USB 调试授权」后重插，状态变成 `unauthorized`。退出网关后 `pgrep -f "adb.*track-devices"` 没有本网关留下的进程。

- [ ] **Step 6: 提交**

  ```bash
  git add gateway/src/cli.ts gateway/src/server.ts gateway/src/main.ts shared/protocol.ts gateway/test/cli.test.ts gateway/test/server.test.ts
  git commit -m "gateway: Push the phone list to pages behind --phones"
  ```

### Task 4: 页面「真机」分组

**Files:**
- Modify: `host/src/connection.ts`（`onPhones` 回调，挨着 `onAvds`，:193）
- Modify: `host/src/main.ts`（缓存列表，`player.hostEvent("emu.phones", { list })`，挨着 `onAvds`，:217）
- Create: `ui/phones.ts`（纯函数）
- Modify: `ui/App.tsx`（侧栏 `设备` 列表下方，:1260-1275）
- Test: `shared/test/phones-ui.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `phones` 消息、`PhoneInfo`。
- Produces:
  - `ui/phones.ts`：
    - `phoneLabel(p: PhoneInfo): string`：有厂商和型号时 `"<厂商首字母大写> <型号>"`，只有型号时型号，都没有时 id。
    - `phoneStatus(p: PhoneInfo): string`：`device` →「已连接，暂不能操作」；`unauthorized` →「请在手机上允许 USB 调试」；`offline` →「离线，重新插拔试试」。
    - `phoneDetail(p: PhoneInfo): string`：版本号（和模拟器行右侧的「15」一致），不知道时空串。
    - `showPhones(list: PhoneInfo[] | null): boolean`：`null`（从没收到过）为 `false`，其他为 `true`。

- [ ] **Step 1: 写测试**

  ```ts
  test("phoneLabel：厂商首字母大写加型号", () => assert.equal(phoneLabel({ id: "R5CR10WN52H", state: "device", manufacturer: "samsung", model: "SM-G9910" }), "Samsung SM-G9910"));
  test("phoneLabel：没有型号时用设备 id", ...);
  test("phoneStatus：三种状态的文案", ...);       // 断言上面三句文案原文
  test("showPhones：没收到过列表时不显示分组；空列表也显示（提示插手机）", () => {
    assert.equal(showPhones(null), false);
    assert.equal(showPhones([]), true);
  });
  ```

- [ ] **Step 2: 跑测试，确认失败**

  Run: `node --test shared/test/phones-ui.test.ts`
  Expected: FAIL。

- [ ] **Step 3: 实现**

  - `App.tsx`：新增 `phones = signal<PhoneInfo[] | null>(null)`，`host.on("emu.phones", (p) => phones.set(p.list))`。`showPhones(phones())` 为真时，在模拟器列表下方加小标题「真机」和行；行沿用 `DeviceRow` 的样式（图标、两行文字、右侧 `phoneDetail`），但用不可点击的 `View`，`accessibilityLabel` 为 `"<phoneLabel>，<phoneStatus>"`；`unauthorized` / `offline` 的状态行用 `C.warn` 色。列表为空时显示「插上手机，并在手机上打开 USB 调试」。
  - 搜索框的过滤（`matchesAvd`）这一版不作用于真机。

- [ ] **Step 4: 跑全部单测并构建页面**

  Run: `npm test`
  Expected: 全部 PASS。

  Run: `bun run build:host && NSH=$(command -v nsh) bun run build:ui`
  Expected: 构建成功，生成 `.nsh/out/Droidpier`。

  前提：`build:ui` 要用支持 wasm32 的 LLVM clang（默认找 `/opt/homebrew/opt/llvm/bin`，可用 `LLVM_BIN` 指定）。
  2026-11-13 本机没装 LLVM（`/opt/homebrew/opt/llvm` 不存在，系统 clang 不带 wasm32），要先由用户决定是否
  `brew install llvm`；不装时 Step 4 只跑 `npm test` 和 `bun run build:host`，Step 5 无法做，在 PR 里如实写明页面未在本地构建。

- [ ] **Step 5: 页面验收**（需要 Chrome / Edge：内置浏览器窗格会被页面拒绝）

  Run: `node gateway/src/main.ts --port 7306 --no-open --phones --local`，用 Chrome 打开 `http://127.0.0.1:7306/app/`。
  Expected: 侧栏出现「真机」分组，显示「Samsung SM-G9910 / 已连接，暂不能操作 / 12」；拔线后该行消失、出现「插上手机…」提示；不带 `--phones` 重启后没有「真机」分组，其余界面与 main 一致。截图留证。

- [ ] **Step 6: 提交**

  ```bash
  git add host/src/connection.ts host/src/main.ts ui/phones.ts ui/App.tsx shared/test/phones-ui.test.ts
  git commit -m "ui: List USB phones in the sidebar"
  ```

### Task 5: 文档

**Files:**
- Modify: `CONTEXT.md`（Devices 下新增 **Phone** 词条）
- 设计文档的原型实测更正已在本分支（`docs/superpowers/specs/2026-11-13-real-device-design.md`）

- [ ] **Step 1: 更新 CONTEXT.md**

  ```markdown
  **Phone**:
  A real Android device that adb sees over USB or Wi-Fi, listed under 真机 in the sidebar. Its Device id is its adb
  serial. Shown only when the gateway runs with `--phones` until phone support is complete.
  _Avoid_: physical device, real device (in code), handset
  ```

- [ ] **Step 2: 提交并开 PR**

  ```bash
  git add CONTEXT.md docs/superpowers/specs/2026-11-13-real-device-design.md docs/superpowers/plans/2026-11-13-real-device-pr2-device-list.md
  git commit -m "docs: Name phones and record what the scrcpy prototype measured"
  ```

  PR 标题 `gateway: List USB phones behind --phones`，`## Protocol` 写：新增网关推送的 `phones` 消息和隐藏参数 `--phones`，`PROTOCOL_VERSION` 不变，旧页面忽略新消息。

## 后续

- **PR 2b**：adb 查找顺序（SDK → `/opt/homebrew/bin/adb` → PATH）和「只有真机时不弹安装引导」，设计时注意后台服务的 PATH。
- PR 3–6 按 spec 第 7 节，各写一份计划。
