import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLang, setLangSource, t } from "../i18n.ts";

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
