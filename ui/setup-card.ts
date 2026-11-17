import type { EnvReport } from "../shared/protocol";

/**
 * 环境检查卡片显示与否。卡片盖在设备画面上方（会挡住顶部和两侧按键），所以只要没在安装，缺项时也能收起；
 * 安装进行中一直显示，收起后要等下一次开始安装才再显示。
 * needed：缺的东西要不要主动提示（setupNeeded）；wanted：用户点了「安装模拟器」，主动要看。
 */
export function setupCardShown(s: { ok: boolean; needed: boolean; wanted: boolean; busy: boolean; failed: boolean; hasInstalls: boolean; dismissed: boolean }): boolean {
  if (s.busy) return true;
  if (s.dismissed) return false;
  if (s.failed || s.hasInstalls) return true;
  return !s.ok && (s.needed || s.wanted);
}

/**
 * 卡片该不该自己弹出来。adb 是真机和模拟器都要的；模拟器、系统镜像、设备只有用模拟器才要，
 * 本机一台模拟器设备都没有时可能只用真机，不拿「先装模拟器」挡住（设计文档 6.2）。
 * avdCount 是设备列表的台数；没装模拟器程序时列表列不出来，所以也看环境检查数到的 env.avds。
 */
export function setupNeeded(env: Pick<EnvReport, "missing" | "error" | "avds">, avdCount: number): boolean {
  if (env.error) return true;
  if (env.missing.some((m) => m.id === "platform-tools")) return true;
  return Math.max(avdCount, env.avds ?? 0) > 0 && env.missing.length > 0;
}

/** 只跟模拟器有关的缺项数（platform-tools 以外）。 */
export function missingEmulatorItems(env: Pick<EnvReport, "missing">): number {
  return env.missing.filter((m) => m.id !== "platform-tools").length;
}

/**
 * 侧栏「安装模拟器（缺 N 项）」按钮：只在卡片因为只缺模拟器相关项而没自己弹出时给。
 * 卡片该自己弹出（缺 adb、检查出错、本机有设备）时不给，否则按钮上的「缺 N 项」会漏掉 adb 或写成 0。
 */
export function emulatorButtonShown(env: Pick<EnvReport, "ok" | "missing" | "error" | "avds">, avdCount: number, cardShown: boolean): boolean {
  return !env.ok && !cardShown && !setupNeeded(env, avdCount);
}
