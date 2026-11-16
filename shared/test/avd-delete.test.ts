import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceLive } from "../../ui/avd-delete.ts";

test("deviceLive：运行中（含无法接管）和开机中的设备算在运行，能停止，删除前要先停", () => {
  assert.equal(deviceLive({ running: "no" }, false), false);
  assert.equal(deviceLive({ running: "grpc" }, false), true);
  assert.equal(deviceLive({ running: "no-grpc" }, false), true);
  assert.equal(deviceLive({ running: "no" }, true), true);
});
