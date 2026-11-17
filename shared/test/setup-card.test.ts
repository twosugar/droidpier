import { test } from "node:test";
import assert from "node:assert/strict";
import { emulatorButtonShown, missingEmulatorItems, setupCardShown, setupNeeded } from "../../ui/setup-card.ts";
import type { EnvMissing } from "../protocol.ts";

const base = { ok: true, needed: true, wanted: false, busy: false, failed: false, hasInstalls: false, dismissed: false };

test("环境齐全、没装过东西：不显示", () => {
  assert.equal(setupCardShown(base), false);
});

test("缺项时显示；收起后不再显示，不挡设备按键", () => {
  assert.equal(setupCardShown({ ...base, ok: false }), true);
  assert.equal(setupCardShown({ ...base, ok: false, dismissed: true }), false);
});

test("安装进行中一直显示，收起也不隐藏", () => {
  assert.equal(setupCardShown({ ...base, ok: false, busy: true, hasInstalls: true, dismissed: true }), true);
});

test("安装失败后显示，收起后不再显示", () => {
  assert.equal(setupCardShown({ ...base, ok: false, failed: true, hasInstalls: true }), true);
  assert.equal(setupCardShown({ ...base, ok: false, failed: true, hasInstalls: true, dismissed: true }), false);
});

test("装完、环境齐全：显示结果，收起后不再显示", () => {
  assert.equal(setupCardShown({ ...base, hasInstalls: true }), true);
  assert.equal(setupCardShown({ ...base, hasInstalls: true, dismissed: true }), false);
});

const item = (id: EnvMissing["id"]): EnvMissing => ({ id, detail: "", auto: true });

test("setupNeeded：缺 adb 时需要；只缺模拟器相关项、本机没有设备时不需要", () => {
  assert.equal(setupNeeded({ missing: [item("platform-tools"), item("emulator")] }, 0), true);
  assert.equal(setupNeeded({ missing: [item("emulator"), item("system-image"), item("avd")] }, 0), false);
});

test("setupNeeded：本机已有模拟器设备时缺什么都需要（比如系统镜像被删）", () => {
  assert.equal(setupNeeded({ missing: [item("emulator"), item("system-image"), item("avd")] }, 1), true);
});

test("setupNeeded：检查出错时需要，什么都不缺时不需要", () => {
  assert.equal(setupNeeded({ missing: [], error: "读不到 SDK 目录" }, 0), true);
  assert.equal(setupNeeded({ missing: [] }, 3), false);
});

test("不需要自动出现时不显示；用户主动要看时显示，收起后不再显示", () => {
  assert.equal(setupCardShown({ ...base, ok: false, needed: false }), false);
  assert.equal(setupCardShown({ ...base, ok: false, needed: false, wanted: true }), true);
  assert.equal(setupCardShown({ ...base, ok: false, needed: false, wanted: true, dismissed: true }), false);
});

test("不需要自动出现时，安装失败仍然显示", () => {
  assert.equal(setupCardShown({ ...base, ok: false, needed: false, failed: true, hasInstalls: true }), true);
});

test("missingEmulatorItems：数 platform-tools 以外的缺项", () => {
  assert.equal(missingEmulatorItems({ missing: [item("platform-tools"), item("emulator"), item("avd")] }), 2);
});

test("setupNeeded：设备列表是空的（没装模拟器程序列不出来），但环境检查数到 AVD 时仍算模拟器用户", () => {
  assert.equal(setupNeeded({ missing: [item("emulator"), item("system-image")], avds: 2 }, 0), true);
});

test("emulatorButtonShown：只在卡片因为只缺模拟器项而没自己弹出时给按钮", () => {
  const phoneOnly = { ok: false, missing: [item("emulator"), item("system-image"), item("avd")] };
  assert.equal(emulatorButtonShown(phoneOnly, 0, false), true);
  assert.equal(emulatorButtonShown(phoneOnly, 0, true), false);
  // 新机器缺 adb、收起了卡片：不给「安装模拟器（缺 N 项）」，那会漏掉 adb
  assert.equal(emulatorButtonShown({ ok: false, missing: [item("platform-tools"), item("emulator")] }, 0, false), false);
  // 检查出错、什么都没列：不给「缺 0 项」
  assert.equal(emulatorButtonShown({ ok: false, missing: [], error: "读不到 SDK 目录" }, 0, false), false);
  assert.equal(emulatorButtonShown({ ok: true, missing: [] }, 0, false), false);
});
