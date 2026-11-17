# 真机支持 PR 7（手机重启）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 真机也能在页面上（和 WebMCP 里）重启：网关执行 `adb reboot`，等手机开机完成后自动重新连上，页面全程显示「重启中」，而不是「手机已断开」。

**Architecture:**
- `PhoneSession.reboot()` 调用新依赖 `deps.reboot()`（`adb -s <id> reboot`）；真机能力表 `reboot` 改为 true。
- 网关的重启流程（`server.ts` 的 `reboot`）不区分设备类型：
  1. 发「重启中」；
  2. 执行 `s.reboot()`；
  3. 用现有的 `rebootWait` 等 `sys.boot_completed`。手机掉线期间 `getprop` 失败，正好算作「已经下线过」；
  4. 等完以后，如果会话在重启期间关闭了（手机的情况），用 `opts.avd.use(id)` 重新建立会话，把原来那些页面接上去，再发重启结果。
  
  重启期间，会话关闭时给页面发 `rebooting` 而不是 `phone-closed`，并且暂停「选中的手机插回就重连」，免得在手机刚开机、scrcpy 还起不来的时候抢先重连失败。
- 页面和 host：重启的确认框、菜单项、结果提示按设备类型写「手机」或「模拟器」。

**Tech Stack:** 不新增依赖。Node 22 直接跑 TS，`node:test`；host 用 bun 构建，页面是 nsh TSX。

**Spec:** `docs/superpowers/specs/2026-11-13-real-device-design.md`：6.1 能力表的 `reboot`（「`adb reboot`，adb 卡住时不可用」）、6.3「按键区：……重启仍在，确认文案写『重启手机』」、6.5「`droidpier_reboot` 对真机改为 adb 重启，仍先弹确认」。

**前置：** PR 1–6 已合入（main `bd192e7`）。分支 `feat/phone-reboot` 从 main 切出。

## Global Constraints

- 注释、日志、界面文案用中文；只用可擦除 TS 语法；`gateway/`、`host/`、`shared/` 的 import 写 `.ts`，`ui/` 不写（`AGENTS.md`）。
- 不新增依赖，不改协议：`reboot`、`status: rebooting`、`ready`、`reboot { result }` 都是现有消息，`PROTOCOL_VERSION`、`GATEWAY_LEVEL` 都不变。
  - 旧页面也能用：它按能力表显示重启按钮，确认文案还是写「模拟器」，只是措辞不对。
  - 新页面连旧网关时，真机的 `caps.reboot` 是 false，不会显示重启按钮。
- 模拟器的重启行为不变（会话不关，也不重新连接）。
- 提交信息 `<area>: <英文祈使句>`。

## 本计划的取舍

1. **重启后自动重连，不靠「插回就重连」**：
   - 手机的 adbd 比系统早上线很多（开机动画阶段就是 `device` 状态了）。这时 scrcpy 起不来，而现有的 `reconnectPinned` 失败一次就不再试。
   - 所以重启期间暂停它，由重启流程在 `sys.boot_completed` 变成 1 之后自己调用 `use(id)` 重连。
   - 重连失败时，发 `reboot { result: "failed", error }`，然后恢复 `reconnectPinned`。之后手机列表再变化时，还会按原来的方式重试。
2. **等开机的上限沿用 120 秒**（`rebootWait` 的 `maxMs`）。返回 `adb-down` 时不重连，发 `reboot { result: "adb-down" }`，同样恢复「插回就重连」。页面提示按设备类型写：手机写「手机两分钟内没开机完成：开机后重新插拔手机」。
3. **锁屏**：手机开机后通常停在锁屏，scrcpy 照样出画面，用户可以在页面上输入密码。结果提示加一句「设了锁屏密码的话在页面上解锁」。
4. **重启期间页面的状态**：重启开始时发 `status: rebooting`，会话关闭时仍是 `rebooting`（不发 `phone-closed`）。重连成功后，attach 会发 `ready`，页面回到「已连接」。host 在 `rebooting` 期间本来就保留 `deviceId`（`host/src/main.ts` 的 `s !== "connected" && s !== "rebooting"`）。
5. **日志面板和 H5**：重启时 `dropDebug` 已经清掉了 H5 转发。日志面板的 logcat 进程会意外退出、按退避重启；重连后 `attach` 会按原来的过滤条件重新订阅。这两处都不用改，只在验收时确认。

