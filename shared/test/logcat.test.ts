import { test } from "node:test";
import assert from "node:assert/strict";
import { levelAtLeast, matchLog, parseLogcatLine } from "../logcat.ts";

// 样例取自 2026-11-16 SM-G9910 和模拟器 API 35 的 adb logcat -v threadtime 输出
test("parseLogcatLine：threadtime 行", () => {
  assert.deepEqual(parseLogcatLine("11-16 18:00:52.531  1456  1885 I ActivityManager: Killing 5050:com.x/u0a187 (adj 999)"),
    { time: "11-16 18:00:52.531", pid: 1456, tid: 1885, level: "I", tag: "ActivityManager", msg: "Killing 5050:com.x/u0a187 (adj 999)" });
});

test("parseLogcatLine：tag 里有 ::，按第一个「: 」切", () => {
  assert.equal(parseLogcatLine("11-16 18:02:18.694  3586  3661 D engine::api::beacon::sink::http: message=fail")?.tag, "engine::api::beacon::sink::http");
});

test("parseLogcatLine：tag 带尾部空格、msg 为空、级别 A 归为 F", () => {
  assert.equal(parseLogcatLine("11-16 18:00:52.531  1  2 W Tag     : hi")?.tag, "Tag");
  assert.equal(parseLogcatLine("11-16 18:00:52.531  1  2 E Tag:")?.msg, "");
  assert.equal(parseLogcatLine("11-16 18:00:52.531  1  2 A Tag: boom")?.level, "F");
});

test("parseLogcatLine：分隔行和乱行返回 null", () => {
  assert.equal(parseLogcatLine("--------- beginning of main"), null);
  assert.equal(parseLogcatLine("garbage"), null);
});

test("matchLog：级别下限、pid、文本（不区分大小写，匹配 tag 或 msg）", () => {
  const l = parseLogcatLine("11-16 18:00:52.531  100  2 W WebView: Loading URL")!;
  assert.equal(matchLog(l, { pids: null, level: "W", text: "" }), true);
  assert.equal(matchLog(l, { pids: null, level: "E", text: "" }), false);
  assert.equal(matchLog(l, { pids: new Set([100]), level: "V", text: "webview" }), true);
  assert.equal(matchLog(l, { pids: new Set([101]), level: "V", text: "" }), false);
  assert.equal(matchLog(l, { pids: null, level: "V", text: "url" }), true);
  assert.equal(matchLog(l, { pids: null, level: "V", text: "nope" }), false);
});

test("levelAtLeast：按 V < D < I < W < E < F", () => {
  assert.equal(levelAtLeast("E", "W"), true);
  assert.equal(levelAtLeast("D", "I"), false);
  assert.equal(levelAtLeast("F", "F"), true);
});
