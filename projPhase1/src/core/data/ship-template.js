/**
 * 舰船模板 ShipTemplate
 * -----------------------------------------------------------------
 * 一个舰船模板 = 船体 + 每个插槽里装了什么。这是玩家自己制作、保存、随时改的方案。
 *
 * 本文件负责四件事：
 *   computeShip()   校验 + 算 derived（唯一算账入口，UI 与 core 都调它）
 *   compileShip()   压成 sim 认的运行时参数（sq.p.* 那一套）
 *   setFit()        改一个插槽，返回新对象，不改入参
 *   createShipTemplate() 新建一个空装配方案
 *
 * 关键约定：
 *   1. command / buildTime 是加法（船体 + Σ装备），capacity 是「船体给上限、装备占用量」
 *   2. ok=false 时 derived 也要给全 —— UI 要能立刻显示「承载量 17 / 14」这种红字
 *   3. 幂等：不改入参、不读时间、不读随机数
 */

import { HULL_TEMPLATES, findSlot, getHull, SIZE_RANK, slotIds } from "./hull-templates.js";
import { PLUGIN_TEMPLATES, getPlugin } from "./plugin-templates.js";
import { ABILITY_TEMPLATES } from "./ability-templates.js";
import { WEAPONS } from "../sim/weapons.js";
import { round1, round2 } from "./util.js";

/** 空装配：每个插槽都给一个 null，UI 靠这些键铺格子 */
export function createDefaultFit(hullId) {
  const hull = getHull(hullId);
  if (!hull) return null;
  const fit = {};
  for (const id of slotIds(hull)) fit[id] = null;
  return fit;
}

/** 新建一个空装配方案 */
export function createShipTemplate({ id, name, hull: hullId, now = 0 }) {
  const hull = getHull(hullId);
  if (!hull) throw new Error(`未知船体 ${hullId}`);
  const tpl = {
    id,
    name: name || `${hull.name}方案`,
    hull: hullId,
    fit: createDefaultFit(hullId),
    meta: { createdAt: now, updatedAt: now, favorite: false, note: "", tags: [] },
    derived: null
  };
  tpl.derived = computeShip(tpl).derived;
  return tpl;
}

/**
 * 一步建好一个装配方案（给预设库和测试用）。
 * fit 是 { 槽位 id: 装备 id }，只写要装的槽，其余留空。
 */
export function makeShip({ id, name, hull, fit = {}, now = 0 }) {
  let tpl = createShipTemplate({ id, name, hull, now });
  for (const slotId of Object.keys(fit)) {
    tpl = setFit(tpl, slotId, fit[slotId], now).template;
  }
  return tpl;
}

/** 深拷贝（草稿用，避免 UI 摸到库里的对象） */
export function cloneShip(tpl) {
  return {
    ...tpl,
    fit: { ...tpl.fit },
    meta: { ...tpl.meta, tags: [...(tpl.meta.tags || [])] }
  };
}

/**
 * 改一个插槽。itemId = null 表示清空。
 * 永远返回 { ok, reasons, template }，template 是新对象。
 */
export function setFit(tpl, slotId, itemId, now = 0) {
  const slot = findSlot(getHull(tpl.hull), slotId);
  if (!slot) {
    return { ok: false, reasons: [`船体 ${tpl.hull} 没有插槽 ${slotId}`], template: tpl };
  }
  const next = {
    ...tpl,
    fit: { ...tpl.fit, [slotId]: itemId ?? null },
    meta: { ...tpl.meta, updatedAt: now }
  };
  const res = computeShip(next);
  next.derived = res.derived;
  return { ok: res.ok, reasons: res.reasons, template: next };
}

/**
 * 唯一算账入口。
 *
 * @param {object} tpl 舰船模板
 * @param {{unlocked?:{hulls?:Set,weapons?:Set,plugins?:Set}}} [opts] 不传就跳过蓝图校验
 * @returns {{ok:boolean, reasons:string[], derived:object}}
 */
