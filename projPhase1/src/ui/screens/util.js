/**
 * 构筑界面共用的小工具
 * -----------------------------------------------------------------
 * 两个界面（舰船设计 / 小队构筑）都要：像素船图缩略图、按签名重绘 DOM。
 */

/** 素材布局：256×256，8×8 格 */
const ATLAS_COLS = 8;

/**
 * 图集地址：相对**文档**解析，开发（/）和构建后（/dist/）都对。
 * CSS 里没法用 import.meta，所以在这里算好塞进变量。
 */
export const SPRITE_SHEET_URL = new URL("imgs/frigate.png", document.baseURI).href;
document.documentElement.style.setProperty(
  "--sprite-url", `url("${SPRITE_SHEET_URL}")`);

/**
 * 船体 → 图集里的格子坐标。
 * 优先用船体模板里的 sprite.frame（"frigate_01"）；没有就按 id 哈希。
 */
export function spriteCell(hull, catalogHull) {
  const frame = catalogHull?.sprite?.frame || hull?.sprite?.frame || "";
  const m = /(\d+)$/.exec(frame);
  if (m) {
    const idx = (Number(m[1]) - 1) % 64;
    return { col: idx % ATLAS_COLS, row: Math.floor(idx / ATLAS_COLS) };
  }
  const key = (hull?.id || hull || "x").toString();
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = (h >>> 0) % 64;
  return { col: idx % ATLAS_COLS, row: Math.floor(idx / ATLAS_COLS) };
}

/** 给 .sprite 元素摆好背景（配合 style.css 里的尺寸类） */
export function applySprite(el, cell) {
  el.style.backgroundPosition =
    `calc(${-cell.col} * var(--u)) calc(${-cell.row} * var(--u))`;
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
