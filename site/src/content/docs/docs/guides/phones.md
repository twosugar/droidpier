---
title: Phones
description: Use an Android phone over USB in the page - what it needs, how to switch to it, and what works differently from an emulator.
---

Besides Android virtual devices, the page can show a real Android phone that is plugged into your Mac with a USB cable. The page still shows one device at a time: the phone or an emulator.

## What you need

- A USB cable that carries data, not only charging.
- Android 5.0 (API 21) or later. This is what the bundled scrcpy server needs.
- USB debugging turned on in the phone's developer options.
- The first time you plug the phone in, the phone asks whether to allow USB debugging from this Mac. Allow it.
- `platform-tools` (`adb`) on the Mac. A phone needs neither the emulator nor a system image. See [Requirements](/docs/getting-started/requirements/#phones).

## The phone list

Phones appear in a group of their own in the device list, below the virtual devices. Each row shows the phone's maker and model, its Android version, and its state:

- **Ready**: click the row to switch to the phone.
- **Unauthorized**: the phone has not allowed this Mac yet. Allow USB debugging on the phone.
- **Offline**: adb sees the phone but cannot talk to it. Unplug it and plug it in again.

With no phone plugged in, the group says to plug one in and turn on USB debugging.

## Switch to a phone

Plugging in a phone does not switch the page to it: you might only be charging it. Click the phone in the list to switch. The gateway then copies the scrcpy server to the phone over adb and starts it. The server streams the screen and takes the input. It deletes itself from the phone when the connection ends, and nothing stays installed on the phone.

While the page shows the phone, its screen stays on.

## What works

The page works with a phone the same way it works with an emulator:

- the screen, scaled so that its long side is at most 1920 pixels;
- clicking and dragging, wheel and trackpad scrolling (sent to the phone as real scroll events), and typing, including Chinese (Chinese and other non-ASCII text needs Android 7.0 or later);
- the clipboard in both directions;
- Back, Home, Recents, volume and power;
- screenshots, at the phone's full resolution;
- installing an APK or copying a file by dropping it on the screen;
- H5 debugging of WebView pages;
- the log panel;
- the AI tools in the browser.

## What is different

- **Rotation** follows the phone itself. There is no rotate key.
- **There is no stop key**: the page cannot turn a phone off.
- **Restart** reboots the phone after you confirm. The page shows that the phone is restarting, then connects again by itself once the phone has booted, usually within a minute. If the phone has a lock screen, unlock it on the page.
- **Unplugging** the phone shows that the phone is disconnected. Plug it in again and the page connects again by itself.
- **The status line** shows the frame rate but not the latency. The phone's clock differs from the Mac's, so the two cannot be compared.

## Only phones, no emulator

If you only use phones, you need only `platform-tools`. Once it is installed and you have no virtual device, the page does not show the setup check by itself, even though the emulator and a system image are missing. To set up an emulator later, click the button under the empty device list. It names how many items are missing and opens the setup check, where you install them.

Without `platform-tools`, the Phones group asks you to install it first, from the setup check.
