/**
 * 确定性随机数
 * -----------------------------------------------------------------
 * 为什么要有这个：调平衡、改构筑、对比 A/B 都需要「同一个种子跑出同一场战斗」。
 * 没有种子的时候，任何数值改动都只能靠肉眼看出「好像变强了」。
 *
 * 用法：
 *   seedRng(1234)   在 core.reset() 里调一次
 *   rand()          模拟层里唯一允许的随机源
 *
 * 纪律：
 *   1. sim/ 下**不允许**再出现 Math.random()
 *   2. 渲染层可以用 Math.random()（纯表现，不影响战斗结果）
 *   3. 每局开始时 seed 一次，重置整局 = 重置种子 = 完全复现
 *
 * 算法用 mulberry32：32 位状态、单次调用约 5ns、周期 2^32，够用且实现只有五行。
 */

let state = 0x9e3779b9;

/** 设置种子（相同种子 → 相同序列）。0 会被换成默认值，避免退化。 */
export function seedRng(seed) {
  const s = (Number(seed) >>> 0) || 0x9e3779b9;
  state = s;
  return s;
}

/** 读取当前内部状态，用于存档或断点复现 */
export function rngState() {
  return state;
}

/** [0, 1) */
export function rand() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** [a, b) */
export function randRange(a, b) {
  return a + (b - a) * rand();
}

/** [0, n) 的整数 */
export function randInt(n) {
  return Math.floor(rand() * n);
}
