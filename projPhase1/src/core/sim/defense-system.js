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

/**
 * 初始化一个单位的战斗状态（舰船身份版）
 * -----------------------------------------------------------------
 * rt 是「这一艘船自己的规格」——由它引用的舰船方案编译而来（compileShip）。
 * 舰船一旦造出来，规格就固定在这艘船身上：改方案不影响已经在场的船，
 * 所以要变强只能造新船、或者整队换装（那是玩家的显式操作）。
 *
 * @param u  { shipId, x, y, ... }
 * @param rt { maxHp, regen, maxShield, shieldRegen, hitR, weapons, weaponSlots,
 *             weapon, fireRate, abilities }
 */
export function initUnit(u, rt) {
  u.maxHp = rt.maxHp;
  u.hp = rt.maxHp;
  u.regen = rt.regen || 0;

  u.maxShieldBase = rt.maxShield || 0;
  u.shieldCap = u.maxShieldBase;
  u.shieldRegen = rt.shieldRegen || 0;
  u.shield = 0;

  // 多武器：每个槽位一套独立的冷却/连发状态
  u.fireRate = rt.fireRate || 1;
  u.weapons = buildWeaponStates(rt);
  u.weapon = u.weapons[0]?.id ?? "laser";      // 兼容别名，渲染/统计用
  u.hitR = rt.hitR === undefined ? DEFAULT_HIT_R : rt.hitR;   // 受击半径

  // 迁移（每鸟半径）：受击半径同时就是**船体半径**。
  // 一个数、一个来源：分离力的间隙判据、墙体硬碰撞、出生点检查、武器命中判定全用它。
  // 注意 **不是** shieldHitR —— 那是"护盾层外扩半径"，目前没有任何代码读它。
  u.radius = u.hitR;
  u.mass = 1;                  // 每单位质量；有效质量 = u.mass × G.mass（默认都是 1）

  // 支援能力挂在「这一艘船」上，不再读小队
  u.abilities = rt.abilities || [];

  // 这一艘船占的指挥值（散兵池按实际舰船计价用得到）
  u.command = rt.command || 0;

  u.fxCd = 0;                   // 支援特效节流
}

/**
 * 舰船「型号签名」。
 * -----------------------------------------------------------------
 * 舰船身上不存方案引用，那怎么判断散兵池里哪些船能补进一支编制？
 * 答案：**属性相同就是同型**。签名取的是玩家改不动的那些结构属性
 * （最大血量 / 护盾容量 / 受击半径 / 射速 / 武器槽 / 能力），
 * 战损（当前血量）不参与。
 *
 * 两个方案的签名撞了，说明它们打起来完全一样，互相顶替没有区别。
 */
export function unitSignature(u) {
  return [
    u.maxHp, u.maxShieldBase || 0, u.hitR, u.fireRate,
    (u.weapons || []).map(w => w.id).join(","),
    (u.abilities || []).map(a => a.id).join(",")
  ].join("|");
}

/** 方案编译结果 → 签名，必须和 unitSignature 用同一套口径 */
export function runtimeSignature(rt) {
  return [
    rt.maxHp, rt.maxShield || 0,
    rt.hitR === undefined ? DEFAULT_HIT_R : rt.hitR,
    rt.fireRate || 1,
    (rt.weapons || []).join(","),
    (rt.abilities || []).map(a => a.id).join(",")
  ].join("|");
}

/**
 * 把一艘**已经存在**的船改装成另一种规格，保留战损比。
 *
 * 这条是「强行改方案」用的：正常流程被命令层的锁挡在外面
 * （在役就禁止改），只有绕过锁的强制同步才会调它。
 */
export function retrofitUnit(u, rt) {
  const ratio = u.maxHp > 0 ? Math.max(0, u.hp) / u.maxHp : 1;

  u.maxHp = rt.maxHp;
  u.hp = Math.max(1, rt.maxHp * ratio);
  u.regen = rt.regen || 0;

  u.maxShieldBase = rt.maxShield || 0;
  u.shieldRegen = rt.shieldRegen || 0;
  u.shieldCap = u.maxShieldBase + (u.grantMax || 0);
  if (u.shield > u.shieldCap) u.shield = u.shieldCap;

  u.weapons = buildWeaponStates(rt, u.weapons || []);   // 用槽位继承冷却
  u.weapon = u.weapons[0]?.id ?? "laser";
  u.hitR = rt.hitR === undefined ? DEFAULT_HIT_R : rt.hitR;
  u.radius = u.hitR;                                   // 船体半径与受击半径永远同源
  if (!(u.mass > 0)) u.mass = 1;
  u.abilities = rt.abilities || [];
  u.fireRate = rt.fireRate || 1;
  u.command = rt.command || 0;
}

/** 把 sq.p（小队参数）当成一份运行时规格；只为旧路径保留 */
function paramsAsRuntime(p) {
  return {
    maxHp: p.hp, regen: p.regen,
    maxShield: p.maxShield || 0, shieldRegen: p.shieldRegen || 0,
    hitR: p.hitR, weapons: p.weapons, weaponSlots: p.weaponSlots,
    weapon: p.weapon, fireRate: p.fireRate, abilities: p.abilities || []
  };
}

/** 初始化一个单位的战斗状态（小队参数版，旧接口） */
export function initCombat(u, sq) {
  initUnit(u, paramsAsRuntime(sq.p));
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
      if (sq.p.abilities !== undefined) u.abilities = sq.p.abilities;

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
