import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installIosApp, iosInstallFailure } from "../src/ios-app.ts";
import { tarParts } from "../../shared/tar.ts";

/** 解包用真的 tar / ditto，simctl 换成记录调用的假的。 */
function deps(simctl: (args: string[]) => string = () => "") {
  const calls: string[][] = [];
  return {
    calls,
    run: (cmd: string, args: string[]) =>
      new Promise<string>((resolve, reject) => {
        if (cmd === "/usr/bin/xcrun") {
          calls.push(args);
          try {
            return resolve(simctl(args));
          } catch (e) {
            return reject(e);
          }
        }
        execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error(`${stderr}${err.message}`)) : resolve(stdout)));
      }),
  };
}

async function appTar(dir: string) {
  const { parts } = tarParts([
    { path: "Demo.app", dir: true },
    { path: "Demo.app/Demo", data: new Blob(["bin"]) },
    { path: "Demo.app/Info.plist", data: new Blob(["<plist/>"]) },
  ]);
  const file = join(dir, "Demo.app.tar");
  await writeFile(file, new Uint8Array(await new Blob(parts).arrayBuffer()));
  return file;
}

test("installIosApp：页面打包的 .app（tar）解开后装到这台模拟器", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iosapp-"));
  const d = deps();
  const r = await installIosApp(d, { udid: "UDID-1", archive: await appTar(dir), format: "tar", workDir: dir });
  assert.match(r.app, /Demo\.app$/);
  assert.deepEqual(d.calls, [["simctl", "install", "UDID-1", r.app]]);
});

test("installIosApp：.ipa 里 Payload/ 下的 .app、zip 最外层的 .app 都能找到", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iosapp-"));
  await mkdir(join(dir, "src/Payload/My App.app"), { recursive: true });
  await writeFile(join(dir, "src/Payload/My App.app/Info.plist"), "<plist/>");
  execFileSync("/usr/bin/ditto", ["-c", "-k", join(dir, "src"), join(dir, "a.ipa")]);
  const d = deps();
  const r = await installIosApp(d, { udid: "U", archive: join(dir, "a.ipa"), format: "zip", workDir: dir });
  assert.match(r.app, /Payload\/My App\.app$/);

  await mkdir(join(dir, "src2/Top.app"), { recursive: true });
  await writeFile(join(dir, "src2/Top.app/Info.plist"), "<plist/>");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", join(dir, "src2/Top.app"), join(dir, "b.zip")]);
  const r2 = await installIosApp(deps(), { udid: "U", archive: join(dir, "b.zip"), format: "zip", workDir: dir });
  assert.match(r2.app, /Top\.app$/);
});

test("installIosApp：包里没有 .app 时说清楚；simctl 装失败时带上原因", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iosapp-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/readme.txt"), "hi");
  execFileSync("/usr/bin/ditto", ["-c", "-k", join(dir, "src"), join(dir, "a.zip")]);
  await assert.rejects(installIosApp(deps(), { udid: "U", archive: join(dir, "a.zip"), format: "zip", workDir: dir }), /没有 \.app/);
  const d = deps(() => {
    throw new Error("An error was encountered processing the command (domain=IXUserPresentableErrorDomain, code=4):\nThis app was built for iOS, but not iOS Simulator.");
  });
  await assert.rejects(installIosApp(d, { udid: "U", archive: await appTar(dir), format: "tar", workDir: dir }), /真机/);
});

test("iosInstallFailure：真机的包说明要用模拟器编的；别的取最后一行", () => {
  assert.match(iosInstallFailure("...\nUnable to install \"Demo\"\nThe app is built for iphoneos and cannot be installed").zh, /真机/);
  assert.match(iosInstallFailure("The app is built for iphoneos").en, /real iPhone/);
  assert.deepEqual(iosInstallFailure("line one\nInvalid device: U\n"), { en: "Invalid device: U", zh: "Invalid device: U" });
});
