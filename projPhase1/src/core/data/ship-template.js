/**
 * 舰船模板（ShipTemplate）
 * -----------------------------------------------------------------
 * 一个舰船模板 = 船体 + 每个插槽里装了什么。
 * 这是**玩家自己制作并保存**的方案，可以随时改名、改装配、另存为新方案。
 *
 * 与「小队编制模板」的分工：
 *   舰船模板  管 1 艘船长什么样（本研究）
 *   编制模板  管 1 支小队里放哪几种舰船、各几条（后续）
 *
 * 本文件负责三件事：
 *   computeShip()  校验 + 算 derived（唯一算账入口，UI 与 core 都调它）
 *   compileShip()  把模板压成 sim 认的运行时参数（sq.p.* 那一套）
 *   fit 的增删改   setFit() 返回新对象，不改原对象
 */

import {
  HULL_TEMPLATES, SIZE_RANK, hullCommand, hullBuildTime, findSlot, round1
} from "./hull-templates.js";
import { WEAPONS } from "../sim/weapons.js";
import { PLUGINS } from "./plugin-templates.js";

/**
 * 舰船模板字段
 *   id       玩家方案 id（"ship." 前缀 + 玩家侧序号）
 *   name     方案名，玩家可改
 *   hull     船体模板 id
 *   fit      插槽 id → 模板 id，空槽写 null（不要省略键，UI 靠它铺格子）
 *             武器槽填 weaponId（"laser"），插件槽填 pluginId（"plugin.capacitor"）
 *   meta     { createdAt, updatedAt, favorite, note, tags[] } 纯展示
 *   derived  只读缓存，永远由 computeShip() 重算，不要手写
 *              { ok, reasons[], capacity, capacityUsed, capacityFree,
 *                command, buildTime, fireRate, armor{...}, weapons[] }
 */
export function createDefaultFit(hullId) {
  const hull = HULL_TEMPLATES[hullId];
  if (!hull) return null;
  const fit = {};
  for (const s of hull.slots.weapon) fit[s.id] = null;
  for (const s of hull.slots.plugin) fit[s.id] = null;
  return fit;
}

/** 新建一个空装配的舰船模板（UI「新建方案」用） */
export function createShipTemplate({ id, name, hull: hullId, now = 0 }) {
  const hull = HULL_TEMPLATES[hullId];
  if (!hull) throw new Error(`未知船体 ${hullId}`);
  const fit = createDefaultFit(hullId);
  const tpl = {
    id,
    name: name || `${hull.name}方案`,
    hull: hullId,
    fit,
    meta: { createdAt: now, updatedAt: now, favorite: false, note: "", tags: [] },
    derived: null
  };
  tpl.derived = computeShip(tpl).derived;
  return tpl;
}

/**
 * 改一个插槽里的东西，返回新模板（不改入参）。
 * itemId = null 表示清空。
 */
