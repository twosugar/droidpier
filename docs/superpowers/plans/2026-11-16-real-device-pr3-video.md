# 真机支持 PR 3（真机画面）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 带 `--phones` 启动时，侧栏里可用的真机能点「切换到这台」，页面实时显示手机画面（只看，操作是 PR 4）；拔线后显示「手机已断开」，本次运行期间插回会自动恢复。不带 `--phones` 时一切照旧。

**Architecture:**
- 网关：scrcpy-server v5.0.1 随网关发布；新的 `PhoneSession` 推 jar、建 forward、起服务端、解析视频流；`server.ts` 对真机会话走新的视频转发（有序、积压时丢到下一个关键帧），模拟器仍走现有 RGBA 通路。
- 协议只加不改：新二进制种类 `BIN_VIDEO`，`ready` 多带 `kind`、`caps`，新增状态 `phone-closed`。
- 页面：WebCodecs 解码，`VideoFrame` 画到现有 WebGL canvas 上；侧栏真机行可点，设备框比例改用 `ready.device`。

**Tech Stack:** 不新增依赖。Node 22 直接跑 TS，`node:test`；页面 nsh TSX + 浏览器 WebCodecs / WebGL2；构建 bun。

**Spec:** `docs/superpowers/specs/2026-11-13-real-device-design.md`，第 2 节第 2 条、6.1（能力表）、6.2（PhoneSession、视频转发、自动接管）、6.3（渲染、状态文案、延迟统计）、6.4、「原型实测」一段、7 节 PR 3

**前置：** PR 2（#36）已合入；分支 `feat/phone-video`，基于 `7de6c36`。行号以 `7de6c36` 为准，以符号名为准找位置。

## Global Constraints

- 注释、日志、界面文案用中文；只用可擦除 TS 语法；`gateway/`、`host/`、`shared/` 的 import 写 `.ts`，`ui/` 不写。
- 不新增依赖。scrcpy-server 是随包发布的资源，不是 npm 依赖。
- 协议只加不改，`PROTOCOL_VERSION` 保持 `1`（spec 6.4）。旧页面忽略 `BIN_VIDEO`；旧页面不会列出真机，也就不会连上真机，所以新状态 `phone-closed` 只会发给新页面。
- 模拟器通路不变：`frames()`、`LatestFrame`、`encodeFrameHeader` 的行为和帧格式一个字节都不改。
- 真机的长进程（scrcpy 服务端）走 `adb.stream`；短命令走 `adb.device(id)` 队列并有超时；push 走 `adb.long(id)`。
- scrcpy 协议细节以 spec「原型实测」一段为准（版本号 `5.0.1` 必须一致、`scid` 16 进制、哑字节、64 字节设备名、4 字节编码 id、12 字节头、会话包最高位、配置包第 62 位、关键帧第 61 位、重置视频 `[17]`）。
- 「一次只连一台」不变：切到真机会关掉当前模拟器会话（只断 gRPC，不关模拟器）。
- 提交信息 `<area>: <英文祈使句>`；PR 描述写 `## Protocol`。

## 本计划的取舍（写计划时定的）

1. **jar 直接入库**：`gateway/vendor/scrcpy/scrcpy-server-v5.0.1`（733930 字节）+ `LICENSE`（Apache-2.0）+ `NOTICE`。放在 `gateway/` 下自动进 CI 的源码指纹（`.github/workflows/pages.yml:76`），源码运行和单文件运行都不用联网下载；单测校验 sha256 与官方一致。
2. **画面长边固定 1920**（`max_size=1920`，原型实测 864x1920 / 55 fps），这一版不按页面尺寸重启服务端，浏览器缩放即可。spec 6.2 的「长边差 20% 才重启」留到后续 PR（见文末），这样多页面同看一台手机也不用协调尺寸。
3. **`BIN_VIDEO` 头 20 字节**：`[kind=3, seq, flags, width, height]`（u32 小端，和 `BIN_FRAME` 同长），flags 第 0 位配置包、第 1 位关键帧；不带 pts（真机时钟和电脑不同，不算延迟，spec 6.3）。
4. **真机会话的方向**：`device` 报竖屏尺寸（宽高取小、大），`rotation` 由当前视频宽高推出（宽 > 高为 90，否则 0）；变化时走现有 `onRotation` → `orientation` 消息。页面布局不用改。
5. **能力表**这一版真机全为 `false`（转屏、重启、关机、剪贴板、输入都不支持），页面按它隐藏按钮；`touch` / `key` / `text` 收到时忽略（PR 4 实现）。spec 6.1 / 6.3 / 6.5 里真机重启是支持的（`adb reboot`），这一版先不做，列进文末「后续」，PR 描述里写明。
6. **截图**：真机用 `adb exec-out screencap -p`，需要给 adb 加一条二进制输出、带超时的调用。
7. **「用户选过真机」是网关级状态**（`pinned`，存设备 id）：ticker 不再把模拟器接给没有会话的连接；该手机重新出现为 `device` 时自动重连并接给所有没有会话的连接。用户再点模拟器、或启动一台 AVD，就清掉它。

