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

test("layoutHighlight：每层画成环（自己的框减去里面一层），同一块只盖一层颜色，文字才看得清", () => {
  const r = layoutHighlight(BOX, VIEW, DEVICE, 0);
  assert.deepEqual(r.layers, [
    { d: "M0,100L360,100L360,300L0,300Z M10,110L350,110L350,290L10,290Z", color: "rgba(246,178,107,0.66)" },
    { d: "M10,110L350,110L350,290L10,290Z", color: "rgba(111,168,220,0.66)" },
  ]);
});

test("layoutHighlight：透明的层不画，但仍是外面一层的内边界", () => {
  const four = {
    ...BOX,
    quads: [
      { points: [0, 300, 1080, 300, 1080, 900, 0, 900], color: "rgba(246,178,107,0.66)" },
      { points: [30, 330, 1050, 330, 1050, 870, 30, 870], color: "rgba(0,0,0,0)" },
      { points: [60, 360, 1020, 360, 1020, 840, 60, 840], color: "rgba(0,0,0,0)" },
      { points: [90, 390, 990, 390, 990, 810, 90, 810], color: "rgba(111,168,220,0.66)" },
    ],
  };
  const r = layoutHighlight(four, VIEW, DEVICE, 0);
  assert.deepEqual(r.layers.map((l) => l.color), ["rgba(246,178,107,0.66)", "rgba(111,168,220,0.66)"]);
  assert.equal(r.layers[0].d, "M0,100L360,100L360,300L0,300Z M10,110L350,110L350,290L10,290Z");
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
  // 面板 y=300（上沿）对应画布 x = 800 - 100 = 700
  assert.ok(r.layers[0].d.startsWith("M700,0"), r.layers[0].d);
});

test("layoutHighlight：只有 rgba 的透明度为 0 才算透明，rgb(255,255,0) 照常画", () => {
  const r = layoutHighlight({ ...BOX, quads: [{ points: BOX.quads[0].points, color: "rgb(255,255,0)" }] }, VIEW, DEVICE, 0);
  assert.equal(r.layers.length, 1);
});
