/**
 * 船图图集表（唯一真相源）
 * -----------------------------------------------------------------
 * 三个界面都要画船，但画法完全不同：
 *   战斗界面   Pixi 的 Sprite（WebGL，每帧重绘，按航向旋转）
 *   设计舰船   DOM 的 `<i class="sprite">`（CSS background-position 切片）
 *   小队构筑   同上
 *
 * 它们**必须共用同一张表**，否则同一条船在三个地方长得不一样。
 * 本文件只放数据与纯函数：不碰 document、不碰 Pixi，Node 里能直接跑。
 *
 * 图集清单：
 *   frigate     256×256，8×8 格，每格 32×32  —— 护卫舰 / 驱逐舰 / 巡洋舰
 *   mothership  512×512，4×4 格，每格 128×128 —— 母舰
 */

export const SPRITE_SHEETS = {
  frigate: { file: "frigate2.png", cell: 32, cols: 8, rows: 8 },
  mothership: { file: "mothership.png", cell: 128, cols: 4, rows: 4 }
};

export const DEFAULT_SHEET = "frigate";

/** 某图集的帧数（= cols × rows） */
export function frameCount(sheetKey) {
  const s = SPRITE_SHEETS[sheetKey] || SPRITE_SHEETS[DEFAULT_SHEET];
  return s.cols * s.rows;
}

/**
 * 把船体模板里的 `sprite` 声明归一化成 `{ sheet, index }`。
 *
 * 兼容两种写法：
 *   { sheet: "frigate", index: 12 }   ← 现在用的
 *   { sheet: "frigate", frame: "frigate_01" }  ← 旧写法的名字（尾部数字 - 1）
 *
 * 返回 null 表示"没配"，调用方该退回按属性哈希。
 */
export function frameOf(sprite) {
  if (!sprite) return null;

  const sheet = SPRITE_SHEETS[sprite.sheet] ? sprite.sheet : DEFAULT_SHEET;

  if (Number.isInteger(sprite.index) && sprite.index >= 0) {
    return { sheet, index: sprite.index % frameCount(sheet) };
  }

  const m = /(\d+)\s*$/.exec(String(sprite.frame || ""));
  if (m) {
    const n = Number(m[1]) - 1;                 // "frigate_01" → 0
    if (n >= 0) return { sheet, index: n % frameCount(sheet) };
  }
  return null;
}

/** `{sheet,index}` 或旧写法 → 单位身上的 skin 字符串（"frigate#12"） */
export function skinOf(sprite) {
  const f = frameOf(sprite);
  return f ? `${f.sheet}#${f.index}` : null;
}

/** "frigate#12" → { sheet, index }；格式不对返回 null */
export function parseSkin(skin) {
  if (typeof skin !== "string") return null;
  const at = skin.indexOf("#");
  if (at <= 0) return null;
  const sheet = skin.slice(0, at);
  const index = Number(skin.slice(at + 1));
  if (!SPRITE_SHEETS[sheet]) return null;
  if (!Number.isInteger(index) || index < 0 || index >= frameCount(sheet)) return null;
  return { sheet, index };
}

/** 帧下标 → 栅格坐标（CSS 切片与 Pixi Rectangle 都用它） */
export function cellOf(frame) {
  const s = SPRITE_SHEETS[frame.sheet] || SPRITE_SHEETS[DEFAULT_SHEET];
  return {
    sheet: frame.sheet in SPRITE_SHEETS ? frame.sheet : DEFAULT_SHEET,
    col: frame.index % s.cols,
    row: Math.floor(frame.index / s.cols),
    cellW: s.cell,
    cellH: s.cell,
    cols: s.cols,
    rows: s.rows
  };
}

/** FNV-1a：没配 sprite 时的兜底挑图（稳定，但只是"随便给一张"） */
export function hashFrame(key, sheetKey = DEFAULT_SHEET) {
  const text = String(key);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return { sheet: sheetKey, index: (h >>> 0) % frameCount(sheetKey) };
}
