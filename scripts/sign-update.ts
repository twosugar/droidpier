// 给网关的更新清单（<名字>.update.json，scripts/build-binary.ts 生成）签名，写出 <清单>.sig（ed25519 签名的 base64）。
// 后台网关只换上签名能用 gateway/src/updater.ts 里的公钥验过的版本。私钥不进仓库：CI 从密钥 DROIDPIER_UPDATE_SIGNING_KEY 取（docs/deploy.md）。
// 用法：node scripts/sign-update.ts <私钥 PEM 文件> <清单>
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 对清单的原始字节签名，返回写进 .sig 的一行（base64）。 */
export function signManifest(bytes: Buffer, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`签名私钥要是 ed25519，这把是 ${key.asymmetricKeyType}`);
  return `${sign(null, bytes, key).toString("base64")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [keyPath, manifestPath] = process.argv.slice(2);
  if (!keyPath || !manifestPath) {
    console.error("用法：node scripts/sign-update.ts <私钥 PEM 文件> <清单>");
    process.exit(1);
  }
  writeFileSync(`${manifestPath}.sig`, signManifest(readFileSync(manifestPath), readFileSync(keyPath, "utf8")));
  console.log(`已签名：${manifestPath}.sig`);
}
