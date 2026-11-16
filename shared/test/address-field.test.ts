import { test } from "node:test";
import assert from "node:assert/strict";
import { addressShown, addressEdit, addressSubmit } from "../../ui/address-field.ts";

test("没在编辑时显示页面当前的地址，页面跳转了跟着变", () => {
  assert.equal(addressShown(null, "https://example.com/"), "https://example.com/");
  assert.equal(addressShown(null, "https://example.org/x"), "https://example.org/x");
  assert.equal(addressShown(null, undefined), "");
});

test("编辑中显示改的内容，页面地址变了也不覆盖", () => {
  const d = addressEdit("https://example.com/", "localhost:5173/a");
  assert.equal(addressShown(d, "https://example.org/"), "localhost:5173/a");
});

test("改回和当前地址一样等于没在编辑", () => {
  assert.equal(addressEdit("https://example.com/", "https://example.com/"), null);
});

test("回车：去掉首尾空白后要跳转的地址；空的、没改过的不跳", () => {
  assert.equal(addressSubmit("  localhost:5173/a "), "localhost:5173/a");
  assert.equal(addressSubmit("   "), null);
  assert.equal(addressSubmit(null), null);
});
