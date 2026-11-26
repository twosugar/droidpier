import { test } from "node:test";
import assert from "node:assert/strict";
import { localize, msgOf, parseLang, setLangSource, t, TextError, textOf } from "../i18n.ts";

test("parseLang：存的是 en / zh 就用它，没存过或不认识的都按英文", () => {
  assert.equal(parseLang("zh"), "zh");
  assert.equal(parseLang("en"), "en");
  assert.equal(parseLang(null), "en");
  assert.equal(parseLang("fr"), "en");
});

test("t：按当前语言取文字；默认英文，换了来源就跟着换", () => {
  const m = { en: "Install", zh: "安装" };
  assert.equal(t(m), "Install");
  let lang: "en" | "zh" = "zh";
  setLangSource(() => lang);
  assert.equal(t(m), "安装");
  lang = "en";
  assert.equal(t(m), "Install");
  setLangSource(() => "en");
});

test("localize：消息里所有 { en, zh } 换成这种语言的字符串（嵌套、数组里也换），别的原样", () => {
  const m = { t: "error", message: { en: "No device", zh: "没有设备" }, list: [{ name: "a", detail: { en: "x", zh: "叉" } }], n: 1, ok: true, none: null };
  assert.deepEqual(localize(m, "en"), { t: "error", message: "No device", list: [{ name: "a", detail: "x" }], n: 1, ok: true, none: null });
  assert.deepEqual(localize(m, "zh"), { t: "error", message: "没有设备", list: [{ name: "a", detail: "叉" }], n: 1, ok: true, none: null });
  // 只有恰好 en、zh 两个字符串字段的对象才算一段文字
  const other = { en: "a", zh: "b", extra: 1 };
  assert.deepEqual(localize({ v: other }, "en"), { v: other });
});

test("TextError：message 是中文（日志、旧代码照旧），msg 带两种语言；textOf 给出能放进消息的值", () => {
  const e = new TextError({ en: "Install failed", zh: "安装失败" });
  assert.equal(e.message, "安装失败");
  assert.deepEqual(textOf(e), { en: "Install failed", zh: "安装失败" });
  assert.equal(textOf(new Error("adb: device offline")), "adb: device offline");
});

test("msgOf：已经是两种语言的原样给出，只有原文的字符串两种语言都用它", () => {
  assert.deepEqual(msgOf("adb: offline"), { en: "adb: offline", zh: "adb: offline" });
  const m = { en: "a", zh: "甲" };
  assert.equal(msgOf(m), m);
});
