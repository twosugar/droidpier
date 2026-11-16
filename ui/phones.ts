// 侧栏「真机」分组的文案：真机这一版只列出来，不能连
import type { PhoneInfo } from "../shared/protocol";

/** 行标题：「Samsung SM-G9910」；没查到型号时用设备 id。 */
export function phoneLabel(p: PhoneInfo): string {
  if (!p.model) return p.id;
  if (!p.manufacturer) return p.model;
  return `${p.manufacturer.charAt(0).toUpperCase()}${p.manufacturer.slice(1)} ${p.model}`;
}

const STATUS: Record<PhoneInfo["state"], string> = {
  device: "已连接，暂不能操作",
  unauthorized: "请在手机上允许 USB 调试",
  offline: "离线，重新插拔试试",
};

/** 行副标题：连接状态和用户该做什么。 */
export function phoneStatus(p: PhoneInfo): string {
  return STATUS[p.state];
}

/** 行右侧的 Android 版本号，和模拟器行右侧的「15」同一写法；不知道时为空。 */
export function phoneDetail(p: PhoneInfo): string {
  return p.android ?? "";
}

/** 没收到过 phones 消息（旧网关、没带 --phones）就不显示分组；收到过空列表要显示，提示插手机。 */
export function showPhones(list: PhoneInfo[] | null): boolean {
  return list !== null;
}
