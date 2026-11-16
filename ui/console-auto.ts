/**
 * 自动打开控制台：前台出现 H5 页面时打开一次。
 * opened：上次为它自动打开过的页面（pageKey），还在前台就不再打开；
 * suppressed：用户手动关掉时前台页面所在的 App，出现别的 App 的 H5 页面之前，这个 App 的页面都不再自动打开。
 */
export type AutoState = { opened: string | null; suppressed: string | null };
export const AUTO_START: AutoState = { opened: null, suppressed: null };

export type AutoEvent =
  /** 前台页面变了或刷新了一次：key 是 pageKey，pkg 是它所在的 App；没有可调试的 H5 时 key 为 null。 */
  | { kind: "active"; key: string | null; pkg: string | null }
  /** 用户手动关掉控制台，pkg 是当时前台页面所在的 App。页面没了自动收起不算。 */
  | { kind: "closed"; pkg: string | null };

export function autoOpen(s: AutoState, ev: AutoEvent): { state: AutoState; open: boolean } {
  if (ev.kind === "closed") return { state: { ...s, suppressed: ev.pkg ?? s.suppressed }, open: false };
  const { key, pkg } = ev;
  if (key === null) return { state: { ...s, opened: null }, open: false };
  if (key === s.opened) return { state: s, open: false };
  if (pkg !== null && pkg === s.suppressed) return { state: { ...s, opened: key }, open: false };
  return { state: { opened: key, suppressed: null }, open: true };
}
