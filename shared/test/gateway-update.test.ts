import { test } from "node:test";
import assert from "node:assert/strict";
import { gatewayBanner, shouldRequestUpdate, timeoutText, type GatewayInfo } from "../../host/src/gateway-update.ts";
import { installCmd, OFFICIAL_ORIGIN } from "../protocol.ts";

const INSTALL_CMD = installCmd(OFFICIAL_ORIGIN);

const svc = (level: number, autoUpdate = true): GatewayInfo => ({ level, version: "2026-11-13T00:00:00.000Z", service: true, autoUpdate });

test("网关不比页面旧时不提示、不请求更新", () => {
  assert.equal(gatewayBanner(svc(2), 2, null, INSTALL_CMD), null);
  assert.equal(gatewayBanner(svc(3), 2, null, INSTALL_CMD), null);
  assert.equal(shouldRequestUpdate(svc(2), 2), false);
});

test("开着自动更新的后台服务比页面旧：请求更新，提示正在自动更新", () => {
  assert.equal(shouldRequestUpdate(svc(1), 2), true);
  for (const r of [null, { state: "checking" as const }, { state: "restarting" as const }]) {
    assert.deepEqual(gatewayBanner(svc(1), 2, r, INSTALL_CMD), { kind: "updating", text: "Gateway has a new version, updating automatically…" });
  }
  assert.deepEqual(gatewayBanner(svc(1), 2, { state: "deferred", message: "正在安装 SDK" }, INSTALL_CMD), { kind: "updating", text: "Gateway has a new version; waiting for \"正在安装 SDK\" to finish, then updating automatically" });
});

test("前台运行、关了自动更新、旧到没有 gateway 消息：给安装命令，不请求更新", () => {
  const fg: GatewayInfo = { level: 1, version: "", service: false, autoUpdate: false };
  for (const info of [fg, svc(1, false), null]) {
    assert.equal(shouldRequestUpdate(info, 2), false);
    const b = gatewayBanner(info, 2, null, INSTALL_CMD);
    assert.equal(b?.kind, "manual");
    assert.equal(b?.command, INSTALL_CMD);
  }
  assert.equal(gatewayBanner(fg, 2, null, INSTALL_CMD)?.text, "Gateway is outdated, run the install command to update");
});

test("自动更新没成（下载站还没新版本、失败）时改成给安装命令", () => {
  assert.equal(gatewayBanner(svc(1), 2, { state: "latest" }, INSTALL_CMD)?.kind, "manual");
  const b = gatewayBanner(svc(1), 2, { state: "failed", message: "signature" }, INSTALL_CMD);
  assert.equal(b?.kind, "manual");
  assert.match(b!.text, /signature of the version on the download site is wrong/);
});

test("timeoutText：网关级别不够时说太旧不支持，并给出更新的命令；够或还不知道时用原来的说明", () => {
  const cmd = "curl -fsSL https://droid.devpier.dev/install.sh | sh";
  const old = `Gateway is too old to support delete device. Run ${cmd} in Terminal to update`;
  assert.equal(timeoutText(null, 1, { en: "delete device", zh: "删除设备" }, "slow", cmd), old);
  assert.equal(timeoutText(svc(0), 1, { en: "delete device", zh: "删除设备" }, "slow", cmd), old);
  assert.equal(timeoutText(svc(1), 1, { en: "delete device", zh: "删除设备" }, "slow", cmd), "slow");
  assert.equal(timeoutText(undefined, 1, { en: "delete device", zh: "删除设备" }, "slow", cmd), "slow");
});