export function setFit(tpl, slotId, itemId, now = 0) {
  if (!findSlot(HULL_TEMPLATES[tpl.hull], slotId)) {
    return { ok: false, reasons: [`船体 ${tpl.hull} 没有插槽 ${slotId}`] };
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
 * 唯一算账入口。永远返回完整 derived（ok=false 时也带着能算的部分，
 * 方便 UI 立刻显示「承载力 14/12 超了 2」这种红字）。
 *
 * @param {object} tpl 舰船模板
 * @param {{unlocked?:{hulls?:Set<string>,weapons?:Set<string>,plugins?:Set<string>}}} [opts]
 * @returns {{ok:boolean, reasons:string[], derived:object}}
 */
export function computeShip(tpl, opts = {}) {
  const reasons = [];
  const hull = HULL_TEMPLATES[tpl?.hull];
  if (!hull) {
    return { ok: false, reasons: [`未知船体 ${tpl?.hull}`], derived: emptyDerived() };
  }

  // ---- 1. 解锁校验（不传 unlocked 就跳过，方便单测与设计期） ----
  const u = opts.unlocked;
  if (u?.hulls && !u.hulls.has(hull.id)) reasons.push(`未解锁船体蓝图：${hull.name}`);

  // ---- 2. 逐槽校验 ----
  const weapons = [];
  const plugins = [];
  let capacityUsed = 0;

  for (const slot of hull.slots.weapon) {
    const itemId = tpl.fit?.[slot.id] ?? null;
    if (!itemId) continue;

    const w = WEAPONS[itemId];
    if (!w) { reasons.push(`槽 ${slot.id}：未知武器 ${itemId}`); continue; }
    if (w.mountable === false) { reasons.push(`槽 ${slot.id}：${w.name} 不可装配`); continue; }
    if (SIZE_RANK[w.size] > SIZE_RANK[slot.size]) {
      reasons.push(`槽 ${slot.id}：${slot.size} 槽装不下 ${w.size} 级的${w.name}`);
      continue;
    }
    if (u?.weapons && !u.weapons.has(itemId)) {
      reasons.push(`未解锁武器蓝图：${w.name}`);
    }
    capacityUsed += w.capacity;
    weapons.push({ slot: slot.id, id: w.id, name: w.name, size: w.size, capacity: w.capacity });
  }

  for (const slot of hull.slots.plugin) {
    const itemId = tpl.fit?.[slot.id] ?? null;
    if (!itemId) continue;

    const p = PLUGINS[itemId];
    if (!p) { reasons.push(`槽 ${slot.id}：未知插件 ${itemId}`); continue; }
    if (u?.plugins && !u.plugins.has(itemId)) {
      reasons.push(`未解锁插件蓝图：${p.name}`);
    }
    capacityUsed += p.capacity;
    plugins.push({ slot: slot.id, id: p.id, name: p.name, capacity: p.capacity });
  }

  // ---- 3. 承载力：插件先给上限加成，再算占用（扩容电容不会自己把自己卡死） ----
  const capacity = hull.capacity + sumMod(plugins, "capacity", PLUGINS);
  const capacityFree = capacity - capacityUsed;
  if (capacityFree < 0) {
    reasons.push(`超出承载量：需 ${capacityUsed}，上限 ${capacity}（超 ${-capacityFree}）`);
  }

  // ---- 4. 属性结算：船体基础 + 插件加成 ----
  const a = hull.armor;
  const armor = {
    hp: a.hp + sumMod(plugins, "hp", PLUGINS),
    hpRegen: a.hpRegen + sumMod(plugins, "hpRegen", PLUGINS),
    shield: a.shield + sumMod(plugins, "shield", PLUGINS),
    shieldRegen: a.shieldRegen + sumMod(plugins, "shieldRegen", PLUGINS),
    hullHitR: round1(a.hullHitR + sumMod(plugins, "hullHitR", PLUGINS)),
    shieldHitR: round1(a.shieldHitR + sumMod(plugins, "shieldHitR", PLUGINS))
  };

  // ---- 5. 指挥值 / 建造时间 ----
  // 指挥值只看船体（见 design 文档：装配不影响人口，玩家靠塞满承载力赚强度）
  const command = hullCommand(hull);
  // 建造时间 = 船体基准 + 每件装备的附加工时；生产线效率在建造时除，不在这里
  let buildTime = hullBuildTime(hull);
  for (const it of weapons) buildTime += WEAPONS[it.id].buildTime || 0;
  for (const it of plugins) buildTime += PLUGINS[it.id].buildTime || 0;

  const fireRate = round2(
    plugins.reduce((m, p) => m * (PLUGINS[p.id].mods?.fireRate ?? 1), 1)
  );

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
      plugins
    }
  };
}

/**
 * 压成 sim 认的运行时参数。
 * 阶段一 sim 每条船只认一个武器（u.weapon），所以这里取第一个槽的武器；
 * 多武器齐射是 weapon-system.js 的后续改造，届时改读 weapons[] 即可。
 */
export function compileShip(tpl) {
  const { derived } = computeShip(tpl);
  const first = derived.weapons[0]?.id ?? "laser";
  return {
    hull: tpl.hull,
    class: HULL_TEMPLATES[tpl.hull].class,
    maxHp: derived.armor.hp,
    regen: derived.armor.hpRegen,
    maxShield: derived.armor.shield,
    shieldRegen: derived.armor.shieldRegen,
    hitR: derived.armor.hullHitR,
    shieldHitR: derived.armor.shieldHitR,
    weapons: derived.weapons.map(w => w.id),
    weapon: first,
    fireRate: derived.fireRate,
    command: derived.command,
    buildTime: derived.buildTime
  };
}

// ------------------------------------------------------------------

function sumMod(plugins, key, table) {
  let sum = 0;
  for (const p of plugins) sum += table[p.id].mods?.[key] ?? 0;
  return sum;
}

function emptyDerived() {
  return {
    ok: false, reasons: [], capacity: 0, capacityUsed: 0, capacityFree: 0,
    command: 0, buildTime: 0, fireRate: 1,
    armor: { hp: 0, hpRegen: 0, shield: 0, shieldRegen: 0, hullHitR: 0, shieldHitR: 0 },
    weapons: [], plugins: []
  };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