## Review Focus

1. **手机在开机过程中先以 `device` 状态出现**（手机列表变化）：不能抢先重连，也不能发「重新连接失败」。→ Task 2 测试「重启期间手机列表变化不触发重连」。
2. **重启期间新开的页面**：应该看到「重启中」，或者在重连后被接上，而不是被接到模拟器上。→ Task 2 测试。
3. **重连失败**：页面收到 `reboot failed`，而且之后手机列表再变化时能按老办法连上，不能一直卡在「重启中」。→ Task 2 测试。
4. **两分钟没开机完成**（`adb-down`）：页面要有明确提示，状态不能停在「重启中」。→ Task 2 测试。
5. **模拟器重启**：会话不关，行为和以前完全一样。→ 现有测试保持通过。

---

### Task 1: 手机会话支持重启

**Files:**
- Modify: `gateway/src/phone-session.ts`、`gateway/src/main.ts`（`phoneDeps` 加 `reboot`）
- Test: `gateway/test/phone-session.test.ts`

**Interfaces:**
- Produces：
  - `PhoneDeps` 新增 `reboot(): Promise<void>`（`main.ts`：`adb.device(id)(["reboot"]).then(() => {})`）。
  - `PHONE_CAPS.reboot = true`。
  - `session.reboot()` 调用 `deps.reboot()`，不在这里关会话：会话要等手机断开、scrcpy 的连接结束时，由现有的关闭路径关掉。

- [ ] **Step 1: 写测试**（按 `phone-session.test.ts` 现有的假依赖写法）：
  - `connectPhone` 得到的会话 `caps.reboot` 为 true；
  - `reboot()` 调用一次 `deps.reboot`，调用后会话还没关（`onClosed` 没有触发）；
  - `deps.reboot` 抛错时，`reboot()` 把错误原样抛出。
