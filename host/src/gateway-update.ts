// 网关比页面旧时页面上显示什么、要不要让网关马上检查更新。网关在 hello 后的 gateway 消息里报功能级别（shared/protocol.ts 的 GATEWAY_LEVEL）。
import { updateFailureMsg, type UpdateState } from "../../shared/protocol.ts";
import { t, type Msg } from "../../shared/i18n.ts";

/** gateway 消息的内容；null 表示旧网关（hello 后没发 gateway 就发了别的）。 */
export type GatewayInfo = { level: number; version: string; service: boolean; autoUpdate: boolean };
export type UpdateReport = { state: UpdateState; message?: string };
/** 画面上方的提示：updating 网关在自己更新，manual 要用户运行安装命令。 */
export type GatewayBanner = { kind: "updating" | "manual"; text: string; command?: string };

/** 网关的功能级别低于 level：旧网关算 0。 */
export const gatewayBelow = (info: GatewayInfo | null, level: number) => (info?.level ?? 0) < level;

/** 网关比页面旧，而且它是开着自动更新的后台服务：页面让它马上检查一次。 */
export const shouldRequestUpdate = (info: GatewayInfo | null, pageLevel: number) =>
  info !== null && gatewayBelow(info, pageLevel) && info.service && info.autoUpdate;


/** 网关不比页面旧时返回 null。report 是网关对 update 的最近一次回复；command 是这个站点的安装命令。 */
export function gatewayBanner(info: GatewayInfo | null, pageLevel: number, report: UpdateReport | null, command: string): GatewayBanner | null {
  const manual = (text: string): GatewayBanner => ({ kind: "manual", text, command });
  if (!gatewayBelow(info, pageLevel)) return null;
  if (!info || !info.service) return manual(t({ en: "The gateway is out of date, run the install command to update", zh: "网关版本较旧，请运行安装命令更新" }));
  if (!info.autoUpdate) return manual(t({ en: "The gateway is out of date; auto-update is off, run the install command to update", zh: "网关版本较旧，自动更新已关闭，请运行安装命令更新" }));
  switch (report?.state) {
    case undefined:
    case "checking":
    case "restarting":
      return { kind: "updating", text: t({ en: "Gateway has a new version, updating automatically…", zh: "网关有新版本，正在自动更新…" }) };
    case "deferred": {
      const reason = report.message;
      return {
        kind: "updating",
        text: reason
          ? t({ en: `Gateway has a new version; waiting for "${reason}" to finish, then updating automatically`, zh: `网关有新版本，${reason}，结束后自动更新` })
          : t({ en: "Gateway has a new version; an operation is in progress, will update automatically once done", zh: "网关有新版本，有操作在进行，结束后自动更新" }),
      };
    }
    case "latest":
      return manual(t({ en: "The gateway is out of date; no new version on the download site yet, will retry automatically; or run the install command to update", zh: "网关版本较旧，下载站上暂时还没有新版本，稍后会自动再试；也可以运行安装命令更新" }));
    case "failed": {
      const fmsg = updateFailureMsg(report.message);
      return manual(t({ en: `Gateway auto-update failed: ${fmsg.en}. Run the install command to update`, zh: `网关自动更新失败：${fmsg.zh}。请运行安装命令更新` }));
    }
    case "off":
      return manual(t({ en: "The gateway is out of date, run the install command to update", zh: "网关版本较旧，请运行安装命令更新" }));
  }
}

/** 网关太旧、不支持某个操作时的话，带上更新网关的命令（command 是这个站点的安装命令）。 */
export const tooOldText = (what: Msg, command: string) =>
  t({ en: `The gateway is too old for ${what.en}. Run ${command} in Terminal to update it`, zh: `网关版本太旧，不支持${what.zh}。请在终端运行 ${command} 更新网关` });

/**
 * 请求超时（15 秒没回）时给用户看的话。网关功能级别低于这条消息要的级别时说它太旧、不支持；
 * 否则是网关真的慢（删大目录），slow 是那种情况的说明。
 */
export function timeoutText(info: GatewayInfo | null | undefined, level: number, what: Msg, slow: string, command: string): string {
  return info !== undefined && gatewayBelow(info, level) ? tooOldText(what, command) : slow;
}