## Review Focus

1. **视频积压**：页面卡住或网慢时，网关不能无限缓存，也不能只丢 P 帧（会花屏）。→ Task 5 测试：超过阈值后丢到下一个关键帧、并请求一次重置视频；关键帧到来后恢复发送。
2. **新页面中途加入 / 页面暂停后恢复**：必须从配置包 + 关键帧开始，否则黑屏。→ Task 5 测试：新订阅者先收到缓存的配置包、在下一个关键帧前不收 P 帧，并触发一次重置视频；Task 6 测试 resume。
3. **拔线、scrcpy 服务端异常退出、adb 被杀**：会话要关掉、页面显示「手机已断开」，不能卡在最后一帧装作在线；forward 要移除。→ Task 4 测试流结束 / 套接字断开都触发 `onClosed` 并调用清理。
4. **切到真机后又插拔模拟器 / 开了新模拟器窗口**：ticker 不能把画面抢回模拟器。→ Task 6 测试。
5. **嵌入资源不能直接给 adb**：单文件里的 jar 是虚拟路径，push 前必须落到真实临时文件。→ Task 1 测试 `materializeScrcpyServer` 写出的文件 sha256 正确。

---

### Task 1: 随包发布 scrcpy-server

**Files:**
- Create: `gateway/vendor/scrcpy/scrcpy-server-v5.0.1`（从官方 release 下载，核对 `SHA256SUMS.txt`）
- Create: `gateway/vendor/scrcpy/LICENSE`（scrcpy 仓库的 Apache-2.0 全文）、`gateway/vendor/scrcpy/NOTICE`（一句话：来源、版本、许可证、未修改）
- Create: `gateway/src/scrcpy-server.ts`
- Modify: `scripts/build-binary.ts`（`assets` 加入 vendor 目录）
- Test: `gateway/test/scrcpy-server.test.ts`

**Interfaces:**
- Produces（`gateway/src/scrcpy-server.ts`）：
  - `export const SCRCPY_VERSION = "5.0.1"`
  - `export const SCRCPY_SHA256 = "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536"`
  - `export function scrcpyServerPath(standalone: boolean): string`：单文件时 `join(import.meta.dirname, "scrcpy", "scrcpy-server-v5.0.1")`，源码运行时 `gateway/vendor/scrcpy/scrcpy-server-v5.0.1`（和 `main.ts` 的 `STATIC_DIR` 同一写法）。
  - `export async function materializeScrcpyServer(src: string, tmpRoot: string): Promise<string>`：读出 jar，写到 `<tmpRoot>/droidpier-scrcpy-5.0.1.jar`（已存在且 sha256 对就直接返回），返回真实路径；sha256 不对时抛错。

- [ ] **Step 1: 放入 jar 并写测试**

  ```ts
  test("随包的 scrcpy-server 与官方 v5.0.1 一致", async () => {
    const buf = await readFile(scrcpyServerPath(false));
    assert.equal(buf.length, 733930);
    assert.equal(createHash("sha256").update(buf).digest("hex"), SCRCPY_SHA256);
  });
  test("materializeScrcpyServer 写出真实文件，sha256 正确；第二次直接复用", ...);
  test("materializeScrcpyServer：源文件被改过时报错，不写出", ...);
  ```

- [ ] **Step 2: 跑测试，确认失败**

  Run: `node --test gateway/test/scrcpy-server.test.ts`
  Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现，并改 `build-binary.ts`**

  把 `gateway/vendor/scrcpy` 复制到 `dist/stage/scrcpy`（不含 LICENSE/NOTICE 以外的东西），`assets: [stage, scrcpyStage]`。

- [ ] **Step 4: 跑全部单测**

  Run: `npm test`
  Expected: 全部 PASS。

- [ ] **Step 5: 构建单文件并确认 jar 在里面**

  Run: `NSH=$(command -v nsh) bun run build:bin`
  Expected: 构建成功、压缩包仍小于 25 MiB；`dist/droidpier-darwin-arm64 --help` 正常。

