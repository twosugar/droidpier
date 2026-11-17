// DevTools 高亮画在设备画面上（网关算好的 HighlightBox，见 gateway/src/inspect.ts 的 highlightBox）
import { fromDevice } from "../../shared/input-map.ts";
import type { HighlightBox, Rotation } from "../../shared/protocol.ts";

const LABEL_HEIGHT = 22;
const LABEL_GAP = 4;
/** 等宽字 12px 一个字符约 7.2px，加左右内边距；只用来把标注夹在画布内，不用很准。 */
const labelWidth = (text: string, size: string) => Math.ceil((text.length + size.length + 1) * 7.2 + 16);

export type HighlightLayout = {
  polygons: Array<{ points: string; color: string }>;
  label: { text: string; size: string; left: number; top: number; width: number } | null;
};

/** 把面板坐标的高亮换成画布（CSS 像素，左上角为原点）上的多边形和标注位置。 */
export function layoutHighlight(box: HighlightBox, view: { width: number; height: number }, device: { width: number; height: number }, rotation: Rotation): HighlightLayout {
  const rect = { left: 0, top: 0, width: view.width, height: view.height };
  const round = (n: number) => Math.round(n * 10) / 10;
  let minX = Infinity, minY = Infinity, maxY = -Infinity;
  const polygons = box.quads.map((q) => {
    const pts: string[] = [];
    for (let i = 0; i + 1 < q.points.length; i += 2) {
      const p = fromDevice({ x: q.points[i], y: q.points[i + 1] }, rect, device, rotation);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
      pts.push(`${round(p.x)},${round(p.y)}`);
    }
    return { points: pts.join(" "), color: q.color };
  });
  if (!box.label || !polygons.length) return { polygons, label: null };
  const width = Math.min(labelWidth(box.label, box.size), view.width);
  // 和 Chrome 一样放在框的上方，放不下时放到下方；左右夹在画布内
  const above = minY - LABEL_HEIGHT - LABEL_GAP;
  const top = above >= 0 ? above : Math.min(maxY + LABEL_GAP, view.height - LABEL_HEIGHT);
  const left = Math.max(0, Math.min(minX, view.width - width));
  return { polygons, label: { text: box.label, size: box.size, left: round(left), top: round(top), width } };
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** 在 overlay（盖在画布上、不接鼠标的 div）里画出高亮；box 为 null 时清空。 */
export function drawHighlight(overlay: HTMLElement, box: HighlightBox | null, view: { width: number; height: number }, device: { width: number; height: number }, rotation: Rotation): void {
  overlay.replaceChildren();
  if (!box || !view.width || !device.width) return;
  const l = layoutHighlight(box, view, device, rotation);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(view.width));
  svg.setAttribute("height", String(view.height));
  svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible";
  for (const p of l.polygons) {
    const poly = document.createElementNS(SVG_NS, "polygon");
    poly.setAttribute("points", p.points);
    poly.setAttribute("fill", p.color);
    svg.append(poly);
  }
  overlay.append(svg);
  if (!l.label) return;
  const tag = document.createElement("div");
  tag.style.cssText = `position:absolute;left:${l.label.left}px;top:${l.label.top}px;max-width:${l.label.width}px;height:${LABEL_HEIGHT}px;box-sizing:border-box;padding:0 8px;display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;background:#fff;color:#881280;border-radius:3px;box-shadow:0 1px 4px rgba(0,0,0,.3);font:12px/1 ui-monospace,Menlo,monospace`;
  const name = document.createElement("span");
  name.textContent = l.label.text;
  const size = document.createElement("span");
  size.style.color = "#555";
  size.textContent = l.label.size;
  tag.append(name, size);
  overlay.append(tag);
}
