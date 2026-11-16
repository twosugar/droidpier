import { test } from "node:test";
import assert from "node:assert/strict";
import { phoneDetail, phoneLabel, phoneStatus, showPhones } from "../../ui/phones.ts";

test("phoneLabel：厂商首字母大写加型号", () => {
  assert.equal(phoneLabel({ id: "R5CR10WN52H", state: "device", manufacturer: "samsung", model: "SM-G9910" }), "Samsung SM-G9910");
});

test("phoneLabel：只有型号时用型号，都没有时用设备 id", () => {
  assert.equal(phoneLabel({ id: "R5CR10WN52H", state: "device", model: "SM-G9910" }), "SM-G9910");
  assert.equal(phoneLabel({ id: "R5CR10WN52H", state: "unauthorized" }), "R5CR10WN52H");
});

test("phoneStatus：三种状态的文案", () => {
  assert.equal(phoneStatus({ id: "a", state: "device" }), "已连接，暂不能操作");
  assert.equal(phoneStatus({ id: "a", state: "unauthorized" }), "请在手机上允许 USB 调试");
  assert.equal(phoneStatus({ id: "a", state: "offline" }), "离线，重新插拔试试");
});

test("phoneDetail：只显示版本号，和模拟器行右侧的「15」一致", () => {
  assert.equal(phoneDetail({ id: "a", state: "device", android: "12" }), "12");
  assert.equal(phoneDetail({ id: "a", state: "unauthorized" }), "");
});

test("showPhones：没收到过列表时不显示分组；空列表也显示（提示插手机）", () => {
  assert.equal(showPhones(null), false);
  assert.equal(showPhones([]), true);
});
