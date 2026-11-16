import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_START, autoOpen, type AutoEvent, type AutoState } from "../../ui/console-auto.ts";

/** 依次喂事件，返回每一步要不要自动打开。 */
function run(events: AutoEvent[], s: AutoState = AUTO_START) {
  const opens: boolean[] = [];
  for (const ev of events) {
    const r = autoOpen(s, ev);
    s = r.state;
    opens.push(r.open);
  }
  return opens;
}
const page = (key: string | null, pkg: string | null = key && "com.example.app"): AutoEvent => ({ kind: "active", key, pkg });

test("H5 页面出现时自动打开一次；同一个页面一直在前台不再重复打开", () => {
  assert.deepEqual(run([page(null), page("a"), page("a")]), [false, true, false]);
});

test("用户手动关掉后，同一个 App 的页面（换了页面也算）不再自动打开", () => {
  assert.deepEqual(run([
    page("a"),
    { kind: "closed", pkg: "com.example.app" },
    page("a"),
    page(null),
    page("a"),
    page("b"),
  ]), [true, false, false, false, false, false]);
});

test("手动关掉后出现别的 App 的 H5 页面：打开，之后回到原来的 App 也打开", () => {
  assert.deepEqual(run([
    page("a"),
    { kind: "closed", pkg: "com.example.app" },
    page("c", "com.example.browser"),
    page("a"),
  ]), [true, false, true, true]);
});

test("页面没了（自动收起）之后同一个页面再出现：算一次新的出现，再打开", () => {
  assert.deepEqual(run([page("a"), page(null), page("a")]), [true, false, true]);
});

test("没有前台页面时关掉控制台不记什么", () => {
  assert.deepEqual(run([{ kind: "closed", pkg: null }, page("a")]), [false, true]);
});
