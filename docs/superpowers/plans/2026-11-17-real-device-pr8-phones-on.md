# 真机支持 PR 8（真机默认开启 + 文档）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 去掉 `--phones` 开关，网关默认跟踪真机；README、`CONTEXT.md`、文档站（英文 + 12 种译文）写上真机。产品定位（首页标题、README 第一句）不变。

**Architecture:**
- 网关启动时总是创建 `createPhones` 并 `start()`。`--phones` 仍然接受（老用户的登录项里可能存着它），但不再有作用：解析时跳过，`droidpier start --phones` 也不把它写进后台服务参数。
- 默认开启后，没装 platform-tools 的新用户也会跑 `adb track-devices`，每 5 秒失败一次。`phones.ts` 改成只在一轮连续失败的第一次记日志，收到设备表后才重新计数。
- 文档：新增指南页 `docs/guides/phones`。设备、环境要求、排障三页各补一段，首页功能区加一张卡片，README 功能列表加一条，`CONTEXT.md` 去掉「只在 `--phones` 时显示」。12 种译文同步更新，并刷新 `sourceHash`。

**Tech Stack:** 不新增依赖。Node 22 直接跑 TS，`node:test`；文档站是 Astro Starlight（`site/`，`bun run build`、`node --test tests/*.test.ts`、`node scripts/translation-status.ts`）。

**Spec:** `docs/superpowers/specs/2026-11-13-real-device-design.md`。第 7 节写明：「PR 4 合入、真机验收通过后，再用一个小 PR 把它改成默认打开并删掉这个参数」；6.2 SDK 检查、6.3 侧栏与状态文案，是文档描述的依据。

**前置：** PR 1–7 已合入（main `e1dd403`）。分支 `feat/phones-on` 从 main 切出。

## Global Constraints

- 注释、日志、界面文案用中文；文档站英文页用英文，译文按各语言写。只用可擦除 TS 语法；`gateway/`、`host/`、`shared/` 的 import 写 `.ts`（`AGENTS.md`）。
- 不改协议：`PROTOCOL_VERSION`、`GATEWAY_LEVEL` 都不变。`phones` 消息的语义（「没收到过就当网关不支持真机」）保留给旧网关用，只改注释里提到 `--phones` 的说法。
- 不改产品定位：首页 `hero.title`、README 第一句和第一段不动（用户决定）。
- 文档只写验收时真正跑通过的行为。界面上的中文标签按现有英文文档的做法，翻成英文描述，不直接贴中文。
- 文档站不能出现 `site/tests/content.test.ts` 的 `FORBIDDEN` 说法（如 "no need to install"、"zero-latency"）。
- 提交信息 `<area>: <英文祈使句>`，文档站用 `docs(site): ...`。
- 类型检查（基线是 main 上的 2 个 `Uint8Array` 错误）：`~/Library/Caches/nsh/typescript-7.0.2-darwin-arm64/package/lib/tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions --erasableSyntaxOnly --lib es2023,dom,dom.iterable --types node --skipLibCheck host/src/main.ts gateway/src/main.ts`；页面 `nsh check ui` 的基线是 8 个错误。

## 本计划的取舍

1. **`--phones` 留作无效参数，不报错**：之前用 `droidpier start --phones` 装过后台服务的人，登录项里存着这个参数。如果改成报「不认识的参数」，网关开机就起不来。所以和 `--local` 一样直接跳过；`start --phones` 也不再把它写进新的登录项。
2. **只在连续失败的第一次记日志**：没装 adb 时 `spawn` 立刻失败，退避上限 5 秒，日志每分钟会多 12 行。这里不改退避间隔：装好 platform-tools 后，最多 5 秒就能连上。
3. **「只有真机时不弹安装引导」（spec 6.2 的 `env.ok` 拆分）不在本 PR**：
   - 现状：只插手机、没装模拟器的用户，会看到列出模拟器和系统镜像的环境检查卡片。卡片可以关掉，不挡画面，真机照常能用。
   - 拆分要改 `EnvReport` 的含义和卡片的呈现方式，不算「小 PR」，单独做。
   - 文档如实写：只用真机时，可以关掉卡片里模拟器相关的项。
4. **首页功能区加第 7 张卡片「USB phones」**：不删、也不合并现有卡片。如果验收时网格最后一行只剩一张显得别扭，加一条 Ruling 再处理，不在计划里预先改布局。
5. **日志面板、WebMCP 的文档页不在本 PR**：已列为单独的后续。新指南只在「能做什么」里各写一句，并链到 README。