- [ ] **Step 6: 提交**

  ```bash
  git add gateway/vendor/scrcpy gateway/src/scrcpy-server.ts gateway/test/scrcpy-server.test.ts scripts/build-binary.ts
  git commit -m "gateway: Ship scrcpy-server 5.0.1 with the gateway"
  ```

### Task 2: adb 二进制输出调用（截图用）

**Files:**
- Modify: `gateway/src/adb.ts`
- Test: `gateway/test/adb.test.ts`

**Interfaces:**
- Produces：
  - `execAdb` 增加可选参数 `opts?: { binary?: boolean }`；`binary` 时以 `encoding: "buffer"` 运行，返回 `Buffer`（类型用重载或另起 `execAdbBuffer`，二选一，实现者定）。
  - `createAdb()` 返回值新增 `deviceBuffer(id: string): (args: string[], timeoutMs?: number) => Promise<Buffer>`，走同一设备队列，默认超时 `ADB_TIMEOUT_MS`。
  - `createAdb(opts)` 新增可选注入 `execBuffer?: (args: string[], timeoutMs?: number) => Promise<Buffer>`（测试用）；`queued` 改成泛型 `queued<T>(key, job: () => Promise<T>): Promise<T>`，字符串和 Buffer 共用同一条设备队列。

- [ ] **Step 1: 写测试**：假 adb 输出 `printf '\x89PNG\r\n\x1a\n\x00\xff'`，断言拿到的 Buffer 逐字节相同；超时仍抛 `AdbUnresponsive`。
- [ ] **Step 2: 跑测试，确认失败** Run: `node --test gateway/test/adb.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑全部单测** Run: `npm test` Expected: PASS。
- [ ] **Step 5: 提交** `git commit -m "gateway: Read binary adb output for phone screenshots"`

### Task 3: scrcpy 协议（纯函数）与 `BIN_VIDEO`

**Files:**
- Create: `gateway/src/scrcpy.ts`
- Modify: `shared/protocol.ts`
- Test: `gateway/test/scrcpy.test.ts`、`shared/test/protocol.test.ts`

**Interfaces:**
- Produces（`gateway/src/scrcpy.ts`）：
  - `export function serverArgs(scid: string, remoteJar: string): string`：返回给 `adb shell` 的整条命令：`CLASSPATH=<remoteJar> app_process / com.genymobile.scrcpy.Server 5.0.1 scid=<scid> log_level=info audio=false control=true tunnel_forward=true video_codec=h264 max_size=1920 stay_awake=true power_on=true cleanup=true`。
  - `export function randomScid(): string`：8 位 16 进制，最高位为 0。
  - `export type VideoEvent = { kind: "meta"; name: string } | { kind: "codec"; id: number } | { kind: "session"; width: number; height: number } | { kind: "packet"; config: boolean; key: boolean; data: Buffer }`
  - `export function createVideoParser(onEvent: (e: VideoEvent) => void): { push(chunk: Buffer): void }`：按顺序解析「哑字节 → 64 字节设备名 → 4 字节编码 id → 循环 12 字节头」，跨 chunk 拼接。**哑字节由 parser 自己吃掉**：视频连接收到的第一块数据（含哑字节）原样交给它。
  - `export const RESET_VIDEO = Buffer.from([17])`
- Produces（`shared/protocol.ts`）：
  - `export const BIN_VIDEO = 3`
  - `export type VideoHeader = { seq: number; config: boolean; key: boolean; width: number; height: number }`
  - `export function encodeVideoHeader(h: VideoHeader): Uint8Array`、`export function decodeVideoHeader(buf: Uint8Array): VideoHeader`（20 字节，见取舍 3）
  - `export type DeviceCaps = { rotate: boolean; reboot: boolean; stop: boolean; clipboard: boolean; input: boolean }`
  - `ready` 增加可选 `kind?: "emulator" | "phone"`、`caps?: DeviceCaps`；`status.state` 增加 `"phone-closed"`。

- [ ] **Step 1: 写测试**

  ```ts
  // 按原型实测的格式拼字节：0x00 + "SM-G9910" 补零到 64 + 0x68323634 + 会话包 + 配置包 + 关键帧 + P 帧
  test("createVideoParser：按顺序给出设备名、编码、会话尺寸和三种包", ...);
  test("createVideoParser：任意切成 1 字节一块喂入，结果相同", ...);
  test("createVideoParser：会话包最高位为 1、取宽高；配置包第 62 位、关键帧第 61 位", ...);
  test("serverArgs：版本号是 5.0.1，参数与原型一致", () => assert.match(serverArgs("1a2b3c4d", "/data/local/tmp/x.jar"), /Server 5\.0\.1 scid=1a2b3c4d .*max_size=1920/));
  test("randomScid：8 位 16 进制且不超过 0x7fffffff", ...);
  test("encodeVideoHeader / decodeVideoHeader 往返；kind 是 BIN_VIDEO", ...);   // shared/test/protocol.test.ts
  ```

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test gateway/test/scrcpy.test.ts shared/test/protocol.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑全部单测** Run: `npm test` Expected: PASS。
- [ ] **Step 5: 提交** `git commit -m "gateway: Parse the scrcpy video stream"`

### Task 4: PhoneSession

**Files:**
- Create: `gateway/src/phone-session.ts`
- Modify: `gateway/src/emulator.ts`（`EmulatorSession` 加 `kind: "emulator"`、`caps`；导出共用类型 `DeviceSession`）
- Test: `gateway/test/phone-session.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `materializeScrcpyServer` / `scrcpyServerPath`；Task 2 的 `adb.deviceBuffer`；Task 3 的 `serverArgs`、`createVideoParser`、`RESET_VIDEO`、`DeviceCaps`；PR 2 的 `adb.stream`、`adb.device`、`adb.long`；`webviews.ts` 的 `findFreePort` / `releasePort`。
- Produces：
  - `gateway/src/emulator.ts`：`export type DeviceSession = EmulatorSession`，并在 `EmulatorSession` 上新增 `kind: "emulator" | "phone"`、`caps: DeviceCaps`、可选 `video?(onPacket: (p: { config: boolean; key: boolean; data: Buffer; width: number; height: number }) => void): () => void`、可选 `requestKeyFrame?(): void`。模拟器实现填 `kind: "emulator"`，`caps` 全为 `true`（`input: true`）。
  - `gateway/src/phone-session.ts`：
    `export async function connectPhone(id: string, deps: PhoneDeps): Promise<DeviceSession>`
    其中 `PhoneDeps = { jarPath(): Promise<string>; push(local: string, remote: string): Promise<void>; forward(port: number, scid: string): Promise<void>; removeForward(port: number): Promise<void>; freePort(): Promise<number>; releasePort(port: number): void; startServer(cmd: string, h: AdbStreamHandlers): AdbStream; connect(port: number): Promise<Duplex>; screencap(): Promise<Buffer>; log?(s: string): void }`。
  - 会话行为：
    - `id` 为设备 id，`serial: 0`，`avdName: undefined`，`kind: "phone"`，`caps` 全为 `false`。
    - 连接顺序：`jarPath` → `push` 到 `/data/local/tmp/droidpier-scrcpy-5.0.1.jar` → `freePort` + `forward` → `startServer` → 连视频连接 → 再连控制连接 → 等到第一个会话包后 resolve（`device` = 竖屏宽高）。
    - 视频连接的重试：服务端还没监听时，adb forward 照样接受本机连接、随后关闭。判据是「收到任何字节之前连接就断了」→ 等 100ms 重连，最多 5 秒；收到的第一块数据（含哑字节）整块交给 `createVideoParser`。控制连接没有哑字节。
    - 控制连接要一直读走数据（这一版丢弃，PR 4 再解析剪贴板等设备消息），否则服务端写设备消息时会堵住。
    - 设备名要等控制连接也连上后才会在视频连接上发出（scrcpy 的 `sendDeviceMeta` 在三条连接都 accept 之后），所以必须先连上控制连接再等会话包。
    - `video(onPacket)`：注册订阅，返回取消函数；缓存最近一个配置包，新订阅者先收到它。
    - `requestKeyFrame()`：向控制连接写 `RESET_VIDEO`，200ms 内最多一次。
    - 会话包宽高变化 → 更新 `rotation`（取舍 4）并回调 `onRotation`。
    - `screenshot()` 走 `deps.screencap`；`frames()` 返回空取消函数；`touch` / `key` / `text` / `setClipboard` 什么都不做；`rotate` / `reboot` 抛「这台设备不支持」；`getClipboard` 返回空串；`onClipboard` 不回调。
    - 关闭：服务端流退出、视频或控制连接断开、`close()` 任一发生时，只执行一次：停服务端、关两条连接、`removeForward` + `releasePort`，再回调 `onClosed`。

