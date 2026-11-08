/**
 * 推荐值算法 + 偏离审计
 * -----------------------------------------------------------------
 * **本文件不在运行时路径上。** 游戏跑起来只需要模板里手填的那三个值。
 * 这里算出来的东西只给三件事用：
 *   1. 新加模板时填初值
 *   2. balanceReport() 做偏离审计，防止数值在几十次改动里慢慢跑飞
 *   3. 改完常数后一键复核全表
 *
 * 每个值有独立的物理含义，不共用一个公式硬凑：
 *   capacity   占多大地方     （口径 / 单发投送能量 + 尺寸下限）
 *   buildTime  造它多麻烦     （尺寸 + 效能：穿透、多目标、追踪、射程）
 *   command    值多少人口     （生存力 + 装备预算）
 *
 * 常数全在文件顶部，改常数 = 重新平衡全表。
 */

import { HULL_TEMPLATES, SIZE_RANK, slotVolume } from "./hull-templates.js";
import { PLUGIN_TEMPLATES } from "./plugin-templates.js";
import { ABILITY_TEMPLATES } from "./ability-templates.js";
import { WEAPONS } from "../sim/weapons.js";
import { round1 } from "./util.js";

// ---------------------------------------------------------------
// 船体
// ---------------------------------------------------------------

/** 承载量 = Σ槽位容积 × 这个比例（留两成余量，让玩家必须取舍） */
export const FILL_RATIO = 0.80;

export const COMMAND_W = { hp: 1 / 15, shield: 1 / 30, capacity: 1 / 40 };

export const CLASS_TIME_MUL = {
  frigate: 2.0,
  destroyer: 2.6,
  cruiser: 2.9,
  mothership: 0
};

// ---------------------------------------------------------------
// 武器
// ---------------------------------------------------------------

/** 每个尺寸的承载量下限：口径再小，这么大个槽也占这么多地方 */
export const SIZE_FLOOR = { S: 2, M: 5, L: 9 };

/** 激光 = 3 点承载的基准 */
export const WEAPON_CAP_ANCHOR = 3;

/** 承载 → 工时的系数 */
export const WEAPON_BT_K = 0.34;

// ---------------------------------------------------------------
// 插件 / 能力
// ---------------------------------------------------------------

export const MOD_WEIGHT = {
  hp: 0.10,
  hpRegen: 0.50,
  shield: 0.10,
  shieldRegen: 0.50,
  hullHitR: 0.65,
  shieldHitR: 0.65,
  capacity: 1.00,     // 承载力本身就是货币，按 1:1
  fireRate: 12.0      // 作用于 |1 − v|
};

export const PLUGIN_CAP_DIVISOR = 1.2;
export const PLUGIN_BT_K = 0.4;

/** 扩容类插件必须满足「占用 ≥ 加成 × 这个比例」，否则可以无限叠 */
export const CAPACITY_RETURN_LIMIT = 0.8;

/** 支援能力的吞吐量 = rate × 目标数 + grant × 这个权重 */
export const ABILITY_GRANT_WEIGHT = 0.5;
export const ABILITY_THROUGHPUT_DIVISOR = 8;
export const ABILITY_BT_K = 0.45;

// ---------------------------------------------------------------
// 审计阈值
// ---------------------------------------------------------------

export const DRIFT_OK = 0.20;
export const DRIFT_WARN = 0.50;

// ===============================================================

/** 单发投送能量：装填速度不占地方，口径才占 */
export function weaponPower(w) {
  const burst = w.fire?.burst || 1;
  const blastDmg = w.impact?.blastDmg || 0;
  const blastR = w.impact?.blastR || 0;
  return (w.impact?.dmg || 0) * (1 + 0.25 * (burst - 1)) + 0.5 * (blastDmg + blastR);
}

export function weaponCaliber(w) {
  return Math.pow(Math.max(0.001, weaponPower(w)), 0.6);
}

/** 激光的口径，作为承载量的换算基准 */
function caliberAnchor() {
  return weaponCaliber(WEAPONS.laser);
}

function weaponRange(w) {
  if (!w.travel) return 0;
  return w.delivery === "hitscan"
    ? w.travel.range
    : (w.travel.speed || 0) * (w.travel.lifetime || 0);
}

/** 效能系数：工时反映加工难度 */
export function weaponEffort(w) {
  const maxHits = Math.max(1, w.hit?.maxHits || 1);
  const pierce = w.impact?.pierceShield ? 1 : 0;
  const track = Math.min(1, (w.travel?.turnRate || 0) / 2.5);
  const longRange = weaponRange(w) > 350 ? 1 : 0;
  return 1 + 0.10 * (maxHits - 1) + 0.15 * pierce + 0.10 * track + 0.05 * longRange;
}

export function recommendWeapon(w) {
  const rec = Math.max(
    SIZE_FLOOR[w.size] ?? 2,
    Math.round(WEAPON_CAP_ANCHOR * weaponCaliber(w) / caliberAnchor())
  );
  return {
    capacity: rec,
    buildTime: round1(rec * WEAPON_BT_K * weaponEffort(w)),
    command: 0
  };
}