## Review Focus

1. **没装 platform-tools 的新机器**：网关正常启动，页面照常显示环境检查卡片，日志不会每 5 秒刷一行。→ Task 2 测试；Task 5 用空的 `ANDROID_HOME` 验收。
2. **登录项里带 `--phones` 的老服务**：升级后照常启动；重新 `start --phones` 写入的参数里不再有它。→ Task 1 测试。
3. **只用模拟器的用户**：侧栏多出「真机」分组和提示「插上手机，并在手机上打开 USB 调试」，模拟器的接管、启动和重启行为都不变。→ Task 5 验收；现有 server 测试保持通过。
4. **只用真机的用户**：环境检查卡片会出现（取舍 3）。文档要说清楚可以关掉，以及真机只需要 adb。→ Task 3 文档；Task 5 用页面核对文案。
5. **译文与英文不同步**：新页面和改动页面的 12 种译文都要存在，`sourceHash` 是新的，首页实测数字不变。→ Task 4：跑 `translation-status` 和 `site` 测试。

---

### Task 1: 网关默认跟踪真机，`--phones` 不再起作用

**Files:**
- Modify: `gateway/src/cli.ts`（`CliOptions` 去掉 `phones`；`--phones` 跳过；`start` 的服务参数去掉 `--phones`）
- Modify: `gateway/src/main.ts`（总是 `createPhones` 并 `start()`，`phones` 不再可能是 null，去掉 `?.`）
- Modify（只改注释，不改逻辑）：`gateway/src/server.ts:164`、`shared/protocol.ts:345`、`host/src/connection.ts:94`、`host/src/phone-list.ts:4-5`、`host/src/webmcp.ts:49`、`ui/phones.ts:32`、`ui/App.tsx:1028`。把「没带 --phones」改成「旧网关」。
- Test: `gateway/test/cli.test.ts`

**Interfaces:**
- Produces：
  - `CliOptions = { port; noOpen; allowOrigins; service; autoUpdate }`，没有 `phones`。
  - `server.ts` 的 `opts.phones` 仍是可选字段：测试里不传真机时照常工作，接口不变。

- [ ] **Step 1: 改测试**（`gateway/test/cli.test.ts`）：
  - 第 11、16、45 行的期望对象去掉 `phones: false`；
  - 第 125 行的测试改为「parseCli：--phones 已不起作用，接受但忽略」：`assert.deepEqual(parseCli(["--phones"]), parseCli([]))`，`assert.ok(!USAGE.includes("--phones"))`；
  - 第 131 行的测试改为「droidpier start --phones 不再把它写进后台服务」：`assert.deepEqual((parseCli(["start", "--phones", "--port", "7310"]) as { args: string[] }).args, ["--port", "7310"])`。
- [ ] **Step 2: 跑测试，确认失败** Run: `node --test gateway/test/cli.test.ts` Expected: FAIL（还有 `phones` 字段，args 里还有 `--phones`）。
- [ ] **Step 3: 实现**：
  - `parseRun` 里把 `--phones` 和 `--local`、`--public` 一起 `continue`，并改那行的注释：「`--phones` 是真机开关的遗留参数，老的登录项里可能还有」；
  - `parseCli` 的 `start` 分支在过滤 `--no-open` 的同时过滤 `--phones`；
  - `main.ts`：`const phones = createPhones(...)`，然后 `phones.start()`；`discover`、server 选项和退出处理里都去掉 `?.` 和 `?? undefined`。删掉第 155 行「真机支持做完前的开关」那句注释，保留后半句「discover 要靠它认出真机 id，所以先建」。
- [ ] **Step 4: 跑测试** Run: `node --test gateway/test/cli.test.ts gateway/test/server.test.ts` Expected: PASS。再按 Global 的 tsc 命令确认仍只有那 2 个基线错误。
- [ ] **Step 5: 提交** `git commit -m "gateway: Track phones without --phones"`

### Task 2: adb 一直失败时只记一次日志

**Files:**
- Modify: `gateway/src/phones.ts`（`run` 的 `onExit`）
- Test: `gateway/test/phones.test.ts`

**Interfaces:**
- 不变：`createPhones(deps)` 的签名和对外方法。

