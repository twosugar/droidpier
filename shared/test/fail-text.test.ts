import { test } from "node:test";
import assert from "node:assert/strict";
import { failText } from "../fail-text.ts";
import { setLangSource } from "../i18n.ts";

test("failText：有原因时写原因", () => {
  assert.equal(failText("Not deleted", "device running"), "Not deleted: device running");
});

test("failText：没有原因或只有「未知原因」时给下一步，不停在「未知原因」；中文界面用中文标点和说法", () => {
  for (const e of [undefined, null, "", "  ", "未知原因", "Unknown reason"]) {
    const t = failText("Not stopped", e);
    assert.ok(t.startsWith("Not stopped, reason unknown. "), t);
    assert.ok(t.includes("droidpier logs"));
    assert.ok(!/未知原因|Unknown reason/.test(t));
  }
  setLangSource(() => "zh");
  try {
    assert.equal(failText("没有删除", "设备正在运行"), "没有删除：设备正在运行");
    assert.ok(failText("没有停止", null).startsWith("没有停止，原因不明。请再试一次"));
  } finally {
    setLangSource(() => "en");
  }
});
