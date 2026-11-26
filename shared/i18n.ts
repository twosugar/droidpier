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
