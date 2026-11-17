import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutHighlight } from "../../host/src/highlight.ts";

const DEVICE = { width: 1080, height: 2400 };
const VIEW = { width: 360, height: 800 }; // 画布 CSS 尺寸，正好是设备的 1/3
const BOX = {
  quads: [
    { points: [0, 300, 1080, 300, 1080, 900, 0, 900], color: "rgba(246,178,107,0.66)" },
    { points: [30, 330, 1050, 330, 1050, 870, 30, 870], color: "rgba(111,168,220,0.66)" },
  ],
  label: "p",
  size: "328 × 225",
};

test("layoutHighlight：面板坐标换成画布上的位置，每层一个多边形", () => {
  const r = layoutHighlight(BOX, VIEW, DEVICE, 0);
  assert.deepEqual(r.polygons, [
    { points: "0,100 360,100 360,300 0,300", color: "rgba(246,178,107,0.66)" },
    { points: "10,110 350,110 350,290 10,290", color: "rgba(111,168,220,0.66)" },
  ]);
});

test("layoutHighlight：标注放在最外层框的上方，左边对齐；上方放不下时放到下方", () => {
  const r = layoutHighlight(BOX, VIEW, DEVICE, 0);
  assert.equal(r.label?.text, "p");
  assert.equal(r.label?.size, "328 × 225");
  assert.equal(r.label?.left, 0);
  assert.ok(r.label!.top < 100 && r.label!.top >= 70, `top ${r.label!.top}`);
  const atTop = { ...BOX, quads: [{ points: [0, 0, 1080, 0, 1080, 300, 0, 300], color: "red" }] };
  const below = layoutHighlight(atTop, VIEW, DEVICE, 0).label!;
  assert.ok(below.top >= 100, `top ${below.top}`);
});

test("layoutHighlight：标注夹在画布内；没有标注时 label 为 null", () => {
  const right = { ...BOX, quads: [{ points: [1050, 600, 1080, 600, 1080, 900, 1050, 900], color: "red" }], label: "div#a-very-long-id.and-a-class" };
  const l = layoutHighlight(right, VIEW, DEVICE, 0).label!;
  assert.ok(l.left + l.width <= VIEW.width, `left ${l.left} width ${l.width}`);
  assert.ok(l.left >= 0);
  assert.equal(layoutHighlight({ ...BOX, label: null }, VIEW, DEVICE, 0).label, null);
});

test("layoutHighlight：横屏时按旋转换算（转 90 度，面板上方变成画布右侧）", () => {
  const r = layoutHighlight({ ...BOX, label: null }, { width: 800, height: 360 }, DEVICE, 90);
  const pts = r.polygons[0].points.split(" ").map((s) => s.split(",").map(Number));
  // 面板 y=300（上沿）对应画布 x = 800 - 100 = 700
  assert.equal(pts[0][0], 700);
});