export function computeShip(tpl, opts = {}) {
  const hull = getHull(tpl?.hull);
  if (!hull) {
    return { ok: false, reasons: [`未知船体 ${tpl?.hull}`], derived: emptyDerived([`未知船体 ${tpl?.hull}`]) };
  }

  const reasons = [];
  const unlocked = opts.unlocked;

  // ---- V2 船体蓝图 ----
  if (unlocked?.hulls && !unlocked.hulls.has(hull.id)) {
    reasons.push(`未解锁船体蓝图：${hull.name}`);
  }

  // ---- V3 孤儿插槽键 ----
  const valid = new Set(slotIds(hull));
  for (const key of Object.keys(tpl.fit || {})) {
    if (!valid.has(key)) reasons.push(`未知插槽 ${key}`);
  }

  // ---- 逐槽校验 ----
  const weapons = [];
  const plugins = [];
  let capacityUsed = 0;

  for (const slot of hull.slots.weapon) {
    const itemId = tpl.fit?.[slot.id] ?? null;
    if (!itemId) continue;

    // V10 槽位种类：武器槽里塞了插件
    if (PLUGIN_TEMPLATES[itemId]) {
      reasons.push(`槽 ${slot.id}：只能装武器`);
      continue;
    }
    const w = WEAPONS[itemId];
    if (!w) { reasons.push(`槽 ${slot.id}：未知武器 ${itemId}`); continue; }

    // V5 不可装配
    if (w.mountable === false) { reasons.push(`槽 ${slot.id}：${w.name} 不可装配`); continue; }

    // V6 尺寸
    if ((SIZE_RANK[w.size] ?? 9) > (SIZE_RANK[slot.size] ?? 9)) {
      reasons.push(`槽 ${slot.id}：${slot.size} 槽装不下 ${w.size} 级的${w.name}`);
      continue;
    }

    // V7 武器蓝图
    if (unlocked?.weapons && !unlocked.weapons.has(itemId)) {
      reasons.push(`未解锁武器蓝图：${w.name}`);
    }

    capacityUsed += w.capacity || 0;
    weapons.push({ slot: slot.id, id: w.id, name: w.name, size: w.size, capacity: w.capacity || 0 });
  }

  const pluginCount = new Map();
  for (const slot of hull.slots.plugin) {
    const itemId = tpl.fit?.[slot.id] ?? null;
    if (!itemId) continue;

    // V10 反方向：插件槽里塞了武器
    if (WEAPONS[itemId] && !PLUGIN_TEMPLATES[itemId]) {
      reasons.push(`槽 ${slot.id}：只能装插件`);
      continue;
    }
    const p = getPlugin(itemId);
    if (!p) { reasons.push(`槽 ${slot.id}：未知插件 ${itemId}`); continue; }

    if (unlocked?.plugins && !unlocked.plugins.has(itemId)) {
      reasons.push(`未解锁插件蓝图：${p.name}`);
    }

    // V11 同船数量上限
    const n = (pluginCount.get(itemId) || 0) + 1;
    pluginCount.set(itemId, n);
    const maxN = p.limits?.maxPerShip;
    if (maxN && n > maxN) {
      reasons.push(`槽 ${slot.id}：${p.name} 每船最多 ${maxN} 个`);
      continue;
    }

    capacityUsed += p.capacity || 0;
    plugins.push({ slot: slot.id, id: p.id, name: p.name, capacity: p.capacity || 0 });
  }

  // ---- 承载力：先算上限（插件加成），再比对。顺序不可换 ----
  const capacity = hull.capacity + sumMod(plugins, "capacity");
  const capacityFree = capacity - capacityUsed;
  if (capacityFree < 0) {
    reasons.push(`超出承载量：需 ${capacityUsed}，上限 ${capacity}（超 ${-capacityFree}）`);
  }

  // ---- 属性结算：船体基础 + 插件 mods（capacity / fireRate 不在此列）----
  const a = hull.armor;
  const armor = {
    hp: a.hp + sumMod(plugins, "hp"),
    hpRegen: round2(a.hpRegen + sumMod(plugins, "hpRegen")),
    shield: a.shield + sumMod(plugins, "shield"),
    shieldRegen: round2(a.shieldRegen + sumMod(plugins, "shieldRegen")),
    hullHitR: round1(a.hullHitR + sumMod(plugins, "hullHitR")),
    shieldHitR: round1(a.shieldHitR + sumMod(plugins, "shieldHitR"))
  };

  // ---- 三个手填值的合成 ----
  let command = hull.command;
  let buildTime = hull.buildTime;
  for (const w of weapons) {
    const t = WEAPONS[w.id];
    command += t.command || 0;
    buildTime += t.buildTime || 0;
  }
  for (const p of plugins) {
    const t = PLUGIN_TEMPLATES[p.id];
    command += t.command || 0;
    buildTime += t.buildTime || 0;
  }

  const fireRate = round2(
    plugins.reduce((m, p) => m * (PLUGIN_TEMPLATES[p.id].mods?.fireRate ?? 1), 1)
  );

  const abilities = collectAbilities(hull, plugins);

  return {
    ok: reasons.length === 0,
    reasons,
    derived: {
      ok: reasons.length === 0,
      reasons,
      capacity,
      capacityUsed,
      capacityFree,
      command,
      buildTime: round1(buildTime),
      fireRate,
      armor,
      weapons,
      plugins,
      abilities
    }
  };
}