- [ ] **Step 1: 写测试**（假 deps，用 `PassThrough` 当套接字，按 Task 3 的格式推字节）

  ```ts
  test("connectPhone：按顺序 push、forward、起服务端，连上后 device 是竖屏尺寸", ...);   // 推会话包 1920x864 → device 864x1920，rotation 90
  test("video：新订阅者先收到缓存的配置包，再收到后续包", ...);
  test("requestKeyFrame 向控制连接写 [17]，200ms 内只写一次", ...);
  test("会话包宽高从竖变横时回调 onRotation(90)", ...);
  test("服务端流退出 → onClosed 一次，移除 forward 并释放端口", ...);
  test("视频连接断开 → 同样关闭；close() 之后再断开不重复回调", ...);
  test("rotate / reboot 抛「这台设备不支持」；touch 不报错", ...);
  test("连不上服务端（5 秒内读不到哑字节）→ reject，并移除 forward", ...);
  ```

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test gateway/test/phone-session.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现**；`emulator.ts` 里补 `kind`、`caps`，`server.test.ts` 的 `FakeSession`、`session-cache.test.ts` 的假会话同步加字段。
- [ ] **Step 4: 跑全部单测** Run: `npm test` Expected: PASS。
- [ ] **Step 5: 提交** `git commit -m "gateway: Connect to a phone through scrcpy-server"`

