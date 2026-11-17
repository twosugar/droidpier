import { test } from "node:test";
import assert from "node:assert/strict";
import { applyBatch, levelColor, MAX_LINES, type LogRow } from "../../ui/log-store.ts";
import type { LogLine } from "../logcat.ts";

const line = (n: number): LogLine => ({ n, time: "11-16 18:00:52.531", pid: 1, tid: 1, level: "I", tag: "T", msg: `m${n}` });
const lines = (count: number, from = 0) => Array.from({ length: count }, (_, i) => line(from + i));
const ns = (rows: readonly LogRow[]) => rows.map((r) => ("skipped" in r ? `skip${r.skipped}` : r.n));

test("applyBatch：reset 清空后放新行，否则追加", () => {
  const a = applyBatch([], { lines: lines(2), reset: false, dropped: 0 });
  assert.deepEqual(ns(a), [0, 1]);
  assert.deepEqual(ns(applyBatch(a, { lines: lines(1, 2), reset: false, dropped: 0 })), [0, 1, 2]);
  assert.deepEqual(ns(applyBatch(a, { lines: lines(1, 9), reset: true, dropped: 0 })), [9]);
});

test("applyBatch：超过 MAX_LINES 丢最前面的", () => {
  assert.equal(MAX_LINES, 20000);
  const rows = applyBatch([], { lines: lines(20005), reset: false, dropped: 0 });
  assert.equal(rows.length, 20000);
  assert.equal((rows[0] as LogLine).n, 5);
});

test("applyBatch：dropped 时先插一行「省略了 N 行」，key 不和网关序号撞", () => {
  const rows = applyBatch([line(1)], { lines: [line(50)], reset: false, dropped: 7 });
  assert.deepEqual(ns(rows), [1, "skip7", 50]);
  assert.ok(rows[1].n < 0);
  const more = applyBatch(rows, { lines: [], reset: false, dropped: 3 });
  assert.notEqual(more[3].n, rows[1].n);
});

test("levelColor：W 是 warn，E 和 F 是 danger，V 和 D 是 muted，I 是 text", () => {
  assert.deepEqual((["V", "D", "I", "W", "E", "F"] as const).map(levelColor), ["muted", "muted", "text", "warn", "danger", "danger"]);
});
