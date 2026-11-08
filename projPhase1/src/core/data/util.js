/**
 * 数据层公用小工具
 * -----------------------------------------------------------------
 * 只放「没有领域含义」的纯函数，避免各模板文件互相 import 造成环。
 */

/** 四舍五入到 1 位小数（0.1 秒、0.1 点） */
export function round1(v) {
  return Math.round(v * 10) / 10;
}

/** 四舍五入到 2 位小数 */
export function round2(v) {
  return Math.round(v * 100) / 100;
}

/** 夹取 */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 深冻结。模板表是只读的，运行期任何就地修改都应当直接抛错（严格模式下赋值报错），
 * 而不是悄悄改掉别人的平衡数据。
 */
export function deepFreeze(obj) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v);
  }
  return Object.freeze(obj);
}
