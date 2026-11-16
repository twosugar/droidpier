// 随网关发布的 scrcpy-server（gateway/vendor/scrcpy，Apache-2.0）：真机靠它取画面
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 启动服务端时传的版本号必须和服务端自己的版本完全相同，否则服务端直接退出（Options.java）。 */
export const SCRCPY_VERSION = "5.0.1";

/** 官方 release 的 SHA256SUMS.txt 里 scrcpy-server-v5.0.1 的值。 */
export const SCRCPY_SHA256 = "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536";

const FILE = `scrcpy-server-v${SCRCPY_VERSION}`;

/** 单文件网关里 scripts/build-binary.ts 把 vendor 目录嵌在 import.meta.dirname/scrcpy 下；从源码运行时直接读仓库里的。 */
export function scrcpyServerPath(standalone: boolean): string {
  return standalone
    ? join(import.meta.dirname, "scrcpy", FILE)
    : fileURLToPath(new URL(`../vendor/scrcpy/${FILE}`, import.meta.url));
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * 把 jar 落成真实文件，返回路径。单文件网关里的资源是虚拟路径，adb push 读不了。
 * 已有且内容对就复用；源文件校验不过时报错，不写出。
 */
export async function materializeScrcpyServer(src: string, tmpRoot: string): Promise<string> {
  const target = join(tmpRoot, `droidpier-scrcpy-${SCRCPY_VERSION}.jar`);
  const existing = await readFile(target).catch(() => null);
  if (existing && sha256(existing) === SCRCPY_SHA256) return target;
  const buf = await readFile(src);
  const got = sha256(buf);
  if (got !== SCRCPY_SHA256) throw new Error(`scrcpy-server 的 sha256 不对：应为 ${SCRCPY_SHA256}，实际 ${got}`);
  // 先写临时名再改名：两个请求同时落盘时不会读到写了一半的文件
  const part = `${target}.${process.pid}.part`;
  await writeFile(part, buf);
  await rename(part, target);
  return target;
}
