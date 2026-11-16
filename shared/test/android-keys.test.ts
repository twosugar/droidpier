import { test } from "node:test";
import assert from "node:assert/strict";
import { androidKeycode } from "../android-keys.ts";
import { TOOL_KEYS } from "../../host/src/webmcp.ts";

test("androidKeycode：页面能发出的键名都有 keycode", () => {
  for (const k of [...TOOL_KEYS, "Home", "End", "PageUp", "PageDown"]) assert.equal(typeof androidKeycode(k), "number", k);
});

test("androidKeycode：返回 / 主页 / 最近 / 回车 / 删除的值", () => {
  assert.deepEqual(["GoBack", "GoHome", "AppSwitch", "Enter", "Backspace", "Delete"].map(androidKeycode), [4, 3, 187, 66, 67, 112]);
});

test("androidKeycode：不认识的键名返回 null", () => {
  assert.equal(androidKeycode("F5"), null);
  assert.equal(androidKeycode("toString"), null);
});
