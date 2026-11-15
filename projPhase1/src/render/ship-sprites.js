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
  SPRITE_SHEETS, DEFAULT_SHEET, parseSkin, hashFrame, shipDrawSize
} from "../core/data/sprite-atlas.js";

/** 相对文档解析：开发（/）与构建后（/dist/）都能找到 public/imgs 里的图 */
const imgUrl = file => new URL("imgs/" + file, document.baseURI).href;

/** 没有 sidecar 时的兜底：32px 的格里船体约 18px 宽（= 32/18 ≈ 1.78） */
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

  // 同一张图旁边的 sidecar（由 tools/measure-sprites.mjs 离线量出来）。
  // 拿不到也不致命：sizeOf 会退回"中位系数"，只是墙边会残余 ±10% 的宽度误差。
  const meta = await loadMeta(def.file);

  // 素材本身偏暗，深色战场上乘算着色后会糊成一片。
  // 先整体提亮一档，再交给 tint 上阵营色。
  const sheet = brighten(img);

  const base = Texture.from(sheet);
  base.source.scaleMode = "nearest";        // 像素风：不插值

  const frames = [];
  for (let r = 0; r < def.rows; r++) {
    for (let c = 0; c < def.cols; c++) {
      const index = r * def.cols + c;
      const tex = new Texture({
        source: base.source,
        frame: new Rectangle(c * def.cell, r * def.cell, def.cell, def.cell)
      });
      tex.cellW = def.cell;                       // 渲染时按这个算缩放比
      tex.bboxW = meta?.frames?.[index]?.w || 0;  // 船体实际占多宽（0 = 没有 sidecar）
      tex.bboxH = meta?.frames?.[index]?.h || 0;
      frames.push(tex);
    }
  }
  return { key, frames, count: frames.length, cell: def.cell, cols: def.cols, rows: def.rows, meta };
}

/** 读同名 sidecar；失败返回 null（游戏必须能跑） */
async function loadMeta(file) {
  const url = imgUrl(file.replace(/\.png$/i, ".json"));
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const doc = await res.json();
    if (doc?.schema !== "sprite-atlas/1") {
      console.warn(`[ship-sprites] ${file} 的 sidecar 版本不对，按缺失处理`);
      return null;
    }
    return doc;
  } catch {
    console.warn(`[ship-sprites] 读不到 ${file} 的 sidecar，sizeOf 走兜底系数`);
    return null;
  }
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

/**
 * 一艘船画多大（世界像素）。
 *
 * **让贴图里船体的横向可见宽度正好等于 2 × radius**：
 *
 *     sizeOf = 2r × (cellW / bboxW)
 *
 * 这样船与墙、船与船看到的边界和碰到的边界是同一个 —— 墙边不会再有贴图插进去。
 *
 * 为什么不能直接写 `2r`：素材有透明边距。32×32 的格里船体只占 18 像素宽，
 * 直接画 2r 会让可见宽度只有 `2r × 18/32 = 0.56 × 2r`（矛隼只有 6.8 px，基本看不见）。
 *
 * `bboxW` 来自图片旁边的 sidecar（tools/measure-sprites.mjs 离线量）。
 * 没有 sidecar 时退回中位系数 32/18 ≈ 1.78，最多差 ±10% 宽度。
 */
export function sizeOf(u, tex) {
  return shipDrawSize(u.hitR, tex && tex.cellW, tex && tex.bboxW);
}
