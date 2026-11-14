/**
 * 舰船像素贴图（多图集）
 * -----------------------------------------------------------------
 * 两张图集，各管一摊：
 *   frigate2.png    256×256，8×8 格，每格 32×32 —— 护卫舰 / 驱逐舰 / 巡洋舰
 *   mothership.png  512×512，4×4 格，每格 128×128，共 13 帧 —— 母舰
 *
 * 素材里的船头朝**上**（-y），渲染时按航向旋转 +90°。
 *
 * 舰船身上没有方案引用，那怎么决定用哪张图？
 *   **用船体模板的 `sprite` 字段**（hull-templates.js）：
 *     sprite: { sheet: "frigate", index: 12 }
 *   编译时抄进运行时规格（compileShip），造出来那一刻写到单位身上（u.skin）。
 *   同型号恒定同一张图，不同船体各有各的样子。
 *
 * 尺寸仍由受击半径推：受击半径越大，贴图越大（堡垒级看着就该比矛隼大）。
 * 注意这是**表现层**的缩放，和碰撞半径不是一回事（见迁移设计 §3.2.6）。
 */

import { Rectangle, Texture } from "pixi.js";
import {
  SPRITE_SHEETS, DEFAULT_SHEET, parseSkin, hashFrame
} from "../core/data/sprite-atlas.js";

/** 相对文档解析：开发（/）与构建后（/dist/）都能找到 public/imgs 里的图 */
const imgUrl = file => new URL("imgs/" + file, document.baseURI).href;

/**
 * 加载全部图集。
 * @returns {Promise<Map<string, {key, frames, count, cell, cols, rows}>>}
 */
export async function loadShipAtlases() {
  const out = new Map();
  for (const key of Object.keys(SPRITE_SHEETS)) {
    out.set(key, await loadSheet(key, SPRITE_SHEETS[key]));
  }
  return out;
}

async function loadSheet(key, def) {
  const img = new Image();
  img.src = imgUrl(def.file);
  await img.decode();

  // 素材本身偏暗，深色战场上乘算着色后会糊成一片。
  // 先整体提亮一档，再交给 tint 上阵营色。
  const sheet = brighten(img);

  const base = Texture.from(sheet);
  base.source.scaleMode = "nearest";        // 像素风：不插值

  const frames = [];
  for (let r = 0; r < def.rows; r++) {
    for (let c = 0; c < def.cols; c++) {
      const tex = new Texture({
        source: base.source,
        frame: new Rectangle(c * def.cell, r * def.cell, def.cell, def.cell)
      });
      tex.cellW = def.cell;                 // 渲染时按这个算缩放比
      frames.push(tex);
    }
  }
  return { key, frames, count: frames.length, cell: def.cell, cols: def.cols, rows: def.rows };
}

/** 提亮 + 轻微加对比的离屏拷贝；不支持 ctx.filter 就原图返回 */
function brighten(img) {
  const w = img.width || 256;
  const h = img.height || 256;
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

/** FNV-1a：属性 → 稳定的图序号（只在船体没配 sprite 时兜底用） */
function hashKey(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 一艘船用哪张图。
 * 优先用单位身上带的 skin（`"frigate#12"`），没有就按属性哈希到默认图集。
 */
export function resolveFrame(atlases, u) {
  // 1) 单位身上带的正解：skin = "图集名#帧下标"
  const parsed = parseSkin(u && u.skin);
  if (parsed) {
    const atlas = atlases.get(parsed.sheet);
    if (atlas && parsed.index < atlas.count) return atlas.frames[parsed.index];
  }

  // 2) 兜底：没配 sprite 的船体也能画出来（和构筑界面同一套哈希规则）
  const atlas = atlases.get(DEFAULT_SHEET) || atlases.values().next().value;
  if (!atlas) return null;
  const key = `${u.maxHp}|${u.hitR}|${u.weapons ? u.weapons.length : 0}`;
  const fallback = hashFrame(key, atlas.key);
  return atlas.frames[fallback.index % atlas.count];
}

/** 一艘船画多大（世界像素）。受击半径越大越大，夹 22–64。 */
export function sizeOf(u) {
  const r = u.hitR === undefined ? 6 : u.hitR;
  return Math.max(22, Math.min(64, 14 + r * 2.6));
}