### Task 5: 视频转发（按连接，有序 + 丢到关键帧）

**Files:**
- Create: `gateway/src/video-sender.ts`
- Test: `gateway/test/video-sender.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `encodeVideoHeader`。
- Produces：
  `export function createVideoSender(o: { send(buf: Buffer): void; buffered(): number; requestKey(): void; limitBytes?: number }): { push(p: { config: boolean; key: boolean; data: Buffer; width: number; height: number }): void; reset(): void; dropped(): number }`
  - `limitBytes` 默认 4 MiB（原型用的阈值，注释写明出处）。
  - 状态：`waitingKey`（初始为 `true`）。配置包总是发；`waitingKey` 时丢掉非关键帧，遇到关键帧发出并置 `false`。
  - `buffered()` 超过阈值时：丢掉当前包、置 `waitingKey = true`、调用一次 `requestKey()`。
  - `reset()`：置 `waitingKey = true` 并 `requestKey()`（给 resume 用）。
  - `seq` 每发一个包加一。

- [ ] **Step 1: 写测试**

  ```ts
  test("开始时丢掉 P 帧，直到关键帧；配置包总是发", ...);
  test("积压超过阈值：丢掉这个包，请求一次关键帧，之后只发关键帧起的包", ...);
  test("reset 之后重新等关键帧", ...);
  test("seq 连续递增，头里带包的宽高和 config / key 标记", ...);
  ```

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test gateway/test/video-sender.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑全部单测** Run: `npm test` Expected: PASS。
- [ ] **Step 5: 提交** `git commit -m "gateway: Forward phone video in order and resync on a key frame"`

### Task 6: 服务端接入真机会话

**Files:**
- Modify: `gateway/src/server.ts`
- Modify: `gateway/src/main.ts`
- Test: `gateway/test/server.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `connectPhone`、`DeviceSession`；Task 5 的 `createVideoSender`；PR 2 的 `phones`。
- Produces（`server.ts` 的行为）：
  - `attach` 发的 `ready` 带 `kind`、`caps`。
  - `subscribe`：`session.kind === "phone"` 时不走 `frames()` / `LatestFrame`，改为 `session.video(p => sender.push(p))`，每个连接一个 `createVideoSender`（`send` = `ws.send`，`buffered` = `ws.bufferedAmount`，`requestKey` = `session.requestKeyFrame`）；订阅时调用一次 `requestKeyFrame()`。`pause` 取消视频订阅；`resume` 重新订阅（新 sender，等关键帧）。真机不计 `lagMs`。
  - `use`：`m.name` 是 `opts.phones.list()` 里 `state === "device"` 的 id 时，跳过 `avdNameError`，交给 `opts.avd.use(name)`（`main.ts` 里的 `discover` 认得真机 id）；成功后把 `pinned` 设为该 id；用户 `use` 模拟器或 `start` 一台 AVD 时清掉 `pinned`。
  - 真机会话 `onClosed`：发 `{ t: "status", state: "phone-closed" }`（模拟器仍是 `emulator-closed`）。
  - ticker：`pinned` 是真机 id 时，不把模拟器接给没有会话的连接。
  - hello：`pinned` 是真机 id 且当前没有会话时，不调 `getSession()`，直接发 `{ t: "status", state: "phone-closed" }`（否则掉线期间新开的页面会被接到模拟器上）。
  - `phones.onChange`：`pinned` 对应的手机重新以 `device` 出现、且有没有会话的连接时，`opts.avd.use(pinned)` 后接给这些连接。
  - `rotate` / `reboot` / `stop`：会话 `caps` 对应项为 `false` 时回 `{ t: "error", message: "这台设备不支持<动作>" }`，不调用会话。
  - 截图：真机 `s.avdName` 为空，文件名用 `s.id`（现有逻辑已满足）。
