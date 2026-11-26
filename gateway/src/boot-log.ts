import type { Msg } from "../../shared/i18n.ts";

const MAX_REASON = 300;
const SEVERE = /panic|fatal/i;
const KEY = /panic|fatal|error|cannot|not enough|requires/i;

/** 从模拟器日志里挑出最能说明为什么退出的一两行：先 PANIC / FATAL，再 ERROR 等关键行，都没有就取最后两行；最多 300 字。 */
export function bootLogReason(log: string): string {
  const lines = log.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const key = lines.filter((l) => KEY.test(l));
  const picked = key.length
    ? [...key.filter((l) => SEVERE.test(l)), ...key.filter((l) => !SEVERE.test(l))].slice(0, 2)
    : lines.slice(-2);
  return clip([...new Set(picked)].join("; "));
}

function clip(text: string): string {
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text;
}

const UPDATE_EMULATOR: Msg = {
  en: "The emulator is too old for this system image: update Android Emulator in Android Studio's SDK Manager → SDK Tools",
  zh: "模拟器版本太旧，跑不了这个系统镜像：在 Android Studio 的 SDK Manager → SDK Tools 里更新 Android Emulator",
};

// 前面的先匹配：x86 的“Missing emulator engine program”是镜像架构问题，不是版本问题
const HINTS: Array<[RegExp, Msg]> = [
  [/not enough (disk )?space|space to create userdata/i, { en: "Not enough disk space: free some up and start again", zh: "磁盘空间不够，清理出空间后再启动" }],
  [
    /another emulator instance|is already running|multiple emulators with the same avd/i,
    {
      en: "This AVD is already running (or did not quit cleanly last time): close it, or end the qemu-system process in Activity Monitor",
      zh: "这个 AVD 已经在运行（或上次没退干净）：先关掉它，或在活动监视器里结束 qemu-system 进程",
    },
  ],
  [
    /emulation currently requires hardware acceleration|cpu architecture '[^']*' is not supported|missing emulator engine program for 'x86/i,
    {
      en: "This is an x86 / x86_64 image, which Macs with Apple silicon cannot run: use an AVD with an arm64-v8a image",
      zh: "这是 x86 / x86_64 镜像，Apple 芯片的 Mac 跑不了：换一个 arm64-v8a 镜像的 AVD",
    },
  ],
  [/newer version of the emulator|missing emulator engine program|emulator (is )?(too old|out of date)/i, UPDATE_EMULATOR],
  [
    /avd system path|cannot find kernel file|system image.*(not installed|missing)/i,
    {
      en: "The system image of this AVD is not installed or cannot be found: install it in Android Studio's SDK Manager",
      zh: "这个 AVD 的系统镜像没装或找不到：在 Android Studio 的 SDK Manager 里装上对应的系统镜像",
    },
  ],
];

/** 日志里认得出的常见启动失败，翻成建议（两种语言）；认不出返回 null。 */
export function bootLogHint(log: string): Msg | null {
  return HINTS.find(([re]) => re.test(log))?.[1] ?? null;
}

// 模拟器自己检测到开机完成时打的一行（emulator 36.4.10 二进制里的格式串是 "Boot completed in %lld ms"）
const BOOTED = /Boot completed in \d+ ms/;
const ADB_SILENT: Msg = {
  en: "The emulator has booted, but adb never saw the boot finish: run adb kill-server in Terminal (from the SDK's platform-tools) to restart adb, then start again",
  zh: "模拟器已经开机，但 adb 一直读不到开机完成：在终端运行 adb kill-server（SDK 的 platform-tools 里）重启 adb 后再启动一次",
};

/**
 * 开机超时时说明卡在哪：问过 adb 而模拟器自己报了开机完成，就是 adb 读不到；否则用认得出的常见问题；都没有给日志最后一行；空日志返回 null。
 * 不用 bootLogReason：正常开机的日志里也有 ERROR 行（如 bad color buffer handle），超时时拿它当原因会误导。
 */
export function bootStuckDetail(log: string, askedAdb: boolean): Msg | null {
  if (askedAdb && BOOTED.test(log)) return ADB_SILENT;
  const hint = bootLogHint(log);
  if (hint) return hint;
  const last = log.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).at(-1);
  return last ? { en: `Last log line: ${clip(last)}`, zh: `日志最后一行：${clip(last)}` } : null;
}
