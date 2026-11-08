/**
 * 构筑状态（build state）
 * -----------------------------------------------------------------
 * 这是「玩家能改的东西」的权威定义，住在 core 里，不住在 UI 里。
 *
 * P4 起，小队不再直接引用「船体」，而是引用**舰船模板**（船体 + 装配）。
 * 好处：一条小队就是一个方案 × 数量，人口、承载、工时全部由模板算出来，
 * 玩家改装配 → 小队立刻跟着变，不需要在别处同步第二份数据。
 *
 * 本文件是纯函数与常量，没有状态，方便单测。
 */

import { computeShip, compileShip } from "./data/ship-template.js";
import { getHull } from "./data/hull-templates.js";

/** 单队编制硬上限（防止 UI 传一个离谱数字进来） */
export const MAX_PER_SQUAD = 48;

/** 一次战斗开局给的预制模组 */
export const START_MODULES = 24;

/** 指挥值上限（母舰模板里也有一个，这里是开局兜底） */
export const START_COMMAND_CAP = 900;

/** 瞬间建成一艘船消耗的模组数 */
export const MODULES_PER_SHIP = 1;

/** 一艘舰船占用的指挥值：只看船体，与装配无关（设计文档 D1） */
export function shipCommand(ship) {
  if (!ship) return 0;
  const d = ship.derived || computeShip(ship).derived;
  return d.command;
}

/** 一条编制的指挥值占用 */
export function entryCost(ship, count) {
  return Math.max(0, Math.floor(count || 0)) * shipCommand(ship);
}

/** 整支部队已占用的指挥值 */
export function commandsUsed(build, ships) {
  let sum = 0;
  for (const s of build.squads) sum += entryCost(ships?.[s.ship], s.count);
  return sum;
}

/**
 * 初始构筑：与 sim 层 SQUAD_DEF 一一对应（10 队：双方各 4 正规 + 1 散兵）。
 * 前 8 队用标准矛隼，两支散兵各用一种支援方案，方便肉眼验证充盾/维修。
 *
 * 指挥值：8 × 24 × 4 + 2 × 6 × 4 = 816，对上 900 的上限留一点余量。
 */
export const DEFAULT_SQUAD_SHIPS = [
  "ship.std_falcon", "ship.std_falcon", "ship.std_falcon", "ship.std_falcon",
  "ship.std_falcon", "ship.std_falcon", "ship.std_falcon", "ship.std_falcon",
  "ship.support_repair",   // 蓝方散兵
  "ship.support_charger"   // 红方散兵
];

export function createBuild() {
  const squads = [];
  for (let i = 0; i < 10; i++) {
    const faction = i < 4 ? 0 : i < 8 ? 1 : i === 8 ? 0 : 1;
    const loose = i >= 8;
    squads.push({
      id: i,
      key: loose ? "散" : "ABCDEFGH"[i % 8],
      faction,
      loose,
      ship: DEFAULT_SQUAD_SHIPS[i],
      count: loose ? 6 : 24
    });
  }
  return {
    squads,
    modules: START_MODULES,
    commandCap: START_COMMAND_CAP
  };
}

/** 深拷贝一份构筑（草稿用，避免 UI 直接摸到 core 的对象） */
export function cloneBuild(build) {
  return {
    modules: build.modules,
    commandCap: build.commandCap,
    squads: build.squads.map(s => ({ ...s }))
  };
}

/**
 * 把一份舰船模板写进小队参数（sq.p.*）。
 * sim 只认这一层扁平参数，不认模板。
 */
export function applyShipToSquadParams(sq, ship) {
  const rt = compileShip(ship);
  const p = sq.p;
  p.hull = ship.hull;
  p.hullName = getHull(ship.hull)?.name ?? "";
  p.hp = rt.maxHp;
  p.regen = rt.regen;
  p.maxShield = rt.maxShield;
  p.shieldRegen = rt.shieldRegen;
  p.hitR = rt.hitR;
  p.weapon = rt.weapon;
  p.weapons = rt.weapons;
  p.weaponSlots = rt.weaponSlots;
  p.fireRate = rt.fireRate;
  p.abilities = rt.abilities;
  return rt;
}
