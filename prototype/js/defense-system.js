/**
 * 防御系统
 * ---------------------------------------------------------------
 * 只负责：血量、自然回血、护盾的加减、充能器套盾。
 * 不负责：瞄准、命中判定、弹丸（那是 weapon-system.js）。
 *
 * 规则（对应 design/攻击与防御机制.md）：
 *   1. 每条舰船有 血量 hp 与 自然回血 regen（持续回血）
 *   2. 护盾等价为血量，先扣护盾，过量伤害溢出到血量
 *   3. 护盾无法自己回复，只能由「护盾充能器」重新提供
 *   4. 充能器周期性给「覆盖半径内、没有护盾的友军」套盾，
 *      按血量排序，优先最低血量
 *   5. 充能器有电量上限，套盾消耗电量，电量随时间回充
 */

import { DEFAULT_HIT_R } from "./spatial.js";

/** 初始化一个单位的战斗状态 */
export function initCombat(u, sq, idx) {
  u.hp = sq.p.hp;
  u.maxHp = sq.p.hp;
  u.regen = sq.p.regen;
  u.shield = 0;
  u.weapon = sq.p.weapon || "laser";
  u.hitR = sq.p.hitR === undefined ? DEFAULT_HIT_R : sq.p.hitR;   // 受击半径
  u.cd = Math.random() * 1.0;          // 错开开火节奏
  u.burstLeft = 0;                     // 一轮还剩几发
  u.burstTimer = 0;                    // 距下一发还有多久
  u.burstTarget = null;                // 这一轮锁定的目标
  u.charger = idx < (sq.p.chargers || 0);
  u.energy = 100;
  u.castCd = Math.random() * 0.3;
}

/**
 * 造成伤害。返回 true 表示目标死亡。
 * pierce = true 时无视护盾（轨道炮）。
 */
export function applyDamage(u, dmg, pierce) {
  let left = dmg;
  if (!pierce && u.shield > 0) {
    const absorbed = Math.min(u.shield, left);
    u.shield -= absorbed;
    left -= absorbed;          // 过量伤害溢出到血量
  }
  u.hp -= left;
  return u.hp <= 0;
}

/** 自然回血（持续） */
export function stepRegen(units, dt) {
  for (const u of units) {
    if (u.hp <= 0 || u.hp >= u.maxHp) continue;
    u.hp = Math.min(u.maxHp, u.hp + u.regen * dt);
  }
}

/**
 * 护盾充能器
 * G 需要：shieldHp, chargerRange, chargerCd, energyMax, energyCost, energyRegen
 */
export function stepChargers(units, squads, G, dt, fx = null) {
  const range2 = G.chargerRange * G.chargerRange;

  for (const u of units) {
    if (!u.charger || u.hp <= 0) continue;

    // 电量回充
    if (u.energy < G.energyMax) {
      u.energy = Math.min(G.energyMax, u.energy + G.energyRegen * dt);
    }

    if (u.castCd > 0) { u.castCd -= dt; continue; }
    if (u.energy < G.energyCost) continue;

    // 找覆盖范围内「没有护盾」的友军，取血量最低的
    const myF = squads[u.squad].faction;
    let best = null, bestHp = Infinity;
    for (const o of units) {
      if (o === u || o.hp <= 0) continue;
      if (squads[o.squad].faction !== myF) continue;
      if (o.shield > 0) continue;                 // 已有护盾的不重复套
      const dx = o.x - u.x, dy = o.y - u.y;
      if (dx * dx + dy * dy > range2) continue;
      if (o.hp < bestHp) { bestHp = o.hp; best = o; }
    }
    if (!best) continue;

    best.shield = G.shieldHp;
    u.energy -= G.energyCost;
    u.castCd = G.chargerCd;

    // 视觉：一条青色弧线连到目标的盾环上 + 盾从外向内收拢
    if (fx) {
      fx.push({
        type: "shieldlink",
        x1: u.x, y1: u.y,
        x2: best.x, y2: best.y,
        rEnd: 8.6,
        life: 0.30, max: 0.30
      });
      fx.push({
        type: "shieldup",
        x: best.x, y: best.y,
        r0: 15, r1: 8.6,
        life: 0.45, max: 0.45
      });
    }
  }
}

/** 把某小队的战斗参数同步到它现有的单位上（改面板后立即生效） */
export function applyCombatParams(units, squads, id) {
  const sq = squads[id];
  if (!sq) return;
  let idx = 0;
  for (const u of units) {
    if (u.squad !== id) continue;

    if (u.hp === undefined || u.maxHp === undefined) {
      // 新单位（例如刚加了成员）
      initCombat(u, sq, idx);
    } else {
      // 血量按比例缩放，保留当前战损程度
      if (u.maxHp !== sq.p.hp) {
        const ratio = u.hp / u.maxHp;
        u.maxHp = sq.p.hp;
        u.hp = Math.max(1, sq.p.hp * ratio);
      }
      u.regen = sq.p.regen;
      u.weapon = sq.p.weapon || "laser";
      u.hitR = sq.p.hitR === undefined ? DEFAULT_HIT_R : sq.p.hitR;
      u.charger = idx < (sq.p.chargers || 0);
    }
    idx++;
  }
}
