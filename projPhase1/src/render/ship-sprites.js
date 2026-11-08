/**
 * 舰船像素贴图
 * -----------------------------------------------------------------
 * 素材：public/imgs/frigate.png（256×256，8×8 格，每格 32×32，共 64 张船图）。
 * 图里的船头朝**上**（-y），渲染时按航向旋转 +90°。
 *
 * 舰船身上没有方案引用，那怎么决定用哪张图？
 * 用**属性**做稳定哈希：`最大血量 | 受击半径 | 武器槽数`。
 * 同一型号的船属性完全一样 → 永远拿到同一张图；不同类型自然分散到不同图。
 * 尺寸也由属性推：受击半径越大，贴图越大（堡垒级看着就该比矛隼大）。
 */

import { Rectangle, Texture } from "pixi.js";

// 相对文档解析：开发（/）与构建后（/dist/）都能找到 public/imgs 里的图
const SHEET_URL = new URL("imgs/frigate.png", document.baseURI).href;
const CELL = 32;
const COLS = 8;
const ROWS = 8;

/**
 * @returns {Promise<{frames:Texture[], count:number}>}
 */
export async function loadShipAtlas() {
  const img = new Image();
  img.src = SHEET_URL;
  await img.decode();

  // 素材本身偏暗，深色战场上乘算着色后会糊成一片。
  // 先整体提亮一档，再交给 tint 上阵营色。
  const sheet = brighten(img);

  const base = Texture.from(sheet);
  base.source.scaleMode = "nearest";        // 像素风：不插值

  const frames = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      frames.push(new Texture({
        source: base.source,
        frame: new Rectangle(c * CELL, r * CELL, CELL, CELL)
      }));
    }
  }
  return { frames, count: frames.length };
}

/** 提亮 + 轻微加对比的离屏拷贝；不支持 ctx.filter 就原图返回 */
function brighten(img) {
  const w = img.width || COLS * CELL;
  const h = img.height || ROWS * CELL;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  if (!ctx) return img;

  ctx.imageSmoothingEnabled = false;
  if ("filter" in ctx) ctx.filter = "brightness(1.42) contrast(1.06)";
  ctx.drawImage(img, 0, 0);
  return "filter" in ctx ? cv : img;
}

/** FNV-1a：属性 → 稳定的图序号 */
function hashKey(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 一艘船用哪张图（同型号恒定） */
export function variantOf(u, count) {
  const key = `${u.maxHp}|${u.hitR}|${u.weapons ? u.weapons.length : 0}`;
  return hashKey(key) % count;
}

/** 一艘船画多大（世界像素） */
export function sizeOf(u) {
  const r = u.hitR === undefined ? 6 : u.hitR;
  return Math.max(22, Math.min(64, 14 + r * 2.6));
}
