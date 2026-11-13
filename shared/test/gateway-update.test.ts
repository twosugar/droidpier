import { test } from "node:test";
import assert from "node:assert/strict";
import { gatewayBanner, shouldRequestUpdate, timeoutText, type GatewayInfo } from "../../host/src/gateway-update.ts";
import { INSTALL_CMD } from "../protocol.ts";

const svc = (level: number, autoUpdate = true): GatewayInfo => ({ level, version: "2026-11-13T00:00:00.000Z", service: true, autoUpdate });

test("网关不比页面旧时不提示、不请求更新", () => {
  assert.equal(gatewayBanner(svc(2), 2, null), null);
  assert.equal(gatewayBanner(svc(3), 2, null), null);
  assert.equal(shouldRequestUpdate(svc(2), 2), false);
});

test("开着自动更新的后台服务比页面旧：请求更新，提示正在自动更新", () => {
  assert.equal(shouldRequestUpdate(svc(1), 2), true);
  for (const r of [null, { state: "checking" as const }, { state: "restarting" as const }]) {
    assert.deepEqual(gatewayBanner(svc(1), 2, r), { kind: "updating", text: "网关有新版本，正在自动更新…" });
  }
  assert.deepEqual(gatewayBanner(svc(1), 2, { state: "deferred", message: "正在安装 SDK" }), { kind: "updating", text: "网关有新版本，正在安装 SDK，结束后自动更新" });
});

test("前台运行、关了自动更新、旧到没有 gateway 消息：给安装命令，不请求更新", () => {
  const fg: GatewayInfo = { level: 1, version: "", service: false, autoUpdate: false };
  for (const info of [fg, svc(1, false), null]) {
    assert.equal(shouldRequestUpdate(info, 2), false);
    const b = gatewayBanner(info, 2, null);
    assert.equal(b?.kind, "manual");
    assert.equal(b?.command, INSTALL_CMD);
  }
  assert.equal(gatewayBanner(fg, 2, null)?.text, "网关版本较旧，请运行安装命令更新");
});

test("自动更新没成（下载站还没新版本、失败）时改成给安装命令", () => {
  assert.equal(gatewayBanner(svc(1), 2, { state: "latest" })?.kind, "manual");
  const b = gatewayBanner(svc(1), 2, { state: "failed", message: "HTTP 503" });
  assert.equal(b?.kind, "manual");
  assert.match(b!.text, /HTTP 503/);
});

test("timeoutText：网关级别不够时说太旧不支持；够或还不知道时用原来的说明", () => {
  assert.equal(timeoutText(null, 1, "删除设备", "slow"), "网关版本太旧，不支持删除设备，请更新 droidpier");
  assert.equal(timeoutText(svc(0), 1, "删除设备", "slow"), "网关版本太旧，不支持删除设备，请更新 droidpier");
  assert.equal(timeoutText(svc(1), 1, "删除设备", "slow"), "slow");
  assert.equal(timeoutText(undefined, 1, "删除设备", "slow"), "slow");
});
