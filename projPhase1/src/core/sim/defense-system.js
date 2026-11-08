/**
 * 防御系统
 * ---------------------------------------------------------------
 * 只负责：血量、自然回血、护盾的加减、护盾自回。
 * 不负责：瞄准、命中判定、弹丸（那是 weapon-system.js）。
 * 不负责：给友军充盾/维修（那是 support-system.js）。
 *
 * 规则（对应 design/261107_2机制改进/支援能力设计.md「自回 vs 他回」）：
 *   1. 每条舰船有 血量 hp 与 自然回血 regen（持续，只作用自己）
 *   2. 每条舰船有 护盾容量 maxShieldBase 与 护盾自回 shieldRegen（持续，只作用自己）
 *   3. 护盾无法超过「本帧有效上限」= maxShieldBase + 支援能力给的临时加成
 *   4. 护盾先扣，过量伤害溢出到血量
 *   5. 他回（充能器 / 维修无人机）在 support-system.js，按光环持续作用
 */

import { DEFAULT_HIT_R } from "./spatial.js";
import { rand } from "./rng.js";

/** 初始化一个单位的战斗状态 */
export function initCombat(u, sq) {
  u.hp = sq.p.hp;
  u.maxHp = sq.p.hp;
  u.regen = sq.p.regen;

  u.maxShieldBase = sq.p.maxShield || 0;
  u.shieldCap = u.maxShieldBase;
  u.shieldRegen = sq.p.shieldRegen || 0;
  u.shield = 0;

  // 多武器：每个槽位一套独立的冷却/连发状态
  u.fireRate = sq.p.fireRate || 1;
  u.weapons = buildWeaponStates(sq.p);
  u.weapon = u.weapons[0]?.id ?? "laser";      // 兼容别名，渲染/统计用
  u.hitR = sq.p.hitR === undefined ? DEFAULT_HIT_R : sq.p.hitR;   // 受击半径

  u.fxCd = 0;                   // 支援特效节流
}

/**
 * 按小队参数生成武器槽状态。
 * sq.p.weapons 是编好的武器 id 列表（来自舰船模板）；没有就退回单武器 sq.p.weapon。
 * sq.p.weaponSlots 给出每个槽的炮口位置（船体局部坐标），没有就从船心出。
 *
 * @param p    小队参数
 * @param old  旧的槽位数组，用来继承冷却（改装配时不刷 DPS）
 */
export function buildWeaponStates(p, old = []) {
  const ids = Array.isArray(p.weapons) && p.weapons.length
    ? p.weapons
    : [p.weapon || "laser"];
  const defs = Array.isArray(p.weaponSlots) ? p.weaponSlots : null;
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    out.push({
      slot: i,
      id: ids[i],
      // 船体局部坐标 [+x 前, +y 左]；null = 从船心出
      pos: defs?.[i]?.pos ?? null,
      cd: old[i]?.cd ?? rand() * 1.0,        // 错开开火节奏
      burstLeft: 0,
      burstTimer: 0,
      target: null
    });
  }
  return out;
}

/** 判断两套武器 id 列表是否一致 */
function sameWeapons(a, b) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i].id !== b[i]) return false;
  return true;
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

/**
 * 自然恢复（持续，只作用自己）：
 *   血量 → maxHp
 *   护盾 → 本帧有效上限（含支援能力的临时加成）
 */
export function stepRegen(units, dt) {
  for (const u of units) {
    if (u.hp <= 0) continue;

    if (u.hp < u.maxHp) {
      u.hp = Math.min(u.maxHp, u.hp + u.regen * dt);
    }

    const cap = u.shieldCap ?? u.maxShieldBase ?? 0;
    if (u.shieldRegen > 0 && u.shield < cap) {
      u.shield = Math.min(cap, u.shield + u.shieldRegen * dt);
    }
  }
}

/** 把某小队的战斗参数同步到它现有的单位上（改面板后立即生效） */
export function applyCombatParams(units, squads, id) {
  const sq = squads[id];
  if (!sq) return;
  for (const u of units) {
    if (u.squad !== id) continue;

    if (u.hp === undefined || u.maxHp === undefined) {
      // 新单位（例如刚加了成员）
      initCombat(u, sq);
    } else {
      // 血量按比例缩放，保留当前战损程度
      if (u.maxHp !== sq.p.hp) {
        const ratio = u.hp / u.maxHp;
        u.maxHp = sq.p.hp;
        u.hp = Math.max(1, sq.p.hp * ratio);
      }
      u.regen = sq.p.regen;

      // 护盾容量变了就夹紧（不按比例放大，避免「改配置回满盾」）
      u.maxShieldBase = sq.p.maxShield || 0;
      u.shieldRegen = sq.p.shieldRegen || 0;
      const cap = u.maxShieldBase + (u.grantMax || 0);
      u.shieldCap = cap;
      if (u.shield > cap) u.shield = cap;

      u.weapon = sq.p.weapon || "laser";
      u.hitR = sq.p.hitR === undefined ? DEFAULT_HIT_R : sq.p.hitR;

      // 装配变了就重建武器槽状态；同一个槽位的冷却尽量保留，避免刷 DPS
      const ids = Array.isArray(sq.p.weapons) && sq.p.weapons.length
        ? sq.p.weapons
        : [sq.p.weapon || "laser"];
      if (!sameWeapons(u.weapons, ids)) {
        u.weapons = buildWeaponStates(sq.p, u.weapons || []);
        u.weapon = u.weapons[0]?.id ?? "laser";
      } else if (Array.isArray(sq.p.weaponSlots)) {
        // id 没变但炮口位置可能变了（换了船体）
        for (let i = 0; i < u.weapons.length; i++) {
          u.weapons[i].pos = sq.p.weaponSlots[i]?.pos ?? null;
        }
      }
      u.fireRate = sq.p.fireRate || 1;
    }
  }
}
