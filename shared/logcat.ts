// logcat 的行格式和过滤（网关按它过滤，页面按它上色）。格式是 adb logcat -v threadtime，见 docs/superpowers/specs/2026-11-13-real-device-design.md 6.2

export type LogLevel = "V" | "D" | "I" | "W" | "E" | "F";

/** n 是网关给的递增序号，页面拿它当 key。 */
export type LogLine = { n: number; time: string; pid: number; tid: number; level: LogLevel; tag: string; msg: string };

/** 页面发给网关的过滤条件：pkg 为 null 表示全部 App；text 不区分大小写，匹配 tag 或内容。 */
export type LogFilter = { pkg: string | null; level: LogLevel; text: string };

const ORDER = "VDIWEF";
const LINE = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s(.*)$/;

/** 分隔行（--------- beginning of …）和认不出的行返回 null。tag 取到第一个「: 」为止：tag 里可能有 ::。 */
export function parseLogcatLine(s: string): Omit<LogLine, "n"> | null {
  const m = LINE.exec(s);
  if (!m) return null;
  const rest = m[5];
  const cut = rest.indexOf(": ");
  const [tag, msg] = cut >= 0 ? [rest.slice(0, cut), rest.slice(cut + 2)] : [rest.endsWith(":") ? rest.slice(0, -1) : rest, ""];
  const level = (m[4] === "A" ? "F" : m[4]) as LogLevel;
  return { time: m[1], pid: Number(m[2]), tid: Number(m[3]), level, tag: tag.trimEnd(), msg };
}

export function levelAtLeast(l: LogLevel, min: LogLevel): boolean {
  return ORDER.indexOf(l) >= ORDER.indexOf(min);
}

/** pids 为 null 表示不按 App 过滤。 */
export function matchLog(line: Omit<LogLine, "n">, f: { pids: ReadonlySet<number> | null; level: LogLevel; text: string }): boolean {
  if (!levelAtLeast(line.level, f.level)) return false;
  if (f.pids && !f.pids.has(line.pid)) return false;
  if (!f.text) return true;
  const t = f.text.toLowerCase();
  return line.tag.toLowerCase().includes(t) || line.msg.toLowerCase().includes(t);
}
