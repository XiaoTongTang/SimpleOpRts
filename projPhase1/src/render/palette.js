/**
 * 阵营配色
 * -----------------------------------------------------------------
 * 小队不再有独立颜色：所有单位只区分**阵营**。
 * 色相与主色的唯一来源是 sim 层的 FACTION_HUE / FACTION_COLOR，
 * 免得规则层和渲染层各写一份。
 */

import { FACTION_HUE, FACTION_COLOR } from "../core/sim/squad-layer.js";

export { FACTION_HUE, FACTION_COLOR };

/** 阵营主色的 Pixi 数值形式（0xRRGGBB）
 *  比 CSS 主色更亮一档：这层是**乘算**着色，灰底贴图乘上去会变暗，
 *  亮一点才能在深色战场上看得清。 */
export const FACTION_TINT = [0x9ed2ff, 0xffa294];

/** 没归属时的兜底色 */
export const NEUTRAL_HUE = 200;

/** 血量条颜色：绿 → 黄 → 红 */
export function hpColor(hp, maxHp) {
  const f = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  return f > 0.5 ? 0x5fd97a : f > 0.25 ? 0xe8c14a : 0xe8564f;
}

/** 阵营对应的色相 */
export function hueOf(faction) {
  return FACTION_HUE[faction] ?? NEUTRAL_HUE;
}

/**
 * HSL（0~360 / 0~100 / 0~100）→ 0xRRGGBB。
 * 渲染层要往 Pixi 的 fill/stroke 里塞颜色，而数据里传的是 hue。
 */
export function hslHex(h, s, l) {
  const c = (1 - Math.abs(2 * (l / 100) - 1)) * (s / 100);
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l / 100 - c / 2;
  const to = v => Math.max(0, Math.min(255, Math.round((v + m) * 255)));
  return (to(r) << 16) | (to(g) << 8) | to(b);
}

/** hsla 的数值版：hue/sat/light 百分比 + alpha */
export function hsla(h, s, l, a = 1) {
  return { color: hslHex(h, s, l), alpha: a };
}
