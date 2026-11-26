// 页面和 host 的文字：英文（默认）和中文两套，写在用到的地方：t({ en: "Install", zh: "安装" })。
// 当前语言从一个来源读：页面接到语言信号上（切换后文字跟着变），host 接到它存的值上；没接时是英文（测试也是）。

export const LANGS = ["en", "zh"] as const;
export type Lang = (typeof LANGS)[number];

/** 一段文字的两种语言。 */
export type Msg = { en: string; zh: string };

/** 读回存着的语言；没存过、存的不认识都按英文。 */
export function parseLang(raw: unknown): Lang {
  return LANGS.includes(raw as Lang) ? (raw as Lang) : "en";
}

let source: () => Lang = () => "en";

/** 换当前语言的来源。页面传读语言信号的函数，这样在界面里调 t() 会跟着语言更新。 */
export function setLangSource(get: () => Lang): void {
  source = get;
}

/** 当前语言。 */
export const lang = (): Lang => source();

/** 按当前语言取文字。 */
export function t(m: Msg): string {
  return m[source()];
}

const isMsg = (v: unknown): v is Msg => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 2 && typeof (v as Msg).en === "string" && typeof (v as Msg).zh === "string";
};

/**
 * 网关发给页面前用：消息里所有 { en, zh }（恰好这两个字符串字段）换成 lang 的字符串，嵌套和数组里的也换。
 * 网关的代码在消息里直接放两种语言，发给哪个页面就按那个页面的语言（server.ts 的 send）。
 */
export function localize<T>(value: T, lang: Lang): T {
  if (isMsg(value)) return value[lang] as T;
  if (Array.isArray(value)) return value.map((v) => localize(v, lang)) as T;
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = localize(v, lang);
    return out as T;
  }
  return value;
}

/** 带两种语言的错误：message 是中文（日志照旧），msg 给页面（textOf 取出来放进消息）。 */
export class TextError extends Error {
  readonly msg: Msg;
  constructor(msg: Msg) {
    super(msg.zh);
    this.msg = msg;
  }
}

/** 错误放进发给页面的消息时用：TextError 给两种语言，别的错误给原文。 */
export const textOf = (e: unknown): Msg | string => (e instanceof TextError ? e.msg : e instanceof Error ? e.message : String(e));

/** 网关拼消息时的类型：字符串的地方也可以放 { en, zh }，send 时按页面的语言换成字符串（localize）。 */
export type Localizable<T> = T extends string ? T | Msg : T extends (infer U)[] ? Localizable<U>[] : T extends object ? { [K in keyof T]: Localizable<T[K]> } : T;

/** 拼进两种语言的句子时用：只有原文的字符串（adb 的输出、别的程序的报错）两种语言都用它。 */
export const msgOf = (x: Msg | string): Msg => (typeof x === "string" ? { en: x, zh: x } : x);