- Produces（`main.ts`）：
  - `discover(name?)` 里，`name` 是 `phones?.list()` 中 `device` 状态的 id 时调用 `connectPhone(name, deps)`（deps 用 `adb`、`findFreePort` / `releasePort`、`materializeScrcpyServer(scrcpyServerPath(STANDALONE), tmpdir())`、`net.connect`），其余照旧。
  - `phones` 的创建挪到 `discover` / `getSession` 定义之前（现在在 `main.ts:188`，晚于 `:150` 的 `discover` 和 `:186` 的首次 `getSession()`）。
  - 真机路径里 `connectPhone` 的错误**往外抛**，不像模拟器路径那样吞成 `null`，这样 `use` 的 `.catch` 能把真实原因（比如「连不上 scrcpy-server」）显示给页面。
  - 真机会话也赋给 `last`（退出清理里 `last?.close()` 才会关掉它：停服务端、移除 forward；服务端带 `cleanup=true` 会删掉 jar）。`use` 切换设备时 `last` 跟着换成新会话。

- [ ] **Step 1: 写测试**（`FakeSession` 加一个 `kind: "phone"` 的变体 `FakePhone`，`video` 记录订阅、可 `pushPacket`）

  ```ts
  test("use 真机 id：ready 带 kind=phone 和 caps，之后收到 BIN_VIDEO，不收 BIN_FRAME", ...);
  test("真机：订阅时请求一次关键帧；P 帧在关键帧之前不发", ...);
  test("真机会话关闭：页面收到 phone-closed", ...);
  test("选过真机后，没有会话的连接不会被 ticker 接上模拟器", ...);
  test("选过的真机重新出现为 device：自动重连并接上", ...);
  test("rotate / reboot / stop 对真机回「这台设备不支持」，不调用会话", ...);
  test("use 一台不在真机列表里、名字也不合法的设备（如拔线后的 192.168.1.5:5555）：仍按原来的规则报「设备名不对」", ...);
  test("选过的真机掉线期间新开页面：收到 phone-closed，不会被接到模拟器", ...);
  test("use 真机时 connectPhone 失败：页面收到带真实原因的错误", ...);
  test("pause 后不再收到 BIN_VIDEO；resume 后从关键帧重新开始", ...);
  ```

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test gateway/test/server.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑全部单测** Run: `npm test` Expected: PASS。
- [ ] **Step 5: 真机冒烟**（手机插上并解锁）

  Run: `node gateway/src/main.ts --port 7306 --no-open --no-auto-update --phones --local`
  用 chrome-devtools 的独立 Chrome 打开 `http://127.0.0.1:7306/app/`（Task 7、8 做完前只看网关日志）：日志出现「已连接 R5CR10WN52H」一类的行，`adb -s R5CR10WN52H shell ps -A | grep app_process` 能看到服务端；SIGTERM 后 forward 被移除、手机上没有 scrcpy 进程、`/data/local/tmp/droidpier-scrcpy-5.0.1.jar` 被删除。

- [ ] **Step 6: 提交** `git commit -m "gateway: Switch to a phone and stream its screen to pages"`

### Task 7: 页面侧解码与渲染（host）

