// 在页面里把拖进来的文件夹（iOS 的 .app）打成 tar，按普通文件传给网关，网关用系统的 tar 解开。
// 浏览器拿不到文件的权限，一律给 0755：.app 里的主程序和插件要能执行，其他文件多个执行位不碍事。
// 文件内容是 Blob，拼起来的 Blob 不会把文件读进内存，传的时候按片读。

/** 一个条目：目录，或带内容的文件。path 用 / 分隔，不以 / 开头。 */
export type TarEntry = { path: string; dir: true } | { path: string; data: Blob };

const BLOCK = 512;
const enc = new TextEncoder();

function octal(buf: Uint8Array, off: number, len: number, n: number) {
  buf.set(enc.encode(n.toString(8).padStart(len - 1, "0")), off);
  buf[off + len - 1] = 0;
}

function header(name: Uint8Array, type: string, size: number, mtime: number): Uint8Array<ArrayBuffer> {
  const h = new Uint8Array(BLOCK);
  h.set(name.subarray(0, 100), 0);
  octal(h, 100, 8, 0o755);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, size);
  octal(h, 136, 12, mtime);
  h.fill(0x20, 148, 156);
  h[156] = type.charCodeAt(0);
  h.set(enc.encode("ustar\u000000"), 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.set(enc.encode(sum.toString(8).padStart(6, "0")), 148);
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

const pad = (n: number) => new Uint8Array((BLOCK - (n % BLOCK)) % BLOCK);

/** PAX 扩展头的一条记录："<长度> path=<值>\n"，长度算上它自己。 */
function paxRecord(key: string, value: string): Uint8Array<ArrayBuffer> {
  const body = enc.encode(` ${key}=${value}\n`);
  let len = body.byteLength;
  while (String(len).length + body.byteLength !== len) len = String(len).length + body.byteLength;
  return enc.encode(`${len}${new TextDecoder().decode(body)}`);
}

/** 打成 tar 的各段（头、内容、补齐），和总字节数。路径超过 100 字节或不是 ASCII 时前面加一个 PAX 头写全路径。 */
export function tarParts(entries: TarEntry[], mtime = Math.floor(Date.now() / 1000)): { parts: BlobPart[]; size: number } {
  const parts: BlobPart[] = [];
  let size = 0;
  const push = (p: Uint8Array<ArrayBuffer> | Blob) => {
    parts.push(p);
    size += p instanceof Blob ? p.size : p.byteLength;
  };
  for (const e of entries) {
    const path = "dir" in e ? `${e.path.replace(/\/+$/, "")}/` : e.path;
    const name = enc.encode(path);
    if (name.byteLength > 100 || /[^\x20-\x7e]/.test(path)) {
      const rec = paxRecord("path", path);
      push(header(enc.encode("PaxHeader"), "x", rec.byteLength, mtime));
      push(rec);
      push(pad(rec.byteLength));
    }
    if ("dir" in e) {
      push(header(name, "5", 0, mtime));
    } else {
      push(header(name, "0", e.data.size, mtime));
      push(e.data);
      push(pad(e.data.size));
    }
  }
  // 结尾两个空块
  push(new Uint8Array(2 * BLOCK));
  return { parts, size };
}