- [ ] **Step 1: 写测试** `createPhones：adb 一直起不来时只记第一次，收到设备表后再失败会重新记`。
  - 用现有的假 `stream`（参考第 104 行的测试），`sleep` 立即返回，`log` 收集到数组里。
  - 连续触发三次 `onExit(-2)`，中间不给 `onData`：断言 `logs.filter((l) => l.includes("track-devices")).length === 1`。
  - 然后给一帧设备表 `onData("0000")`，再触发一次 `onExit(1)`：断言计数变成 2。
- [ ] **Step 2: 跑测试，确认失败** Run: `node --test gateway/test/phones.test.ts` Expected: FAIL（现在每次都记，计数是 3）。
- [ ] **Step 3: 实现**：`onExit` 里只在 `failures === 0`（递增之前）时调用 `log`。`failures` 由收到设备表时清零，这一点已有。日志文案改为「adb track-devices 退出（…），之后每隔几秒重试，恢复前不再提示」。
- [ ] **Step 4: 跑测试** Run: `node --test gateway/test/phones.test.ts` Expected: PASS；`npm test` 全绿。
- [ ] **Step 5: 提交** `git commit -m "gateway: Log a failing adb track-devices once"`

### Task 3: 英文文档、README、CONTEXT.md

**Files:**
- Create: `site/src/content/docs/docs/guides/phones.md`
- Modify: `site/src/site-config.mjs`（`Guides` 的 items 里，在 `docs/guides/devices` 后面加 `docs/guides/phones`）
- Modify: `site/src/content/docs/docs/guides/devices.md`（第一段后加一句：USB 真机见 Phones 指南）
- Modify: `site/src/content/docs/docs/getting-started/requirements.md`（新增 `## Phones` 一节）
- Modify: `site/src/content/docs/docs/guides/troubleshooting.md`（新增 `## A phone is not listed or does not connect`）
- Modify: `site/src/content/docs/index.mdx`（`Features` 的 items 末尾加一张卡片）
- Modify: `README.md`（Features 列表加一条；第一句和第一段不动）
- Modify: `CONTEXT.md`（**Phone** 词条删掉「Shown only when the gateway runs with `--phones` until phone support is complete.」）

**内容要点**（照这些写，措辞自定；每一条都要在 Task 5 验收时核对）：
- `phones.md`
  - frontmatter：`title: Phones`；`description` 不超过 160 个字符，例如「Use an Android phone over USB in the page: what it needs, switching to it, and what works differently from an emulator.」。
  - 小节：
    - **What you need**：USB 线；手机上打开开发者选项和 USB 调试；第一次在手机上允许这台 Mac；只需要 `platform-tools`（adb），不需要模拟器和系统镜像。最低 Android 版本按 scrcpy 5.0.1 的官方要求写（Android 5.0 / API 21，以 scrcpy README 为准，写之前核对一遍）。
    - **The phone list**：侧栏 Phones 分组；状态有 ready、unauthorized（在手机上点允许）、offline（重新插拔）；列表显示型号和 Android 版本。
    - **Switch to a phone**：插上不会自动连上（可能只是在充电），点它才连。连上后网关把 scrcpy-server 推到手机上运行，结束连接后不会留下常驻服务（核对 `phone-session.ts` 的清理逻辑后再写）。
    - **What works**：画面、点击和拖动、滚轮（原生滚动）、键盘和中文输入、两个方向的剪贴板、截图、装 APK 和拖文件、H5 调试、日志面板、AI 工具、重启。
    - **What is different**：
      - 旋转跟随手机本身，没有旋转键；
      - 没有停止键；
      - 重启后大约 1 分钟自动重新连上，锁屏在页面上解锁；
      - 拔线后页面显示手机已断开，插回自动恢复；
      - 帧率显示正常，但延迟不显示（手机时钟和 Mac 不同）。
    - **Only phones, no emulator**：环境检查卡片仍会列出模拟器和系统镜像，可以关掉；只装 platform-tools 就够（取舍 3）。
- `requirements.md`：`## Phones` 两三句，链到 `/docs/guides/phones/`。SDK 组件表里 `platform-tools` 的用途补上「talk to phones」。
- `troubleshooting.md`：
  - 不在列表里：检查 USB 调试、换线或口；
  - unauthorized：到手机上点允许，必要时撤销 USB 调试授权后重来；
  - offline：重新插拔；
  - 重启两分钟没回来：开机后重新插拔。
