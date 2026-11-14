/**
 * 构筑界面共用的小工具
 * -----------------------------------------------------------------
 * 两个界面（舰船设计 / 小队构筑）都要：像素船图缩略图、按签名重绘 DOM。
 *
 * 船图**和战斗界面用同一张表**（`core/data/sprite-atlas.js`）：
 * 同一条船在三个地方必须是同一张图，所以图集清单、帧下标换算、兜底哈希全部从那里来。
 * 这里只负责把它翻译成 CSS 的 background-image / -size / -position。
 */

import { SPRITE_SHEETS, DEFAULT_SHEET, frameOf, cellOf, hashFrame } from "../../core/data/sprite-atlas.js";
import { getHull } from "../../core/data/hull-templates.js";

/**
 * 图集地址：相对**文档**解析，开发（/）和构建后（/dist/）都对。
 * CSS 里没法用 import.meta，所以在这里算好。
 */
const URLS = {};
for (const key of Object.keys(SPRITE_SHEETS)) {
  URLS[key] = new URL("imgs/" + SPRITE_SHEETS[key].file, document.baseURI).href;
}

/** 默认图集的地址（CSS 里的兜底背景用） */
export const SPRITE_SHEET_URL = URLS[DEFAULT_SHEET];
document.documentElement.style.setProperty("--sprite-url", `url("${SPRITE_SHEET_URL}")`);

/**
 * 船体 / 舰船方案 → 栅格坐标。
 *   优先级：catalogHull.sprite → hullId 对应的船体模板 → hull.sprite → 按 id 哈希
 * @param {{id?:string, sprite?:object}|string} hull
 * @param {{sprite?:object}} [catalogHull]
 * @returns {{sheet, col, row, cellW, cols, rows}}
 */
export function spriteCell(hull, catalogHull) {
  const hullId = typeof hull === "string" ? hull : hull?.id;

  const declared =
    catalogHull?.sprite ||
    (hullId ? getHull(hullId)?.sprite : null) ||
    (typeof hull === "object" ? hull?.sprite : null);

  const frame = frameOf(declared);
  if (frame) return cellOf(frame);

  // 没配 sprite：退回稳定哈希（和渲染层的兜底同一套规则）
  return cellOf(hashFrame(hullId || "x"));
}

/** 取渲染用的图集地址 */
export function spriteUrl(sheet) {
  return URLS[sheet] || URLS[DEFAULT_SHEET];
}

/**
 * 栅格坐标 → 一段可以直接塞进 `style="..."` 的 CSS。
 * 用 `calc(N * var(--u))` 而不是像素值，这样同一段样式在 .mini / .sm / .card / .lg
 * 四个尺寸类下都成立（--u 由 CSS 给出）。
 */
export function spriteStyle(cell) {
  const sheet = SPRITE_SHEETS[cell.sheet] || SPRITE_SHEETS[DEFAULT_SHEET];
  // ⚠ 这段字符串要塞进 `style="..."` 属性里，所以 url 必须用**单引号**：
  //   写成 url("…") 会让属性提前闭合，后面的声明全部丢失（列表缩略图会直接消失）。
  return [
    `background-image:url('${spriteUrl(cell.sheet)}')`,
    `background-size:calc(${sheet.cols} * var(--u)) calc(${sheet.rows} * var(--u))`,
    `background-position:calc(${-cell.col} * var(--u)) calc(${-cell.row} * var(--u))`
  ].join(";");
}

/** 给已经在文档里的 `.sprite` 元素摆好背景（与 spriteStyle 同一套规则） */
export function applySprite(el, cell) {
  const sheet = SPRITE_SHEETS[cell.sheet] || SPRITE_SHEETS[DEFAULT_SHEET];
  el.style.backgroundImage = `url("${spriteUrl(cell.sheet)}")`;
  el.style.backgroundSize = `calc(${sheet.cols} * var(--u)) calc(${sheet.rows} * var(--u))`;
  el.style.backgroundPosition = `calc(${-cell.col} * var(--u)) calc(${-cell.row} * var(--u))`;
}

/**
 * 只在签名变化时才重建 DOM —— 10 Hz 的快照不该把下拉框/滚动位置冲掉。
 * @returns 这次是否真的重绘了
 */
export function paint(el, sig, build) {
  if (el.dataset.sig === sig) return false;
  el.dataset.sig = sig;
  el.innerHTML = build();
  return true;
}

/** 数字显示：整数就直接给，小数留一位 */
export function fmtNum(v) {
  if (!Number.isFinite(v)) return "0";
  return Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1);
}

/** 承载/属性这种「+3」显示 */
export function fmtSigned(v) {
  if (!v) return "";
  return (v > 0 ? "+" : "") + fmtNum(v);
}
