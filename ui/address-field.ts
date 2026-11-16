/** 控制台里的地址栏：draft 是用户改过、还没提交的内容，null 表示没在编辑、显示页面当前的地址。 */
export type AddressDraft = string | null;

export function addressShown(draft: AddressDraft, current: string | undefined): string {
  return draft ?? current ?? "";
}

/** 用户改了内容；改回当前地址就当没在编辑，页面跳转后照常跟着变。 */
export function addressEdit(current: string | undefined, value: string): AddressDraft {
  return value === (current ?? "") ? null : value;
}

/** 回车：要跳转的地址（去掉首尾空白）；没改过或是空的返回 null，不跳。Escape 放弃修改就是把 draft 设回 null。 */
export function addressSubmit(draft: AddressDraft): string | null {
  const v = draft?.trim();
  return v ? v : null;
}
