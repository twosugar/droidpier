# 真机支持 PR 9（只用真机时不弹安装引导）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 装了 adb、还没有模拟器设备的用户（只用真机），打开页面时不再自动弹出要求装模拟器的环境检查卡片。设备列表和主区的空态同时提示「插上手机」和「新建模拟器」。没装 adb 时，「真机」分组改为提示先装 platform-tools。

**Architecture:**
- 全部在页面里完成，不改协议，也不改网关。
  - 页面已经收到 `env.missing`，从中就能分出必需项（`platform-tools`）和模拟器项（`emulator`、`system-image`、`avd`），所以 `EnvReport` 不加字段，`GATEWAY_LEVEL` 也不变。
  - spec 6.2 写的是「`env.ok` 拆成两部分」，这里按「由页面推出来」实现，`env.ok` 的含义不变。网关终端日志仍会列出全部缺项。
- `ui/setup-card.ts` 新增纯函数 `setupNeeded(env, avdCount)`，决定卡片该不该自动出现。`setupCardShown` 多接收两个输入：`needed`（自动出现）和 `wanted`（用户主动要看）。
- 文案改动在 `ui/App.tsx` 的三处空态，文档改 `phones.md` 和 `first-run.md`（英文 + 12 种译文）。

> **执行时的修订**：验收发现，没装模拟器程序时设备列表是空的（列表来自 `emulator -list-avds`），有 AVD 的模拟器用户会因此看不到自动弹出的卡片。所以 `EnvReport` 新增了可选字段 `avds`（`checkEnv` 在 AVD 目录里数到的设备数），`setupNeeded` 取设备列表和它的较大值。这是只加不改的字段，`GATEWAY_LEVEL` 不变；旧网关没有这个字段时，退回只看设备列表。

**Tech Stack:** 不新增依赖。`node:test`；页面是 nsh TSX；文档站 Astro Starlight（本机用 `bun --bun run build`，原因见 PR 8：本机 Node 22.21.1 低于 Astro 要求的 22.22）。

**Spec:** `docs/superpowers/specs/2026-11-13-real-device-design.md` 6.2：「SDK 检查：`env.ok` 拆成两部分，『adb 可用』是必需，『模拟器 / 系统镜像 / AVD』是可选。只有真机时不弹安装引导，设备列表空态改成同时提示『插上手机并打开 USB 调试』和『创建模拟器』。」目标 5：「只有真机、没装模拟器的用户，不会被『先安装模拟器』挡住：真机只需要 platform-tools（adb）。」

**前置：** main `ad7cedd`。分支 `feat/phone-only-setup` 从 main 切出。

## Global Constraints

- 界面文案用中文，注释用中文；只用可擦除 TS 语法；`ui/` 的 import 不写 `.ts`。
- 不改协议、不改网关：`PROTOCOL_VERSION`、`GATEWAY_LEVEL`、`EnvReport` 都不变。
- 模拟器用户的行为不能退步：只要本机有模拟器设备（AVD 列表非空），缺任何项时卡片仍然自动出现，和现在一样。
- 文档只写验收时实际跑通过的行为；12 种译文同步更新，`sourceHash` 刷新到最新（`site/scripts/translation-status.ts`）。
- 检查：`npm test`；`nsh check ui` 的基线是 8 个错误；`npm run build:ui`；文档站 `bun --bun run build` 和 `node --test tests/*.test.ts`。
- 提交信息 `<area>: <英文祈使句>`，文档站用 `docs(site): ...`。

## 本计划的取舍

1. **卡片何时自动出现**，由 `setupNeeded(env, avdCount)` 决定，下列任一条件成立就返回 true：
   - `env.error` 有值（检查本身出错）；
   - `missing` 里有 `platform-tools`（没有 adb，真机和模拟器都用不了）；
   - `avdCount > 0` 且 `missing` 非空。本机已有模拟器设备，说明是模拟器用户，比如系统镜像被删了，要照常提示。
   - 其余情况（有 adb、没有任何 AVD、只缺模拟器相关项）返回 false：卡片不自动出现。
   - 不按「当前有没有插手机」判断：插拔手机会让卡片反复出现、消失。
2. **怎么找回卡片**：卡片不自动出现、但还缺东西时，设备列表的「本机还没有模拟器设备」下面，除了「创建设备」，再加一个按钮「安装模拟器（缺 N 项）」。点了设 `wanted = true`，卡片出现；在卡片上点「收起」后，`wanted` 归零。
   - 「创建设备」按钮的行为不变。