/**
 * 编译成 sim 认的运行时参数。
 * 注意 weapons[] 给全，weapon 只是给阶段一单武器 sim 的兼容别名。
 */
export function compileShip(tpl) {
  const { derived } = computeShip(tpl);
  const hull = getHull(tpl.hull);
  return {
    hull: tpl.hull,
    class: hull.class,
    maxHp: derived.armor.hp,
    regen: derived.armor.hpRegen,
    maxShield: derived.armor.shield,
    shieldRegen: derived.armor.shieldRegen,
    hitR: derived.armor.hullHitR,
    shieldHitR: derived.armor.shieldHitR,
    weapons: derived.weapons.map(w => w.id),
    // 每个武器槽的炮口位置（船体局部坐标 [+x 前, +y 左]）
    weaponSlots: hull.slots.weapon.map(s => ({ id: s.id, size: s.size, pos: s.pos ?? null })),
    weapon: derived.weapons[0]?.id ?? "laser",   // 兼容别名
    fireRate: derived.fireRate,
    command: derived.command,
    buildTime: derived.buildTime,
    abilities: derived.abilities
  };
}

// ------------------------------------------------------------------

/** 收集船体自带 + 插件携带的能力，并把 count 折进 maxTargets */
export function collectAbilities(hull, plugins = []) {
  const out = [];
  const push = (ref) => {
    const t = ABILITY_TEMPLATES[ref.id];
    if (!t) return;
    const count = Math.max(1, ref.count || 1);
    out.push({
      id: t.id,
      name: t.name,
      resource: t.resource,
      radius: t.radius,
      rate: t.rate,
      grant: t.grant || 0,
      includeSelf: t.includeSelf !== false,
      select: t.select || "lowestRatio",
      fx: t.fx,
      count,
      maxTargets: t.maxTargets * count
    });
  };

  for (const ref of hull.abilities || []) push(ref);
  for (const p of plugins) {
    const t = PLUGIN_TEMPLATES[p.id];
    for (const ref of t?.abilities || []) push(ref);
  }
  return out;
}

function sumMod(plugins, key) {
  let sum = 0;
  for (const p of plugins) sum += PLUGIN_TEMPLATES[p.id].mods?.[key] ?? 0;
  return sum;
}

function emptyDerived(reasons = []) {
  return {
    ok: false, reasons,
    capacity: 0, capacityUsed: 0, capacityFree: 0,
    command: 0, buildTime: 0, fireRate: 1,
    armor: { hp: 0, hpRegen: 0, shield: 0, shieldRegen: 0, hullHitR: 0, shieldHitR: 0 },
    weapons: [], plugins: [], abilities: []
  };
}

export { HULL_TEMPLATES };
