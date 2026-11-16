// 侧栏「真机」分组的文案：可用的手机能点开看画面，操作还不支持（PR 4）
import type { PhoneInfo } from "../shared/protocol";

/** 行标题：「Samsung SM-G9910」；没查到型号时用设备 id。 */
export function phoneLabel(p: PhoneInfo): string {
  if (!p.model) return p.id;
  if (!p.manufacturer) return p.model;
  return `${p.manufacturer.charAt(0).toUpperCase()}${p.manufacturer.slice(1)} ${p.model}`;
}

const STATUS: Record<Exclude<PhoneInfo["state"], "device">, string> = {
  unauthorized: "请在手机上允许 USB 调试",
  offline: "离线，重新插拔试试",
};

/** 行副标题：连接状态和用户该做什么；current 表示它就是主区正在显示的设备。 */
export function phoneStatus(p: PhoneInfo, current: boolean): string {
  if (p.state === "device") return current ? "当前画面" : "可用，点一下切换";
  return STATUS[p.state];
}

/** 只有 adb 状态为 device 的手机能切过去。 */
export function canPick(p: PhoneInfo): boolean {
  return p.state === "device";
}

/** 行右侧的 Android 版本号，和模拟器行右侧的「15」同一写法；不知道时为空。 */
export function phoneDetail(p: PhoneInfo): string {
  return p.android ?? "";
}

/** 没收到过 phones 消息（旧网关、没带 --phones）就不显示分组；收到过空列表要显示，提示插手机。 */
export function showPhones(list: PhoneInfo[] | null): boolean {
  return list !== null;
}