3. **空态文案**：
   - 主区：没有选中设备且 AVD 列表为空时，现在写「本机还没有模拟器设备，先新建一台」，改为「插上手机并打开 USB 调试，或新建一台模拟器」。
   - 「真机」分组：列表为空时，如果 `missing` 里有 `platform-tools`，写「先在环境检查里安装 platform-tools（adb），才能看到手机」；否则保持「插上手机，并在手机上打开 USB 调试」。
4. **网关终端日志不改**：「打开页面完成安装」仍列出全部缺项。只用真机的用户在 `droidpier logs` 里会看到模拟器缺项，这是事实，不是错误。spec 只要求页面不弹引导。

## Review Focus

1. **系统镜像被删的模拟器用户**（AVD 存在但镜像缺失）：卡片照常自动出现。→ Task 1 测试 `setupNeeded` 的 `avdCount > 0` 分支。
2. **全新的 Mac**（什么都没装）：缺 platform-tools，卡片照常自动出现，「真机」分组提示先装 adb。→ Task 1 测试；Task 3 验收。
3. **只装了 platform-tools 的用户**：打开页面不弹卡片；点「安装模拟器（缺 N 项）」后卡片出现，收起后不再自动出现，刷新页面后也不出现。→ Task 1 测试；Task 3 验收。
4. **安装进行中或失败**：不管 `needed` 是什么，进行中一直显示，失败后显示，和现在一样。→ Task 1 保留现有测试并补一条 `needed=false` 时安装失败仍显示。
5. **旧网关**：`env` 为 null 时行为不变（不显示卡片，「创建设备」按钮禁用）。→ Task 2 检查 `showSetup` 对 null 的处理没变。

---

### Task 1: 判断卡片何时自动出现

**Files:**
- Modify: `ui/setup-card.ts`
- Test: `shared/test/setup-card.test.ts`

**Interfaces:**
- Produces：
  - `setupNeeded(env: Pick<EnvReport, "missing" | "error">, avdCount: number): boolean`
  - `setupCardShown(s: { ok; needed: boolean; wanted: boolean; busy; failed; hasInstalls; dismissed }): boolean`。规则：
    - `busy` → true；
    - `dismissed` → false；
    - `failed || hasInstalls` → true；
    - `!ok && (needed || wanted)` → true；
    - 否则 false。
  - `missingEmulatorItems(env): number`：`missing` 中 id 不是 `platform-tools` 的项数，用于按钮上的「缺 N 项」。

- [ ] **Step 1: 写测试**（`shared/test/setup-card.test.ts`）：
  - 现有测试的 `base` 加 `needed: true, wanted: false`，断言不变。
  - `setupNeeded`：
    - 缺 platform-tools 且没有 AVD → true；
    - 只缺 emulator、system-image、avd，没有 AVD → false；
    - 同样缺这三项，但有 1 台 AVD → true；
    - `error` 有值 → true；
    - `missing` 为空 → false。
  - `setupCardShown`：
    - `{ ok: false, needed: false }` → false；
    - 再加 `wanted: true` → true；
    - `wanted: true, dismissed: true` → false；
    - `needed: false, failed: true, hasInstalls: true` → true。
  - `missingEmulatorItems`：缺 platform-tools、emulator、avd 三项时返回 2。
- [ ] **Step 2: 跑测试，确认失败** Run: `node --test shared/test/setup-card.test.ts` Expected: FAIL（`setupNeeded` 不存在）。
- [ ] **Step 3: 实现**（按上面的接口）。
- [ ] **Step 4: 跑测试** 同上 Expected: PASS。
- [ ] **Step 5: 提交** `git commit -m "ui: Decide when the setup card should show by itself"`

### Task 2: 页面接上新规则和空态文案

**Files:**
- Modify: `ui/App.tsx`（`showSetup`、`setupDismissed` 旁边新增 `setupWanted`、`emptyText`、侧栏 AVD 空态、「真机」分组空态）

**Interfaces:**
- Consumes：Task 1 的 `setupNeeded`、`setupCardShown`、`missingEmulatorItems`。

