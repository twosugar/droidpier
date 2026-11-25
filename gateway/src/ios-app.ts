// 把拖进来的 iOS App 装到模拟器：解开页面打包的 .app（tar）或 .zip / .ipa，找到里面的 .app，用 simctl install 装上。
// 只认模拟器编出来的包（Xcode 里选模拟器编译，Debug-iphonesimulator 下的 .app）；真机的包 simctl 装不上。
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

export type IosAppDeps = {
  /** 跑一个命令，返回 stdout；失败时抛错，message 带着输出。 */
  run(cmd: string, args: string[], timeoutMs: number): Promise<string>;
};

/** 装一个 App 最多等这么久（大的 App 拷进模拟器要一会儿）。 */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const UNPACK_TIMEOUT_MS = 2 * 60_000;

const DEVICE_BUILD = /iphoneos|built for iOS,? but not iOS Simulator|not built for (the )?iOS Simulator/i;

/** simctl install 的失败输出变成一句给人看的话。 */
export function iosInstallFailure(output: string): string {
  if (DEVICE_BUILD.test(output)) return "这是给 iPhone 真机编的包，模拟器装不了：在 Xcode 里选一台模拟器编译，拖 Debug-iphonesimulator 下的 .app";
  const last = output.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return last ? last.slice(0, 300) : "未知原因";
}

/** 解开后的目录里找 .app：最外层，或 .ipa 的 Payload/ 下。 */
async function findApp(root: string): Promise<string | null> {
  for (const dir of [root, join(root, "Payload")]) {
    const list = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const app = list.find((e) => e.isDirectory() && e.name.toLowerCase().endsWith(".app"));
    if (app) return join(dir, app.name);
  }
  return null;
}

/** 解开 archive（在 workDir 下），把里面的 .app 装到 udid 这台模拟器。失败时抛出给人看的原因。 */
export async function installIosApp(deps: IosAppDeps, o: { udid: string; archive: string; format: "tar" | "zip"; workDir: string }): Promise<{ app: string }> {
  const out = join(o.workDir, "unpacked");
  await mkdir(out, { recursive: true });
  try {
    // 系统的 tar（bsdtar）默认不解出绝对路径和带 .. 的条目；ditto 解 zip 保留可执行权限
    if (o.format === "tar") await deps.run("/usr/bin/tar", ["-xf", o.archive, "-C", out], UNPACK_TIMEOUT_MS);
    else await deps.run("/usr/bin/ditto", ["-x", "-k", o.archive, out], UNPACK_TIMEOUT_MS);
  } catch (e) {
    throw new Error(`解压失败：${iosInstallFailure((e as Error).message)}`);
  }
  const app = await findApp(out);
  if (!app) throw new Error("包里没有 .app：要拖 .app，或装着 .app 的 .zip / .ipa");
  try {
    await deps.run("/usr/bin/xcrun", ["simctl", "install", o.udid, app], INSTALL_TIMEOUT_MS);
  } catch (e) {
    throw new Error(iosInstallFailure((e as Error).message));
  }
  return { app };
}