export function recommendHull(h) {
  // 承载量由槽位布局推：槽位是「想装几件」的设计声明，承载量是「空间够不够」。
  // 反过来推（先定 60 点空间再切槽）会出现「槽全装满也用不到 60」的死值。
  const capacity = Math.round(slotVolume(h) * FILL_RATIO);

  // 注意：command 用**手填的** capacity，不回读刚算出来的 capacity
  const raw =
    h.armor.hp * COMMAND_W.hp +
    h.armor.shield * COMMAND_W.shield +
    h.capacity * COMMAND_W.capacity;
  const command = h.class === "mothership" ? 0 : Math.max(1, Math.round(raw));

  // buildTime 用手填的 command
  const buildTime = round1(h.command * (CLASS_TIME_MUL[h.class] ?? 0));

  return { capacity, command, buildTime };
}

/** 插件 mods 部分的推荐承载与工时 */
export function recommendMods(mods = {}) {
  const keys = Object.keys(mods);
  if (keys.length === 0) return { capacity: 0, buildTime: 0 };

  let score = 0;
  for (const k of keys) {
    const v = Math.abs(mods[k]);
    if (k === "fireRate") score += Math.abs(1 - mods[k]) * MOD_WEIGHT.fireRate;
    else score += v * (MOD_WEIGHT[k] ?? 0);
  }

  let capacity = Math.max(1, Math.round(score / PLUGIN_CAP_DIVISOR));

  // 硬约束：带 mods.capacity 的插件必须「占用 ≥ 加成 × 0.8」
  if (mods.capacity) {
    capacity = Math.max(capacity, Math.ceil(mods.capacity * CAPACITY_RETURN_LIMIT));
  }

  return { capacity, buildTime: round1(capacity * PLUGIN_BT_K) };
}

export function recommendAbility(a) {
  const throughput = a.rate * a.maxTargets + (a.grant || 0) * ABILITY_GRANT_WEIGHT;
  const capacity = Math.max(1, Math.round(throughput / ABILITY_THROUGHPUT_DIVISOR));
  return {
    capacity,
    buildTime: round1(capacity * ABILITY_BT_K),
    command: 0
  };
}

export function recommendPlugin(p) {
  const m = recommendMods(p.mods);
  let cap = m.capacity;
  let bt = m.buildTime;

  for (const ref of p.abilities || []) {
    const a = ABILITY_TEMPLATES[ref.id];
    if (!a) continue;
    const count = Math.max(1, ref.count || 1);
    // count 只放大吞吐量（同时照顾更多目标），单价按单台算再乘
    const r = recommendAbility({ ...a, maxTargets: a.maxTargets * count });
    cap = Math.max(cap, r.capacity);
    bt += r.buildTime;
  }

  return { capacity: cap, buildTime: round1(bt), command: 0 };
}

// ===============================================================

/** 偏离分级 */
export function driftLevel(drift) {
  const d = Math.abs(drift);
  if (d <= DRIFT_OK + 1e-9) return "ok";
  if (d <= DRIFT_WARN + 1e-9) return "warn";
  return "alert";
}

function driftRow(id, field, value, recommended) {
  let drift;
  if (recommended === 0) drift = value === 0 ? 0 : Infinity;
  else drift = (value - recommended) / recommended;
  return {
    id, field, value, recommended,
    drift: Number.isFinite(drift) ? Math.round(drift * 1000) / 1000 : 999,
    level: driftLevel(drift)
  };
}

/**
 * 全表偏离审计。
 * @returns {Array<{id,field,value,recommended,drift,level}>}
 */
export function balanceReport(tables = {}) {
  const hulls = tables.hulls || HULL_TEMPLATES;
  const weapons = tables.weapons || WEAPONS;
  const plugins = tables.plugins || PLUGIN_TEMPLATES;

  const rows = [];

  for (const h of Object.values(hulls)) {
    const r = recommendHull(h);
    rows.push(driftRow(h.id, "capacity", h.capacity, r.capacity));
    rows.push(driftRow(h.id, "command", h.command, r.command));
    rows.push(driftRow(h.id, "buildTime", h.buildTime, r.buildTime));
  }

  for (const w of Object.values(weapons)) {
    // 防御塔专用武器不在构筑经济里，不参与审计
    if (w.mountable === false) continue;
    const r = recommendWeapon(w);
    rows.push(driftRow(w.id, "capacity", w.capacity ?? 0, r.capacity));
    rows.push(driftRow(w.id, "buildTime", w.buildTime ?? 0, r.buildTime));
    rows.push(driftRow(w.id, "command", w.command ?? 0, r.command));
  }

  for (const p of Object.values(plugins)) {
    const r = recommendPlugin(p);
    rows.push(driftRow(p.id, "capacity", p.capacity ?? 0, r.capacity));
    rows.push(driftRow(p.id, "buildTime", p.buildTime ?? 0, r.buildTime));
    rows.push(driftRow(p.id, "command", p.command ?? 0, r.command));
  }

  return rows;
}

/** 统计各等级条数，CI 里最常用的一句 */
export function balanceSummary(rows) {
  const out = { ok: 0, warn: 0, alert: 0 };
  for (const r of rows) out[r.level]++;
  return out;
}

export { slotVolume, SIZE_RANK };