- [ ] **Step 1: 实现**：
  - `showSetup`：传入 `needed: setupNeeded(e, (avds() ?? []).length)` 和 `wanted: setupWanted()`。`avds()` 为 null（还没读到列表）时按 0 处理。
  - 卡片的 `onDismiss` 同时把 `setupWanted` 设为 false；`startInstall` 照旧把 `setupDismissed` 清零。
  - 侧栏 AVD 空态：当 `env()` 存在、`!env().ok`、而且 `showSetup()` 为 null 时，在「创建设备」旁边加按钮 `安装模拟器（缺 ${missingEmulatorItems(env())} 项）`。点击后 `setupDismissed.set(false)`、`setupWanted.set(true)`。
  - `emptyText` 和「真机」分组的空态文案按「取舍 3」改。
- [ ] **Step 2: 检查** Run: `npm run build:ui && ~/.local/bin/nsh check ui` Expected: 构建通过，`nsh check ui` 仍是 8 个错误。`npm test` 全绿。
- [ ] **Step 3: 提交** `git commit -m "ui: Don't ask phone-only users to install the emulator"`

### Task 3: 验收

- [ ] **Step 1: 只装了 platform-tools**：
  - 准备：建临时 SDK 目录，只放 `platform-tools`（`ln -s ~/Library/Android/sdk/platform-tools <tmp>/platform-tools`）；临时 AVD 目录为空（`ANDROID_AVD_HOME=<空目录>`，用前先核对网关读的是这个变量）。
  - 启动：`ANDROID_HOME=<tmp> ANDROID_AVD_HOME=<空目录> node gateway/src/main.ts --port 7306 --no-open --no-auto-update --local`。
  - 预期：
    - 打开页面，卡片不出现；
    - 主区写「插上手机并打开 USB 调试，或新建一台模拟器」；
    - 侧栏有「安装模拟器（缺 N 项）」，点它卡片出现，收起后消失，刷新页面后不再出现；
    - 三星 SM-G9910 在「真机」分组里，能切过去，有画面。
- [ ] **Step 2: 全新的 Mac**：`ANDROID_HOME=<空目录>` 启动。预期卡片自动出现，「真机」分组写「先在环境检查里安装 platform-tools（adb），才能看到手机」。
- [ ] **Step 3: 模拟器用户回归**：用真实 SDK 启动，卡片不出现（环境齐全），Pixel 6 Pro 照常启动。然后用 `ANDROID_HOME=<tmp>`（只有 platform-tools）和真实 AVD 目录启动：预期卡片自动出现，因为有 AVD 但缺 emulator。
- [ ] **Step 4: 截图** 记录 Step 1 的侧栏和主区，写进 PR 描述。

### Task 4: 文档（英文 + 12 种译文）

**Files:**
- Modify: `site/src/content/docs/docs/guides/phones.md`（「Only phones, no emulator」一节）
- Modify: `site/src/content/docs/docs/getting-started/first-run.md`（第 2 步「The page shows the same list」那段后加一句）
- Modify: 12 种语言对应的两页，并刷新 `sourceHash`

- [ ] **Step 1: 改英文**，内容按 Task 3 实际看到的写：
  - `phones.md`：装好 `platform-tools`、还没有虚拟设备时，页面不弹环境检查；要用模拟器时，点设备列表里的「install the emulator」按钮。删掉原来「close the setup card」的说法。
  - `first-run.md`：「If `adb` is installed and you have no virtual device yet, the page does not show the list by itself, so you can use a phone right away; the device list has a button to show it.」
- [ ] **Step 2: 译文**：沿用 PR 8 的做法（每 3 种语言交给一个子代理，目录互不重叠，简报写明改哪段、`sourceHash` 的新值），完成后统一检查。
- [ ] **Step 3: 检查** Run: `cd site && node scripts/translation-status.ts && bun --bun run build && node --test tests/*.test.ts` Expected: `all translations current`，构建通过，测试全过。
- [ ] **Step 4: 提交** `git commit -m "docs: Say the setup check stays out of the way for phones"`，再提交 `docs(site): Translate the setup check change`，最后 `docs: Plan the phone-only setup`（本计划文档）。

## 后续

- 文档站加日志面板和 WebMCP 工具的页面。
- 日志面板长行的详情视图；`stopAvd` 回复没有处理；`adb.test.ts` 偶发超时。
- PR 8 推迟的小问题：
  - 不带参数的 `droidpier start` 会留下旧的 `--phones`；
  - `ui/App.tsx:1551` 有过时注释；
  - adb 恢复时没有日志。
- 首页第 7 张功能卡片怎么摆，等拉罐决定。
