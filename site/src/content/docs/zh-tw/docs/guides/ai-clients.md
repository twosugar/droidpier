---
title: AI 客戶端 (MCP)
description: 讓 AI 客戶端（例如 Claude Code）透過閘道的 MCP 伺服器，對頁面上顯示的裝置上的 H5 頁面進行除錯。
sourceHash: 841858735b29
---

`droidpier mcp` 將支援 Model Context Protocol (MCP) 的 AI 客戶端（例如 Claude Code）連接到閘道。客戶端即可查看頁面所顯示的裝置：列出其 H5 頁面、在頁面中執行 JavaScript、讀取主控台輸出並截圖。

客戶端透過閘道連接，而不是自行建立除錯連線。這對 iOS 模擬器特別重要：WebKit 一次只允許一個偵錯器附加至頁面，因此獨立工具（例如 iwdp）和頁面的 H5 主控台會互相干擾。透過閘道，AI 客戶端和 H5 主控台共享同一個連線。

## 你需要的 {#what-you-need}

- 閘道已在執行，在背景（`droidpier start`）或終端機視窗中。背景閘道會自動更新；MCP 需要 2026-11-24 或更新的版本。如需更新在終端機視窗中執行的閘道，請再次執行安裝命令。
- 頁面已開啟，並顯示你想讓客戶端使用的裝置。

## 新增到客戶端 {#add-it-to-your-client}

在 Claude Code 中，只需新增一次：

```sh
claude mcp add droidpier -- droidpier mcp
```

之後啟動一個新的 Claude Code 工作階段：工具會以 `mcp__droidpier__…` 的形式出現。

其他客戶端使用以命令方式執行、透過標準輸入輸出通訊的伺服器。請提供可執行檔的完整路徑，因為從 Dock 啟動的應用程式可能在 `PATH` 中沒有 `~/.local/bin`：

```json
{
  "mcpServers": {
    "droidpier": { "command": "/Users/<你的使用者名稱>/.local/bin/droidpier", "args": ["mcp"] }
  }
}
```

如果閘道在其他連接埠上執行，請加上：`droidpier mcp --port 7310`。

## 工具 {#the-tools}

| 工具 | 功能 |
|---|---|
| `device_status` | 頁面顯示的裝置：名稱、平台（`android` 或 `ios`）、類型和像素螢幕尺寸。 |
| `list_pages` | 該裝置上的 H5 頁面，每個頁面都有 `page` 值、標題、網址、應用程式及是否在前台。 |
| `evaluate` | 在頁面中執行 JavaScript 表達式並以 JSON 格式回傳結果。會等待 Promise。表達式拋出錯誤時，工具會以該錯誤失敗。 |
| `console_logs` | 頁面的主控台輸出和未捕獲的錯誤。第一次有工具使用該頁面時開始收集；在 iOS 模擬器上也包含之前記錄的訊息。最多保留 500 筆。將上一次回應的 `next` 值作為 `since` 傳入，以取得僅有的新行。 |
| `screenshot` | 裝置螢幕，以 PNG 圖片形式呈現。 |

`evaluate` 和 `console_logs` 需要 `list_pages` 中的 `page` 值。未傳入時使用前台頁面；有多個頁面在前台時會失敗，並列出可供選擇的頁面。

## 使用哪個裝置和頁面 {#which-device-and-which-pages}

工具始終使用頁面顯示的裝置。要切換裝置，請在頁面中切換。沒有開啟頁面時，使用閘道最後連接的裝置，沒有裝置時會提示。

頁面是裝置允許偵錯器查看的頁面：

- Android 模擬器和手機：Chrome 分頁，以及開啟 WebView 除錯的應用程式 WebView。
- iOS 模擬器：Safari 分頁，以及設定了 `isInspectable` 的 `WKWebView`（iOS 16.4 及更新版本）。

## 與 H5 主控台一起使用 {#using-it-next-to-the-h5-console}

AI 客戶端和頁面的 H5 主控台可以同時對同一個頁面進行除錯。客戶端記錄的內容也會出現在 H5 主控台中。

在 iOS 模擬器頁面上開啟或關閉 H5 主控台（該頁面也被客戶端使用時），閘道會重新開啟頁面的除錯連線，使主控台可以全新啟動而不留任何殘留（例如下一頁載入前的暫停）。此時正在執行的工具呼叫會失敗；客戶端可以再次執行。

閘道重新啟動時（例如為了更新自己），`droidpier mcp` 會繼續執行，並在閘道恢復後（最多一分鐘內）重新連接。此時正在執行的呼叫會失敗。

## 安全性 {#security}

`droidpier mcp` 透過 Unix socket `~/Library/Application Support/Droidpier/mcp-<port>.sock` 與閘道通訊。只有你的 macOS 使用者才能開啟其資料夾。閘道不會為它開放任何網路連接埠，網頁也無法存取它。

任何以你的使用者身分執行的程式都可以使用這個 socket，就像可以自行執行 `adb` 或 `simctl` 一樣。擁有這些工具的客戶端可以在你裝置的 H5 頁面中執行任意 JavaScript，包括你已登入的頁面。請以管理其他可執行程式碼工具的方式來管理客戶端的這些工具。

閘道的其他安全性說明請參閱[安全性](/zh-tw/docs/reference/security/)。

## 疑難排解 {#troubleshooting}

| 問題 | 解決方法 |
|---|---|
| `droidpier mcp` 因閘道未執行而退出 | 以 `droidpier start` 啟動閘道，然後重新連接客戶端。 |
| 工具顯示沒有裝置連接 | 開啟頁面並切換到裝置。 |
| 工具找不到頁面 | 再次執行 `list_pages`：頁面會隨著應用程式開啟和關閉而出現和消失。 |
| 工具在 iOS 頁面上逾時 | 頁面可能在偵錯器中暫停，例如在 H5 主控台的中斷點處。請在那裡繼續執行。 |