**Files:**
- Create: `host/src/video.ts`
- Modify: `host/src/renderer.ts`（新增 `putVideoFrame`）
- Modify: `host/src/connection.ts`（分派 `BIN_VIDEO`；`onReady` 多带 `kind`、`caps`、`deviceId`）
- Modify: `host/src/main.ts`（按 `kind` 选通路；`emu.status` 多带 `device`、`deviceId`、`kind`、`caps`；真机不报延迟；`snapshot()` 支持视频帧）
- Test: `shared/test/video.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `BIN_VIDEO`、`decodeVideoHeader`、`DeviceCaps`。
- Produces：
  - `host/src/video.ts`：
    - `export function codecFromSps(annexB: Uint8Array): string`：找 NAL 类型 7，返回 `avc1.PPCCLL`；找不到时 `avc1.42001f`。
    - `export function createVideoPipe(o: { makeDecoder(codec: string): { decode(key: boolean, data: Uint8Array): void; close(): void; queueSize(): number } }): { push(h: VideoHeader, data: Uint8Array): void; close(): void }`：配置包 → 记下 SPS/PPS、按 `codecFromSps` 新建解码器；关键帧前拼上配置包；没有解码器或还没等到关键帧时丢 P 帧；`queueSize() > 8` 时丢 P 帧（原型取值）。
    - `export function webCodecsDecoder(codec: string, onFrame: (f: VideoFrame) => void, onError: (e: Error) => void)`：WebCodecs 的薄封装（`optimizeForLatency: true`、`hardwareAcceleration: "prefer-hardware"`、不传 `description`），只在浏览器里用，不进单测。
  - `renderer.ts`：`putVideoFrame(f: VideoFrame): void`：尺寸变了先走现有的 `ensureTexture(displayWidth, displayHeight)`，再用 **`texSubImage2D(…, f)`** 上传（现有纹理是 `texStorage2D` 建的不可变纹理，对它调 `texImage2D` 会 INVALID_OPERATION）；和 RGBA 共用同一个程序和纹理，Y 方向不用另翻（顶点着色器已翻，`VideoFrame` 也是上行在前）。被新帧顶掉、还没画的 `VideoFrame` 要 `close()`；画完的保留为最后一帧供截图，换帧时 `close()` 旧的。`shown()` 不变（视频帧时返回 `null`），新增 `shownVideo(): VideoFrame | null`。
  - 视频帧画完也要回调 `onDraw`，让 `host/src/main.ts:137` 照常数帧率；但不算延迟（`createRenderer` 的 `onDraw` 改为 `onDraw(tsMs: number | null)`，视频帧传 `null`，`main.ts` 收到 `null` 时只加帧数）。
  - `main.ts` 的 `snapshot()`：有 `shownVideo()` 时用 `OffscreenCanvas` 的 2D `drawImage` 出 JPEG，否则走现有 RGBA。

- [ ] **Step 1: 写测试**（假 `makeDecoder` 记录调用）

  ```ts
  test("codecFromSps：从原型抓到的 SPS 得到 avc1.64002a", ...);   // 用 profile 0x64 / constraint 0x00 / level 0x2a 的最小 SPS 字节
  test("createVideoPipe：配置包新建解码器，关键帧前拼上 SPS/PPS", ...);
  test("createVideoPipe：没等到关键帧时丢 P 帧；解码队列超过 8 时丢 P 帧，不丢关键帧", ...);
  test("createVideoPipe：新的配置包（转屏）关掉旧解码器、按新 codec 重建", ...);
  ```

- [ ] **Step 2: 跑测试，确认失败** Run: `node --test shared/test/video.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑全部单测并构建 host** Run: `npm test && bun run build:host` Expected: PASS，构建成功。
- [ ] **Step 5: 提交** `git commit -m "host: Decode phone video with WebCodecs"`

### Task 8: 页面（真机可切换、按能力表显示）

