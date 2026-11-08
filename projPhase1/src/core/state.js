/**
 * 构筑状态（build state）
 * -----------------------------------------------------------------
 * 这是「玩家能改的东西」的权威定义，住在 core 里，不住在 UI 里。
 *
 * 一支小队有两样东西：
 *   entries  编制：该有哪些船（可以有多种型号）→ [{ ship, n }]
 *   template 引用的编制模板 id（null = 无编制小队，自己拿一份 entries）
 *
 * 引用了模板的小队，entries 是**模板的镜像**：模板一改，所有引用它的小队
 * 立刻跟着变（多出来的船剔除回散兵池）。改模板的代码在 core.applySquadTemplate。
 *
 * 散兵池（loose）没有编制：它就是收纳所有未编队舰船的容器。
 *
 * 本文件是纯函数与常量，没有状态，方便单测。
 */

import { computeShip, compileShip } from "./data/ship-template.js";
import { getHull } from "./data/hull-templates.js";
import { SQUAD_TEMPLATES, cloneEntries, entriesCount } from "./data/squad-templates.js";

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

/** 一条编制的指挥值占用（单型号口径，兼容旧调用） */
export function entryCost(ship, count) {
  return Math.max(0, Math.floor(count || 0)) * shipCommand(ship);
}

/** 一份 entries 的指挥值占用 */
export function entriesCost(entries, ships) {
  let sum = 0;
  for (const e of entries || []) {
    sum += Math.max(0, e.n | 0) * shipCommand(ships?.[e.ship]);
  }
  return sum;
}

/** 一支小队当前的编制（旧字段兜底：只有 ship + count 时当单型号编制） */
export function squadEntries(b) {
  if (b && Array.isArray(b.entries)) return b.entries;
  if (b && b.ship) return [{ ship: b.ship, n: Math.max(0, b.count | 0) }];
  return [];
}

/** 整支部队已占用的指挥值。
 *
 * 两套口径：
 *   编队小队 → 按编制（entries）算。编制是承诺，排队的船也算已经付过。
 *   散兵池   → 按实际舰船算（传 units 时），因为它没有编制。
 */
export function commandsUsed(build, ships, units = null) {
  let sum = 0;
  for (const s of build.squads) {
    if (s.active === false) continue;

    if (s.loose) {
      if (units) {
        for (const u of units) {
          if (u.squad === s.id) sum += u.command || 0;
        }
      } else {
        // 没有 units 时（纯构筑运算）用「主方案 × 数量」估一下
        sum += entryCost(ships?.[s.ship], s.count);
      }
      continue;
    }

    sum += entriesCost(squadEntries(s), ships);
  }
  return sum;
}

/**
 * 初始构筑：4 蓝 + 4 红，各引用一个编制模板；再各配一个散兵池。
 *
 * 四个模板的编制成本都是 96 指挥值，散兵池各 6 艘 4 指挥值的支援舰：
 *   8 × 96 + 2 × 24 = 816，对 900 的上限留一点余量。
 */
const SQUAD_TEMPLATE_ORDER = [
  "squad.assault", "squad.wall", "squad.raider", "squad.support"
];

export function createBuild(templates = SQUAD_TEMPLATES) {
  const squads = [];
  for (let i = 0; i < 10; i++) {
    const faction = i < 4 ? 0 : i < 8 ? 1 : i === 8 ? 0 : 1;
    const loose = i >= 8;

    if (loose) {
      // 散兵池：没有编制，靠生产线出锅和踢出来的船填充
      squads.push({
        id: i, key: "散", faction,
        loose: true, active: true,
        template: null,
        entries: [],
        formations: [],
        form: null,
        ship: DEFAULT_SQUAD_SHIPS[i],
        count: 6
      });
      continue;
    }

    const tplId = SQUAD_TEMPLATE_ORDER[i % 4];
    const tpl = templates[tplId];
    const entries = cloneEntries(tpl.entries);

    squads.push({
      id: i, key: "ABCDEFGH"[i % 8], faction,
      loose: false, active: true,
      template: tplId,
      entries,
      formations: [...tpl.formations],
      form: tpl.formations[0] || null,
      // 兼容字段：主型号 / 编制总数
      ship: entries[0].ship,
      count: entriesCount(entries)
    });
  }
  return {
    squads,
    modules: START_MODULES,
    commandCap: START_COMMAND_CAP
  };
}

/** 池子里那几艘初始散兵的方案（仅用于编译参数与显示） */
const DEFAULT_SQUAD_SHIPS = [
  "ship.std_falcon", "ship.std_falcon", "ship.std_falcon", "ship.std_falcon",
  "ship.std_falcon", "ship.std_falcon", "ship.std_falcon", "ship.std_falcon",
  "ship.support_repair",   // 蓝方散兵
  "ship.support_charger"   // 红方散兵
];

/** 深拷贝一份构筑（草稿用，避免 UI 直接摸到 core 的对象） */
export function cloneBuild(build) {
  return {
    modules: build.modules,
    commandCap: build.commandCap,
    squads: build.squads.map(s => ({
      ...s,
      entries: cloneEntries(s.entries),
      formations: [...(s.formations || [])]
    }))
  };
}

/**
 * 把一支小队的「主方案」写进 sq.p（移动/兜底参数）。
 * 混编小队只认 entries[0]，战斗属性由每艘船自己带，不从这里来。
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
