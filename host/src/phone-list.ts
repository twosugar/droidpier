import type { PhoneInfo } from "../../shared/protocol.ts";

/**
 * 真机列表的当前值：null 表示网关没发过（旧网关、没带 --phones）或已断开。
 * 断开时必须清空：换上不带 --phones 的网关后不会再有 phones 消息来覆盖旧列表，页面会一直显示「已连接」。
 */
export function createPhoneList(show: (list: PhoneInfo[] | null) => void) {
  let list: PhoneInfo[] | null = null;
  return {
    onPhones(next: PhoneInfo[]) {
      list = next;
      show(list);
    },
    onDisconnect() {
      if (list === null) return;
      list = null;
      show(null);
    },
    current: () => list,
  };
}
