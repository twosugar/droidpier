---
title: AI clients (MCP)
description: Let an AI client such as Claude Code debug the H5 pages on the device the page shows, through the gateway's MCP server.
---

`droidpier mcp` connects an AI client that speaks the Model Context Protocol (MCP), such as Claude Code, to the gateway. The client can then look at the device the page shows: list its H5 pages, run JavaScript in one, read its console and take a screenshot.

The client goes through the gateway instead of opening its own debugging connection. This matters on iOS simulators: WebKit lets only one debugger at a time attach to a page, so a separate tool (such as iwdp) and the page's H5 console push each other off. Through the gateway, the AI client and the H5 console share one connection.

## What you need

- The gateway running, in the background (`droidpier start`) or in a Terminal window. The background gateway updates itself; MCP needs a version published on 2026-11-24 or later. Run the install command again to update a gateway that runs in a Terminal window.
- The page open, showing the device you want the client to use.

## Add it to your client

In Claude Code, add it once:

```sh
claude mcp add droidpier -- droidpier mcp
```

Start a new Claude Code session afterwards: the tools appear as `mcp__droidpier__…`.

Other clients take a server that runs as a command and talks over standard input and output. Give the full path of the executable, since an app started from the Dock may not have `~/.local/bin` in its `PATH`:

```json
{
  "mcpServers": {
    "droidpier": { "command": "/Users/<you>/.local/bin/droidpier", "args": ["mcp"] }
  }
}
```

If the gateway runs on another port, add it: `droidpier mcp --port 7310`.

## The tools

| Tool | What it does |
|---|---|
| `device_status` | The device the page shows: name, platform (`android` or `ios`), kind and screen size in pixels. |
| `list_pages` | The H5 pages on that device, each with a `page` value, title, address, app and whether it is in the foreground. |
| `evaluate` | Runs a JavaScript expression in a page and returns the result as JSON. It waits for a promise. When the expression throws, the tool fails with the error. |
| `console_logs` | The console output and uncaught errors of a page. Collecting starts the first time a tool uses that page; on iOS simulators it also includes the messages logged before. It keeps the last 500. Pass the `next` value of the previous answer as `since` to get only new lines. |
| `screenshot` | The device screen, as a PNG image. |

`evaluate` and `console_logs` take the `page` value from `list_pages`. Without it they use the page in the foreground; when several pages are in the foreground, they fail and list the pages to choose from.

## Which device and which pages

The tools always use the device the page shows. To use another device, switch to it in the page. With no page open, they use the device the gateway connected to last, and say so when there is none.

The pages are the ones the device lets a debugger see:

- On Android emulators and phones: Chrome tabs, and WebViews of apps that turn on WebView debugging.
- On iOS simulators: Safari tabs, and `WKWebView`s that set `isInspectable` (iOS 16.4 and later).

## Using it next to the H5 console

The AI client and the page's H5 console can debug the same page at once. What the client logs shows up in the H5 console too.

When you open or close the H5 console on an iOS simulator page that the client also uses, the gateway reopens the page's debugging connection so that the console starts clean and leaves nothing behind (such as a pause before the next page loads). A tool call running at that moment fails; the client can run it again.

When the gateway restarts, for example to update itself, `droidpier mcp` keeps running and connects again when the gateway is back, for up to a minute. A call running at that moment fails.

## Security

`droidpier mcp` reaches the gateway through a Unix socket, `~/Library/Application Support/Droidpier/mcp-<port>.sock`. Only your macOS user can open its folder. The gateway opens no network port for it, and web pages cannot reach it.

Any program that runs as your user can use the socket, like it could run `adb` or `simctl` itself. A client with these tools can run any JavaScript in the H5 pages of your devices, including pages where you are signed in. Allow the tools in your client the way you allow other tools that run code.

See [Security](/docs/reference/security/) for the rest of the gateway.

## Troubleshooting

| Problem | What to do |
|---|---|
| `droidpier mcp` exits because the gateway is not running | Start the gateway with `droidpier start`, then reconnect the client. |
| The tools say no device is connected | Open the page and switch to a device. |
| A tool cannot find a page | Run `list_pages` again: pages come and go as apps open and close them. |
| A tool times out on an iOS page | The page may be paused in the debugger, for example at a breakpoint in the H5 console. Resume it there. |
