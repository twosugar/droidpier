// 拖进来的东西里有文件夹时：iOS 的 .app 是个文件夹，浏览器的 dataTransfer.files 只给一个读不出内容的条目。
// 这里用 webkitGetAsEntry() 拿到的条目把 .app 整个读出来，打成一个 .app.tar（shared/tar.ts），按普通文件传；
// 别的文件夹不传，告诉用户。
import { tarParts, type TarEntry } from "../../shared/tar.ts";
import { APP_TAR_SUFFIX } from "../../shared/upload.ts";
import { t } from "../../shared/i18n.ts";

/** FileSystemEntry 用到的部分（浏览器的 FileSystemFileEntry / FileSystemDirectoryEntry 都符合）。 */
export type DropEntry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?(ok: (f: File) => void, err?: (e: Error) => void): void;
  createReader?(): { readEntries(ok: (list: DropEntry[]) => void, err?: (e: Error) => void): void };
};

const fileOf = (e: DropEntry) => new Promise<File>((ok, err) => e.file!(ok, err));

/** 目录的全部子项：readEntries 一次最多给一批（Chrome 是 100 个），读到空批为止。 */
async function children(e: DropEntry): Promise<DropEntry[]> {
  const reader = e.createReader!();
  const all: DropEntry[] = [];
  for (;;) {
    const batch = await new Promise<DropEntry[]>((ok, err) => reader.readEntries(ok, err));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

/** 把目录 e（路径 path）下的所有目录和文件按先目录后内容的顺序加进 out。 */
async function walk(e: DropEntry, path: string, out: TarEntry[]) {
  out.push({ path, dir: true });
  for (const c of await children(e)) {
    const p = `${path}/${c.name}`;
    if (c.isDirectory) await walk(c, p, out);
    else if (c.isFile) out.push({ path: p, data: await fileOf(c) });
  }
}

/** 拖进来的条目变成要传的文件：.app 文件夹打成 <名字>.app.tar；skipped 是没传的文件夹，每个一句说明。 */
export async function filesFromDrop(entries: DropEntry[]): Promise<{ files: File[]; skipped: string[] }> {
  const files: File[] = [];
  const skipped: string[] = [];
  for (const e of entries) {
    if (e.isFile) {
      files.push(await fileOf(e));
    } else if (e.isDirectory && e.name.toLowerCase().endsWith(".app")) {
      const list: TarEntry[] = [];
      await walk(e, e.name, list);
      files.push(new File(tarParts(list).parts, `${e.name}${APP_TAR_SUFFIX.slice(".app".length)}`));
    } else if (e.isDirectory) {
      skipped.push(t({ en: `${e.name} is a folder and was not sent: only iOS .app folders can be dragged in whole`, zh: `${e.name} 是文件夹，没有传：只有 iOS 的 .app 可以整个拖进来` }));
    }
  }
  return { files, skipped };
}
