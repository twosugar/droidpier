---
title: AI 客户端（MCP）
description: 通过网关的 MCP 服务，让 Claude Code 等 AI 客户端调试页面上正显示的那台设备里的 H5 页面。
sourceHash: 841858735b29
---

`droidpier mcp` 把支持 Model Context Protocol（MCP）的 AI 客户端（例如 Claude Code）接到网关上。客户端随后可以操作页面上正显示的那台设备：列出它的 H5 页面、在页面里执行 JavaScript、读取 console、截图。

客户端经由网关调试，不自己另开调试连接。这一点在 iOS 模拟器上很重要：WebKit 同一时间只让一个调试端连接一个页面，另起的工具（例如 iwdp）和页面里的 H5 控制台会互相顶掉。经由网关时，AI 客户端和 H5 控制台共用同一条连接。

## 需要什么 {#what-you-need}

- 网关在运行：后台运行（`droidpier start`）或在终端窗口里运行都可以。后台网关会自动更新；MCP 需要 2026-11-24 及以后发布的版本。在终端窗口里运行的网关，重新运行安装命令来更新。
- 页面开着，并且显示着你想让客户端使用的设备。

## 添加到客户端 {#add-it-to-your-client}

在 Claude Code 里添加一次：

```sh
claude mcp add droidpier -- droidpier mcp
```

之后新开一个 Claude Code 会话，工具会以 `mcp__droidpier__…` 的名字出现。

其他客户端接受以命令方式运行、通过标准输入输出通信的服务。请写可执行文件的完整路径，因为从程序坞启动的应用的 `PATH` 里可能没有 `~/.local/bin`：

```json
{
  "mcpServers": {
    "droidpier": { "command": "/Users/<you>/.local/bin/droidpier", "args": ["mcp"] }
  }
}
```

如果网关不在默认端口上运行，加上端口：`droidpier mcp --port 7310`。

## 工具 {#the-tools}

| 工具 | 作用 |
|---|---|
| `device_status` | 页面上正显示的设备：名称、平台（`android` 或 `ios`）、类型和屏幕的像素尺寸。 |
| `list_pages` | 这台设备上的 H5 页面，每个都带 `page` 值、标题、地址、所属应用，以及是否在前台。 |
| `evaluate` | 在页面里执行一段 JavaScript 表达式，把结果以 JSON 返回。结果是 Promise 时会等它完成。表达式抛出异常时，工具失败并带上异常信息。 |
| `console_logs` | 页面的 console 输出和未捕获的异常。从工具第一次用到这个页面时开始收集；在 iOS 模拟器上还包括之前已经打印的内容。保留最近 500 条。把上一次返回的 `next` 作为 `since` 传入，只取新的。 |
| `screenshot` | 设备屏幕的截图，PNG 格式。 |

`evaluate` 和 `console_logs` 的 `page` 参数用 `list_pages` 给出的值。不填时用前台的那个页面；前台有多个页面时，工具会失败并列出可选的页面。

## 用哪台设备、哪些页面 {#which-device-and-which-pages}

工具总是使用页面上正显示的设备。要换一台，在页面上切换过去。没有页面开着时，工具使用网关最近一次连接的设备；一台都没有时会说明。

页面是设备允许调试器看到的那些：

- Android 模拟器和手机：Chrome 标签页，以及开启了 WebView 调试的应用里的 WebView。
- iOS 模拟器：Safari 标签页，以及设置了 `isInspectable` 的 `WKWebView`（iOS 16.4 及以上）。

## 和 H5 控制台一起用 {#using-it-next-to-the-h5-console}

AI 客户端和页面里的 H5 控制台可以同时调试同一个页面。客户端打印的内容也会出现在 H5 控制台里。

在 iOS 模拟器上，客户端正在使用某个页面时，如果你打开或关闭这个页面的 H5 控制台，网关会重开这个页面的调试连接，让控制台从干净的状态开始，关闭后也不留下任何设置（例如下一个页面加载前先暂停）。这一刻正在进行的工具调用会失败，客户端重试即可。

网关重启时（例如自动更新），`droidpier mcp` 不会退出，网关回来后会自动重新连上，最多等一分钟。这一刻正在进行的调用会失败。

## 安全 {#security}

`droidpier mcp` 通过 Unix socket 连接网关：`~/Library/Application Support/Droidpier/mcp-<port>.sock`。只有你的 macOS 用户能打开它所在的文件夹。网关不为它打开任何网络端口，网页也无法访问它。

以你的用户身份运行的任何程序都可以使用这个 socket，就像它本来也能自己运行 `adb` 或 `simctl` 一样。拿到这些工具的客户端可以在你设备上的 H5 页面里执行任意 JavaScript，包括你已经登录的页面。请像允许其他会执行代码的工具那样，在客户端里允许这些工具。

网关其他方面的安全说明见[安全性](/zh-cn/docs/reference/security/)。

## 故障排查 {#troubleshooting}

| 问题 | 怎么办 |
|---|---|
| 网关没有运行，`droidpier mcp` 退出 | 用 `droidpier start` 启动网关，然后让客户端重新连接。 |
| 工具说没有连接设备 | 打开页面，切换到一台设备。 |
| 工具找不到某个页面 | 重新运行 `list_pages`：应用打开、关闭页面时，页面列表会变化。 |
| iOS 页面上工具超时 | 页面可能停在调试器里，例如停在 H5 控制台的断点上。在那里让它继续运行。 |