- [ ] **Step 2: 跑测试，确认失败** Run: `node --test gateway/test/phone-session.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试** 同上 Expected: PASS。
- [ ] **Step 5: 提交** `git commit -m "gateway: Reboot a phone with adb reboot"`

### Task 2: 网关的重启流程在会话关闭后重新连上

**Files:**
- Modify: `gateway/src/server.ts`（`reboot`、`watch` 里的 `onClosed`、`reconnectPinned`）
- Test: `gateway/test/server.test.ts`（用现有的 `phoneSetup`）

**Interfaces:**
- Consumes：Task 1 的 `caps.reboot`；现有的 `opts.rebootWait`、`opts.avd.use`、`pinned`、`reconnectPinned`。
- Produces（行为）：
  - 重启开始时，记下当时接在这个会话上的连接（`waiting`）。
  - 会话在重启期间关闭时，这些连接 detach，并收到 `status: rebooting`。
  - `rebooting` 期间，`reconnectPinned` 对这台设备不做任何事。
  - `rebootWait` 返回 `done`，而且会话已经关闭时：调用 `opts.avd.use(id)`。成功就把 `waiting` 里还开着、而且没有接到别的会话的连接接上去（attach 会发 `ready`），然后发 `reboot { result: "done" }`；失败就发 `reboot { result: "failed", error }`。
  - 不管哪种结果，都会清掉 `rebooting`，然后调用一次 `reconnectPinned()`，让失败或 `adb-down` 的情况回到老办法。
  - 会话没有关闭（模拟器）：维持现在的行为，即发 `status: connected` 和 `reboot` 结果。

- [ ] **Step 1: 写测试**（`gateway/test/server.test.ts`，复用 `phoneSetup`，给它的 `setup` 加上 `rebootWait` 选项。假手机的 `reboot` 要记下调用，并在测试里用 `phone.fireClosed()` 模拟断开）：
  - 「真机重启：会话关闭时页面看到 rebooting，开机完成后重新连上并收到 done」：发 `{ t: "reboot" }`。断言：
    - 收到 `status: rebooting`；
    - `fireClosed()` 之后不出现 `phone-closed`；
    - `rebootWait` 放行后，`fa.ops.use` 被调用了一次，参数是手机 id；
    - 收到新的 `ready`（`kind: "phone"`）和 `reboot { result: "done" }`。
  - 「重启期间手机列表变化不触发重连」：`fireClosed()` 之后，`p.set([PHONE_OK])`（手机开机中以 `device` 状态出现）。断言在 `rebootWait` 放行前，`fa.ops.use` 一次都没被调用，也没有 `error` 消息。
  - 「重启后重连失败：发 failed，之后手机列表变化时按老办法连上」：第一次 `use` 抛错。断言：
    - 收到 `reboot { result: "failed" }`；
    - 再 `p.set` 一次后，`use` 又被调用，并且收到 `ready`。
  - 「两分钟没开机完成：发 adb-down，不重连」：`rebootWait` 返回 `adb-down`。断言收到 `reboot { result: "adb-down" }`，期间没有调用 `use`。
  - 现有的模拟器重启测试不改，要保持通过（Review Focus 5）。
- [ ] **Step 2: 跑测试，确认失败** Run: `node --test gateway/test/server.test.ts` Expected: 新测试 FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑测试** 同上 Expected: PASS；`npm test` 全绿。
- [ ] **Step 5: 提交** `git commit -m "gateway: Reconnect a phone after it reboots"`

### Task 3: 页面和 host 的文案

**Files:**
- Modify: `ui/App.tsx`（菜单项、确认框）、`host/src/main.ts`（重启结果提示、`rebooting` 期间的工具提示）

**Interfaces:**
- Consumes：页面现有的 `kind()` 信号；host 现有的 `kind` 变量。

- [ ] **Step 1: 改文案**（不改逻辑，按 `kind` 选文案）：
  - 菜单项：模拟器「重启模拟器系统」，手机「重启手机」。
  - 确认框：
    - 标题：模拟器「重启模拟器系统？」，手机「重启手机？」；
    - 正文（手机）：「手机会重启，正在运行的 App 和未保存的内容会丢失。开机后自动重新连接，大约 1 分钟。」；
    - `accessibilityLabel` 跟着改。
  - 重启结果提示（`onReboot`）：
    - 手机 done：「手机已重启。设了锁屏密码的话，在画面上解锁」；
    - 手机 adb-down：「手机两分钟内没开机完成：开机后重新插拔手机」；
    - failed 的文案不分设备类型。
  - `rebooting` 期间工具返回的提示，从「模拟器正在重启…」改成按设备类型写。
- [ ] **Step 2: 检查** `npm run build:ui` 通过；`nsh check ui` 仍是 main 上原有的 8 个错误，没有新增。
- [ ] **Step 3: 提交** `git commit -m "ui: Say phone when rebooting a phone"`

### Task 4: 验收

- [ ] **Step 1: 真机**（三星 SM-G9910，`--phones --local`）：
  - 页面上点「重启手机」，确认框文案对；
  - 页面先显示「重启中」，中途不出现「手机已断开」；
  - 开机后自动回到画面，提示「手机已重启……」，锁屏可以在页面上解锁；
  - 重启前打开的日志面板，重连后还有新日志；
  - 记下从点击到回到画面的时间，写进 PR 描述。
- [ ] **Step 2: WebMCP**：用 PR 6 的方法（`initScript` 注入假的 `modelContext`）在真机上调用 `droidpier_reboot`，确认会先弹确认框，允许后重启流程和上面一样。
- [ ] **Step 3: 模拟器回归**：在页面上重启 Pixel 6 Pro，行为和 main 上一致（画面不断，提示「模拟器已重启」）。
- [ ] **Step 4: 提交** `git commit -m "docs: Plan phone reboot"`（本计划文档）

## 后续

- 去掉 `--phones`，在 README 和文档站写上真机。