**Files:**
- Modify: `ui/phones.ts`（状态文案）
- Modify: `ui/App.tsx`
- Test: `shared/test/phones-ui.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `emu.status` 新字段（`device`、`deviceId`、`kind`、`caps`）；PR 2 的 `PhoneRow`、`phones` 信号。
- Produces（`ui/phones.ts`）：
  - `phoneStatus(p, current: boolean)`：`device` 且是当前设备 →「当前画面 · 暂不能操作」；`device` 非当前 →「可用，点一下切换」；`unauthorized` / `offline` 文案不变。
  - `canPick(p: PhoneInfo): boolean`：只有 `device` 可点。
- 页面行为（`App.tsx`）：
  - `PhoneRow` 改成和 `DeviceRow` 同样的 `Button`，`canPick` 时点击调用 `host.call("emu.use", { name: p.id })`；当前真机行选中态。
  - 新增 `deviceId`、`kind`、`caps`、`deviceSize` 信号（来自 `emu.status`）；`currentPhone = phones().find(p => p.id === deviceId())`。
  - 设备框比例：`currentAvd()` 有尺寸时用它，否则用 `deviceSize()`（来自 `ready.device`），都没有才用 1080×2340。
  - 顶部标题：当前是真机时显示 `phoneLabel(currentPhone)`。
  - 按 `caps` 隐藏转屏、重启、关机按钮（模拟器 `caps` 全为 `true`，界面不变）。
  - `State` 增加 `"phone-closed"`，`LABEL` 为「手机已断开」，`PROBLEM` 为「重新插上手机后会自动恢复」；`host/src/connection.ts` 的 `ConnState` 同步。
  - 设备身份统一改用 `deviceId`（真机 `serial` 是 0，会被当成「没有设备」），`serial` 只留给模拟器的 `currentAvd` / `isCurrent` 匹配。要改的地方：
    - `ui/App.tsx:956` 的 `device = state()==="connected" ? serial() : 0`（H5 按钮靠它启用）；
    - `ui/App.tsx:1571` 的 `inspected.serial` 和 `ui/console-gone.ts` 里的比较；
    - `ui/App.tsx:1028` 的 `closeIfGone({ kind: "status", serial })`；
    - `host/src/main.ts:209`（非 connected / rebooting 时清零）和 `:214` 的 `onReady` 签名，带出 `deviceId`、`kind`、`caps`、`device`。
  - 真机上的 H5 调试这一版要能用（spec 6.1：h5 对两类设备都支持），列进验收。

- [ ] **Step 1: 写测试**：`phoneStatus` 当前 / 非当前两种文案；`canPick` 只认 `device`。
- [ ] **Step 2: 跑测试，确认失败** Run: `node --test shared/test/phones-ui.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑全部单测并构建页面** Run: `npm test && bun run build:host && NSH=$(command -v nsh) bun run build:ui` Expected: PASS，构建成功。
- [ ] **Step 5: 页面验收**（手机插上并解锁；用 chrome-devtools 的独立 Chrome，隔离上下文）

  Run: `node gateway/src/main.ts --port 7306 --no-open --no-auto-update --phones --local`，打开 `http://127.0.0.1:7306/app/`。
  Expected:
  - 点侧栏「Samsung SM-G9910」→ 主区显示手机实时画面，设备框比例是手机的，标题是「Samsung SM-G9910」，该行显示「当前画面 · 暂不能操作」，转屏 / 重启按钮隐藏；页面里滑动手机实测画面跟着变（手在手机上操作）。
  - 截图按钮下载到 PNG，文件名含 `R5CR10WN52H`。
  - 手机上打开长桥 HK debug 包里的一个 H5 页面，「H5 调试」能列出它并打开 DevTools。
  - 手机横屏打开视频类 App，页面画面变横。
  - `adb -s R5CR10WN52H reconnect` → 页面显示「手机已断开」，随后自动恢复画面。
  - 点回模拟器 → 模拟器画面正常、帧率不低于改动前（对比顶部「帧/秒」）。
  - 关掉页面标签再打开 → 直接接上当前真机画面（不被模拟器抢走）。
  - 不带 `--phones` 重启 → 没有真机分组，模拟器一切照旧。
  截图留证。

- [ ] **Step 6: 提交** `git commit -m "ui: Show a phone's screen when it is picked"`

### Task 9: 文档

**Files:**
- Modify: `CONTEXT.md`（**Session** 词条改为「连接一台设备（模拟器或真机）」；新增 **Phone session**）
- 设计文档第 7 节 PR 3 的版本说法已在本分支改正（不升 `PROTOCOL_VERSION`）

- [ ] **Step 1: 更新 CONTEXT.md**
- [ ] **Step 2: 提交并开 PR**

  ```bash
  git add CONTEXT.md docs/superpowers/specs/2026-11-13-real-device-design.md docs/superpowers/plans/2026-11-16-real-device-pr3-video.md
  git commit -m "docs: Describe phone sessions"
  ```

  PR 标题 `gateway: Show a phone's screen behind --phones`，`## Protocol`：新增 `BIN_VIDEO`（kind 3）、`ready.kind` / `ready.caps`、状态 `phone-closed`；`PROTOCOL_VERSION` 不变及原因。正文写明 scrcpy-server 5.0.1 以 Apache-2.0 随包发布（附 LICENSE / NOTICE）。

## 后续

- PR 4：真机输入与剪贴板（触摸、滚轮、按键、中文、剪贴板双向），真机 `caps.input` / `caps.clipboard` 改为 `true`。
- 按页面尺寸调整 `max_size`（spec 6.2 的 20% 阈值重启）。
- 真机重启（`adb reboot`，确认文案「重启手机」，adb 卡住时不可用；spec 6.1 / 6.3 / 6.5）。
- PR 2b、PR 5、PR 6 按 spec 第 7 节。
