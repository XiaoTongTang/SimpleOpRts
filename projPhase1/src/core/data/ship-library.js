/**
 * 舰船模板库
 * -----------------------------------------------------------------
 * 玩家手里的「方案」集合：预置若干条，之后由玩家新建/改配/删除/另存。
 *
 * 本文件只管集合的增删改查，装配的合法性由 computeShip() 判断，
 * 人口与模组约束由 core 判断 —— 这里不做任何规则判断。
 *
 * 键是舰船 id，值是 ShipTemplate。用一个普通对象而不是 Map，
 * 是为了让存档序列化不需要额外转换。
 */

import { makeShip, computeShip, setFit, createShipTemplate, cloneShip,
         createDefaultFit } from "./ship-template.js";
import { getHull } from "./hull-templates.js";

/**
 * 预置方案。id 稳定，永不重命名（存档与编制按 id 引用）。
 * command 由船体决定（P4 时全是默认 0 加成），所以同一船体的不同方案人口相同。
 */
export const DEFAULT_SHIPS = [
  {
    id: "ship.std_falcon",
    name: "矛隼·标准",
    hull: "hull.falcon",
    fit: { w1: "laser", w2: "laser" }                     // 6 / 14
  },
  {
    id: "ship.std_bulwark",
    name: "壁垒·重装",
    hull: "hull.bulwark",
    fit: { w1: "missile", w2: "laser" }                   // 8 / 17
  },
  {
    id: "ship.std_hammer",
    name: "重锤·突击",
    hull: "hull.hammer",
    fit: { w1: "torpedo", w2: "laser", w3: "laser" }      // 11 / 24
  },
  {
    id: "ship.std_citadel",
    name: "堡垒·旗舰",
    hull: "hull.citadel",
    fit: { w1: "missile", w2: "railgun", w3: "laser", w4: "laser" }   // 16 / 34
  },
  {
    id: "ship.support_charger",
    name: "矛隼·护盾支援",
    hull: "hull.falcon",
    fit: { w1: "laser", p1: "plugin.charger_s", p2: "plugin.capacitor" }   // 3+4+5 = 12 / 20
  },
  {
    id: "ship.support_repair",
    name: "矛隼·维修支援",
    hull: "hull.falcon",
    fit: { w1: "laser", p1: "plugin.repair_drone", p2: "plugin.shellplate" }  // 3+1+3 = 7 / 14
  }
];

/** 建一份默认库（每次开新局都从干净的预置开始） */
export function createLibrary(now = 0) {
  const lib = {};
  for (const def of DEFAULT_SHIPS) {
    lib[def.id] = makeShip({ ...def, now });
  }
  return lib;
}

/** 方案总数上限（防止 UI 被玩家塞爆，也限制存档体积） */
export const MAX_SHIPS = 20;

/** 取船体模板，找不到返回 null */
export function getShip(lib, id) {
  return lib?.[id] || null;
}

/** 下一个可用的玩家方案 id：ship.usr_0001 起，跳过已被占用的 */
export function nextShipId(lib) {
  let n = 1;
  for (;;) {
    const id = `ship.usr_${String(n).padStart(4, "0")}`;
    if (!lib[id]) return id;
    n++;
  }
}

/** 按 id 顺序返回列表（稳定排序，UI 不会每帧抖） */
export function listShips(lib) {
  return Object.keys(lib).sort().map(id => lib[id]);
}

/** 玩家新建方案 */
export function addShip(lib, { id, name, hull, fit, now = 0 }) {
  if (!id || lib[id]) throw new Error(`舰船 id 重复或为空：${id}`);
  lib[id] = makeShip({ id, name, hull, fit, now });
  return lib[id];
}

export function renameShip(lib, id, name, now = 0) {
  const s = lib[id];
  if (!s) return null;
  s.name = name;
  s.meta = { ...s.meta, updatedAt: now };
  return s;
}

/** 另存为：复制一份，改装配不影响原方案 */
export function duplicateShip(lib, id, newId, newName, now = 0) {
  const src = lib[id];
  if (!src) return null;
  if (lib[newId]) throw new Error(`舰船 id 重复：${newId}`);
  const copy = cloneShip(src);
  copy.id = newId;
  copy.name = newName || src.name + " 副本";
  copy.meta = { ...copy.meta, createdAt: now, updatedAt: now, favorite: false };
  copy.derived = computeShip(copy).derived;
  lib[newId] = copy;
  return copy;
}

export function removeShip(lib, id) {
  if (!lib[id]) return false;
  delete lib[id];
  return true;
}

/** 改装配：事务式，校验不过就什么都不写 */
export function setShipFit(lib, id, slotId, itemId, now = 0) {
  const s = lib[id];
  if (!s) return { ok: false, reasons: [`没有这艘舰船 ${id}`] };
  const r = setFit(s, slotId, itemId, now);
  if (r.ok) lib[id] = r.template;
  return r;
}

/**
 * 换船体：槽位完全不同，装配清空重来。
 * 「在役就禁止改」由 core 判断，这里只负责写库。
 */
export function setHull(lib, id, hullId, now = 0) {
  const s = lib[id];
  if (!s) return null;
  if (!getHull(hullId)) return null;

  const next = {
    ...s,
    hull: hullId,
    fit: createDefaultFit(hullId),
    meta: { ...s.meta, updatedAt: now }
  };
  next.derived = computeShip(next).derived;
  lib[id] = next;
  return next;
}

export { createShipTemplate };

// ------------------------------------------------------------------
// 存档：只存「能重建装配」的最小信息，derived 读档后重算
// ------------------------------------------------------------------

export const SHIP_SAVE_VERSION = 1;

export function serializeLibrary(lib) {
  return {
    version: SHIP_SAVE_VERSION,
    ships: Object.keys(lib).sort().map(id => {
      const s = lib[id];
      return {
        id: s.id,
        name: s.name,
        hull: s.hull,
        fit: { ...s.fit },
        meta: { ...s.meta }
      };
    })
  };
}

/**
 * 读档：按记录重建模板并重算 derived。
 * 未知船体 / 未知装备的记录会被跳过，而不是让整份存档报废。
 */
export function deserializeLibrary(data, now = 0) {
  const lib = {};
  if (!data || !Array.isArray(data.ships)) return lib;

  for (const rec of data.ships) {
    if (!rec?.id || !rec?.hull) continue;
    let tpl;
    try {
      tpl = createShipTemplate({ id: rec.id, name: rec.name, hull: rec.hull, now });
    } catch {
      continue;                      // 船体不认识了，跳过这条
    }
    for (const [slotId, itemId] of Object.entries(rec.fit || {})) {
      if (!itemId) continue;
      const r = setFit(tpl, slotId, itemId, now);
      if (r.ok || findSlotOk(tpl, slotId)) tpl = r.template;
    }
    if (rec.meta) tpl.meta = { ...tpl.meta, ...rec.meta };
    lib[tpl.id] = tpl;
  }
  return lib;
}

/** 读档时算一半失败也要把模板留下来，交给 UI 显示红字 */
function findSlotOk(tpl, slotId) {
  return Object.prototype.hasOwnProperty.call(tpl.fit, slotId);
}
