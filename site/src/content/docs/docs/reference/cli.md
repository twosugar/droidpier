---
title: Command line
description: Options and environment variables for the Droidpier gateway command.
---

<!-- verify: phase 3 -->
```sh
droidpier start [--port <port>] [--local] [--no-open] [--no-auto-update]
droidpier stop
droidpier status
droidpier logs
droidpier [--port <port>] [--local] [--no-open]
```

| Command | Effect |
|---|---|
| `droidpier start` | Run the gateway in the background, as a macOS LaunchAgent. It keeps running after you close Terminal, starts again when you log in, and restarts if it crashes. If it is already running, it restarts. It saves the options you give; without options, it keeps the saved ones. It opens the page once unless you pass `--no-open`. It also keeps itself up to date: see [Automatic updates](#automatic-updates). |
| `droidpier stop` | Stop the background gateway. It no longer starts when you log in. |
| `droidpier status` | Show whether the background gateway runs, with its process ID, port, version and log file. It also shows whether automatic updates are on, with the result of the last check. |
| `droidpier logs` | Print the log file path and its last 50 lines. |
| `droidpier` | Run the gateway in this Terminal window until you press `Ctrl+C`. |

Stopping the gateway does not stop running emulators.

## Start with the install command

The install command, `curl -fsSL https://droid.devpier.dev/install.sh | sh`, installs or updates the gateway, then runs `droidpier start`. To pass options to it, put them after `sh -s --`. They are saved for the background gateway:

```sh
curl -fsSL https://droid.devpier.dev/install.sh | sh -s -- --port 7310
```

To install or update without starting the gateway, set `DROIDPIER_NO_START=1`:

```sh
curl -fsSL https://droid.devpier.dev/install.sh | DROIDPIER_NO_START=1 sh
```

To run the gateway in the Terminal window instead, as before, set `DROIDPIER_FOREGROUND=1`:

```sh
curl -fsSL https://droid.devpier.dev/install.sh | DROIDPIER_FOREGROUND=1 sh
```

## Options

| Option | Default | Effect |
|---|---|---|
| `--port <port>` | `7300` | The port the gateway listens on, on `127.0.0.1` only. |

<!-- verify: phase 3 -->
| Option | Default | Effect |
|---|---|---|
| `--local` | off | Open the page the gateway serves itself, `http://127.0.0.1:<port>/app/`, instead of the public page on `droid.devpier.dev`. |
| `--no-open` | off | Do not open the browser on start. The gateway still prints the address. |
| `--no-auto-update` | off | For `droidpier start`: do not update the background gateway automatically. In Terminal: do not print a line when a new version exists. |

With or without `--no-open`, the page finds the gateway by itself. See [First run](/docs/getting-started/first-run/#3-open-the-page).

## Environment variables

| Variable | Effect |
|---|---|
| `ANDROID_HOME` | The Android SDK directory. Without it, the gateway uses `~/Library/Android/sdk`. |
| `ANDROID_AVD_HOME` | The directory that holds AVDs. Without it, the gateway uses `avd` inside `ANDROID_USER_HOME` when that holds AVDs, otherwise `~/.android/avd`. The gateway passes the result to the emulators it starts. |
| `ANDROID_USER_HOME` | The Android user directory. Without it, the gateway uses `~/.android`. |
| `DEBUG=1` | Print one line per second for each connection: frames received, sent and dropped, average frame size, and the delay from the emulator to the gateway. |

<!-- verify: phase 2 -->
`ANDROID_AVD_HOME` is read when the gateway lists devices.

<!-- verify: phase 3 -->
`ANDROID_HOME` is read by the first-run check.

`droidpier start` saves `ANDROID_HOME`, `ANDROID_AVD_HOME` and `ANDROID_USER_HOME` for the background gateway when they are set, because launchd does not read your shell profile. Run `droidpier start` again after you change them.

## What it prints

On start, the gateway prints the address of the page. If no emulator is running, it prints the reason and keeps running.

<!-- verify: phase 3 -->
By default the printed address is the public page, `https://droid.devpier.dev/app/`. When the gateway does not run on port `7300`, the address ends in `#port=<port>`. With `--local`, it is the local page, `http://127.0.0.1:<port>/app/`. The gateway opens the address with the macOS `open` command unless you pass `--no-open`.

If a gateway is already running on the port, a second one does not start. It prints that droidpier is already running, with the port, and opens the page. If the running one is the background gateway, it also prints `droidpier stop`. If another program uses the port, it says so, suggests another port, and exits.

<!-- verify: phase 3 -->
When Android SDK parts are missing, the gateway lists each one with a command to install it by hand, and tells you to finish the setup on the page. It never asks anything in Terminal: installs, new devices and licenses are confirmed on the page. See [First run](/docs/getting-started/first-run/#2-let-it-check-your-android-sdk).

## Files and ports it uses

| What | Where |
|---|---|
| Gateway listen address | `127.0.0.1:<port>` |
| Running emulator discovery | `~/Library/Caches/TemporaryItems/avd/running/pid_<pid>.ini` |

<!-- verify: phase 2 -->
| What | Where |
|---|---|
| Emulator gRPC ports it assigns | The first free even port from `8554` |

<!-- verify: phase 3 -->
| What | Where |
|---|---|
| Installed executable | `~/.local/bin/droidpier` |
| Checksum of the installed version | `~/.local/share/droidpier/installed.sha256` |
| Background gateway settings | `~/Library/LaunchAgents/dev.devpier.droidpier.plist` |
| Background gateway log | `~/Library/Logs/Droidpier/droidpier.log` |

## Automatic updates

The background gateway keeps itself up to date. When it starts, and about every 30 minutes after that, it compares the checksum of the published version with the one of the installed version (`~/.local/share/droidpier/installed.sha256`). When a new version is published, it downloads it from `droid.devpier.dev`, checks the checksum before unpacking, replaces `~/.local/bin/droidpier` and restarts. Open pages reconnect by themselves. It waits while an SDK install, a device start, a device deletion, an emulator restart or a file transfer is in progress. If the download fails or the checksum does not match, it keeps running the version you have and tries again later. Each step is written to the log (`droidpier logs`).

The gateway takes only versions signed with the Droidpier release key, and only versions newer than the one it runs. It keeps the previous version as `~/.local/bin/droidpier.prev`. If a new version fails to start three times in a row, the gateway switches back to the previous version and does not take that version again.

When the page finds that the background gateway is older than the page, it asks the gateway to check at once and shows that the gateway is updating.

To turn automatic updates off, run `droidpier start --no-auto-update`. To turn them on again, run `droidpier start` with your other options and without `--no-auto-update`, for example `droidpier start --port 7300`. `droidpier status` shows whether they are on.

A gateway that runs in a Terminal window (`droidpier`) does not replace itself. When a new version exists, it prints one line: run `droidpier start` to switch to the background gateway, which updates itself, or run the install command again.

## Uninstall

Stop the background gateway, then delete the files it uses:

```sh
droidpier stop
rm -f ~/.local/bin/droidpier ~/.local/bin/droidpier.prev
rm -r ~/.local/share/droidpier ~/Library/Logs/Droidpier
```

If `droidpier` is already deleted but the background gateway still runs or starts when you log in, remove it by hand:

```sh
launchctl bootout gui/$(id -u)/dev.devpier.droidpier
rm ~/Library/LaunchAgents/dev.devpier.droidpier.plist
```
