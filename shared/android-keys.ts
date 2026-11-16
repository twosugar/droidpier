// 页面用的 W3C 键名 → Android KeyEvent 的 keycode，真机按键经 scrcpy 注入时用（docs/superpowers/specs/2026-11-13-real-device-design.md 6.2「输入」）

const KEYCODES: Record<string, number> = {
  GoBack: 4,
  GoHome: 3,
  AppSwitch: 187,
  Power: 26,
  AudioVolumeUp: 24,
  AudioVolumeDown: 25,
  Enter: 66,
  Backspace: 67,
  Delete: 112,
  Tab: 61,
  Escape: 111,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
};

/** 不认识的键名返回 null。 */
export function androidKeycode(key: string): number | null {
  return Object.hasOwn(KEYCODES, key) ? KEYCODES[key] : null;
}