- `index.mdx` 卡片：`{ title: "USB phones", body: "Plug in an Android phone with USB debugging on, pick it in the device list, and use it like the emulator: screen, input, clipboard, H5 debugging and logs.", href: "/docs/guides/phones/" }`。
- README 一条：「Phones: an Android phone plugged in over USB shows in the device list next to the AVDs; switch to it for the same screen, input, clipboard, H5 debugging and log panel (rotation follows the phone, and there is no stop key)」。

- [ ] **Step 1: 写上面的文件**。
- [ ] **Step 2: 检查** Run: `cd site && bun run build && node --test tests/*.test.ts` Expected: 构建通过，测试全过（侧栏包含 `docs/guides/phones`，新页只有一个 h1，description 不超过 160 个字符，没有禁用说法）。`node scripts/translation-status.ts` 预期列出 12 个缺失和 36 个过期，Task 4 补齐。
- [ ] **Step 3: 提交** `git commit -m "docs: Describe phones in README, CONTEXT.md and the docs"`

### Task 4: 12 种译文

**Files（每种语言，前缀 `ar de es fr hi it ja ko pt-br ru zh-cn zh-tw`）：**
- Create: `site/src/content/docs/<locale>/docs/guides/phones.md`
- Modify: `site/src/content/docs/<locale>/docs/guides/devices.md`、`.../getting-started/requirements.md`、`.../guides/troubleshooting.md`
- Modify: `site/src/content/docs/<locale>/index.mdx`（加同一张卡片，译成该语言；`href` 带语言前缀，和该文件里其他卡片一致）

**Interfaces:**
- Consumes：Task 3 定稿的英文正文。`sourceHash` = `sourceHash(英文正文去掉 frontmatter)`（`site/scripts/translation-status.ts` 导出）。

- [ ] **Step 1: 翻译**：
  - 结构和英文逐节对应；
  - 链接加语言前缀，和该语言已有页面的写法一致；
  - 命令、参数、包名、按键原样保留；
  - frontmatter 的 `sourceHash` 填英文对应页的新值。
  - 已有译文只改英文里改动的段落，其余不动。
- [ ] **Step 2: 检查** Run: `cd site && node scripts/translation-status.ts && bun run build && node --test tests/*.test.ts` Expected: 先打印 `all translations current`，再构建通过、测试全过（13 种语言首页的实测数字和链接检查都通过）。
- [ ] **Step 3: 提交** `git commit -m "docs(site): Translate the phones guide and updates"`

### Task 5: 验收

- [ ] **Step 1: 默认开启**：
  - 用 `node gateway/src/main.ts --port 7306 --no-open --no-auto-update --local` 启动网关，不带 `--phones`。三星 SM-G9910 出现在侧栏，可以切过去，画面、点击、日志面板都正常。
  - 再带上 `--phones` 启动一次，行为相同。
- [ ] **Step 2: 只用模拟器**：拔掉手机后，侧栏「真机」分组显示插手机的提示。Pixel 6 Pro 的启动、接管、重启和 main 上一致。
- [ ] **Step 3: 没有 adb**：用 `ANDROID_HOME=<空目录>`（同时确认 `platform.ts` 的 `adbPath` 确实找不到 adb）启动网关，等 30 秒：
  - 日志里 `track-devices` 只出现 1 行；
  - 页面显示环境检查卡片，没有报错。
- [ ] **Step 4: 文档站**：`cd site && bun run dev`，打开以下页面，在桌面宽度和 375px 宽度各看一遍：
  - `/docs/guides/phones/`、`/zh-cn/docs/guides/phones/`；
  - 首页功能区：第 7 张卡片的网格是否别扭（取舍 4）。
  - 再逐条核对 `phones.md` 里写的行为都是 Step 1–3 跑出来的。
- [ ] **Step 5: 提交** `git commit -m "docs: Plan turning phones on by default"`（本计划文档）

## 后续

- spec 6.2：`env.ok` 拆成「adb 必需、模拟器可选」，只用真机时不弹安装引导；设备列表空态同时提示插手机和创建模拟器。没装 adb 时「真机」分组的空态不要再提示插手机。
- 日志面板、WebMCP 工具的文档站页面。
- 日志面板长行的详情视图；`stopAvd` 回复没有处理；`adb.test.ts` 偶发超时。
