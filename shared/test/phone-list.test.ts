import { test } from "node:test";
import assert from "node:assert/strict";
import { createPhoneList } from "../../host/src/phone-list.ts";
import type { PhoneInfo } from "../../shared/protocol.ts";

const PHONE: PhoneInfo = { id: "R5CR10WN52H", state: "device", model: "SM-G9910" };

test("收到真机列表：记下并通知页面", () => {
  const shown: Array<PhoneInfo[] | null> = [];
  const pl = createPhoneList((l) => shown.push(l));
  pl.onPhones([PHONE]);
  assert.deepEqual(pl.current(), [PHONE]);
  assert.deepEqual(shown, [[PHONE]]);
});

test("和网关断开后清空：页面不再显示旧的真机，快照里也是 null", () => {
  const shown: Array<PhoneInfo[] | null> = [];
  const pl = createPhoneList((l) => shown.push(l));
  pl.onPhones([PHONE]);
  pl.onDisconnect();
  assert.equal(pl.current(), null);
  assert.deepEqual(shown.at(-1), null);
});

test("从没收到过列表时断开，不多发通知", () => {
  const shown: Array<PhoneInfo[] | null> = [];
  const pl = createPhoneList((l) => shown.push(l));
  pl.onDisconnect();
  assert.deepEqual(shown, []);
});
