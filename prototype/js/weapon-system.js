/**
 * 武器系统
 * -----------------------------------------------------------------
 * 只负责：锁定最近敌人、判定命中、产出伤害事件、推进弹丸。
 * 不负责：血量、护盾、死亡（那是 defense-system.js）。
 *
 * 三种武器全部走同一套判定（见 design/.../02-命中判定-扫掠圆.md）：
 *   每发弹 = 一个沿路径移动的圆；命中 = 这个圆在 p0→p1 的扫掠中碰到单位的圆。
 *
 * 武器参数在 weapons.js，这里只有逻辑：加一把枪不需要改这个文件。
 *
 * 与移动机制完全无关：这里不读也不写任何位置力。
 */

import {
  UNIT_PAD, DEFAULT_HIT_R, SpatialDebug, SpatialStats, sweptHit,
} from "./spatial.js";
import { WEAPONS, WEAPON_IDS, weaponRange } from "./weapons.js";

export { WEAPONS, WEAPON_IDS };

// 轨道炮的两段式时序（视觉用，不影响判定）
const RAY_AIM = 0.06;    // 先展示瞄准线
const RAY_FLY = 0.11;    // 再射出拖尾小方块
const RAY_HOLD = 0.10;   // 飞完后的余晖

// 导弹拖尾保留多少个位置采样（14 点 ≈ 0.23 秒的航迹，尾迹更短更利落）
const TRAIL_PTS = 14;

// 制导扇区数：把制导范围切成这么多个角度扇区，取敌人最多的那个
const GUIDE_SECTORS = 12;
const SEC_W = new Float64Array(GUIDE_SECTORS);   // 每个扇区的权重和
const SEC_X = new Float64Array(GUIDE_SECTORS);   // 扇区内敌人的方向向量和
const SEC_Y = new Float64Array(GUIDE_SECTORS);

// 复用的临时数组：每秒上千次查询，不能每次 new
const CAND = [];
const ORDER = [];

// 「大半径单位」（基地 / 防御塔）的补丁：
// 网格按圆心入格，宽相位只按弹丸半径 + UNIT_PAD 去查格，
// 半径超过 UNIT_PAD 的单位，其圆心可能落在查询范围外、但它的圆仍与射线相交。
// 这类单位每帧只有个位数，所以每帧重新收集，查询时无重复地补进候选集。
const BIG = [];
const BIG_STAMP = new Int32Array(16384);
let bigGen = 0;

/**
 * 把「潜在命中者」的下标填进 out。
 * - 有 grid 且没开调试 → 走空间索引（宽相位，候选集小）
 * - 没 grid 或开了 brute → 全部单位（= 原来的 O(n)，用于差分测试）
 *
 * 注意：这里给的是**候选集**，不是答案。调用方仍要用精确几何再判一次。
 */
function fillCircle(g, x, y, r, units, out) {
  out.length = 0;
  if (!g || SpatialDebug.brute) {
    for (let i = 0; i < units.length; i++) out.push(i);
  } else {
    g.queryCircle(x, y, r, out);
    appendBig(out);
  }
  SpatialStats.queries++;
  SpatialStats.candidates += out.length;
  return out;
}

function fillSegment(g, x0, y0, x1, y1, r, units, out) {
  out.length = 0;
  if (!g || SpatialDebug.brute) {
    for (let i = 0; i < units.length; i++) out.push(i);
  } else {
    g.querySegment(x0, y0, x1, y1, r, out);
    appendBig(out);
  }
  SpatialStats.queries++;
  SpatialStats.candidates += out.length;
  return out;
}

/** 把大半径单位补进候选集（去重靠时间戳，不额外分配） */
function appendBig(out) {
  if (BIG.length === 0) return;
  bigGen++;
  for (let i = 0; i < out.length; i++) BIG_STAMP[out[i]] = bigGen;
  for (let i = 0; i < BIG.length; i++) {
    const idx = BIG[i];
    if (idx >= BIG_STAMP.length || BIG_STAMP[idx] === bigGen) continue;
    BIG_STAMP[idx] = bigGen;
    out.push(idx);
  }
}

const hitROf = o => (o.hitR === undefined ? DEFAULT_HIT_R : o.hitR);

/**
 * 确定性扇形：第 i 发（共 n 发）在 fanRad 宽度内均匀铺开。
 * n = 1 或 fan = 0 时居中（偏移 0），所以不散射的武器行为完全不变。
 * n = 4, fan = 3° → -1.5° / -0.5° / +0.5° / +1.5°
 */
function spreadOffset(i, n, fanRad) {
  if (n <= 1 || fanRad === 0) return 0;
  return (i / (n - 1) - 0.5) * fanRad;
}

/**
 * 制导方向：不锁定任何具体目标，只看「制导范围内敌人最密集的方向」。
 *
 * 做法：把范围切成 GUIDE_SECTORS 个角度扇区，统计每个扇区的敌人数，
 * 取最密的那一个，再用该扇区内敌人的平均方向作为目标角。
 *
 * 为什么不用「加权质心」：两个敌群分居左右时，质心会落在中间的**空档**，
 * 导弹会从两坨人中间穿过去。按扇区取最密的那一个才不会。
 *
 * @returns {number|null} 目标角度（弧度）；范围内没有敌人时返回 null（保持当前航向）
 */
function guideAngle(p, units, squads, grid) {
  const R = p.guideR;
  if (!(R > 0)) return null;

  const R2 = R * R;
  for (let i = 0; i < GUIDE_SECTORS; i++) {
    SEC_W[i] = 0; SEC_X[i] = 0; SEC_Y[i] = 0;
  }

  fillCircle(grid, p.x, p.y, R + UNIT_PAD, units, CAND);

  const k = GUIDE_SECTORS / (Math.PI * 2);
  for (let c = 0; c < CAND.length; c++) {
    const o = units[CAND[c]];
    if (o.hp <= 0) continue;
    if (squads[o.squad].faction === p.faction) continue;

    const dx = o.x - p.x, dy = o.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > R2 || d2 < 1e-6) continue;

    const d = Math.sqrt(d2);
    // 权重：近的略重（0.6 ~ 1.0）。这样一坨人总能压过单独一个近处的。
    const w = 1 - 0.4 * (d / R);

    let s = ((Math.atan2(dy, dx) + Math.PI) * k) | 0;
    if (s < 0) s = 0; else if (s >= GUIDE_SECTORS) s = GUIDE_SECTORS - 1;

    SEC_W[s] += w;
    SEC_X[s] += dx / d;
    SEC_Y[s] += dy / d;
  }

  let best = -1, bestW = 0;
  for (let i = 0; i < GUIDE_SECTORS; i++) {
    if (SEC_W[i] > bestW) { bestW = SEC_W[i]; best = i; }
  }
  if (best < 0) return null;

  return Math.atan2(SEC_Y[best], SEC_X[best]);   // 该扇区内的平均方向
}

/**
 * 瞬时武器（激光 / 轨道炮）
 * 沿射线扫一条胶囊，按命中先后排序，取前 maxHits 个。
 */
function fireHitscan(u, w, ux, uy, range, myF, hue, tgt, units, squads, hits, fx, grid) {
  const x0 = u.x, y0 = u.y;
  const x1 = x0 + ux * range, y1 = y0 + uy * range;
  const cr = w.hit.contactR;

  // 宽相位：只取射线上那几格里的单位
  fillSegment(grid, x0, y0, x1, y1, cr + UNIT_PAD, units, CAND);

  // 窄相位 + 按 t 排序（= 打中谁在前 = 穿透顺序）
  ORDER.length = 0;
  for (let k = 0; k < CAND.length; k++) {
    const o = units[CAND[k]];
    if (o.hp <= 0) continue;
    if (squads[o.squad].faction === myF) continue;
    const t = sweptHit(x0, y0, x1, y1, cr, o.x, o.y, hitROf(o));
    if (t >= 0) ORDER.push({ o, t });
  }
  ORDER.sort((a, b) => a.t - b.t);

  const limit = w.hit.maxHits < 0 ? ORDER.length : Math.min(w.hit.maxHits, ORDER.length);
  for (let k = 0; k < limit; k++) {
    const o = ORDER[k].o;
    hits.push({ t: o, dmg: w.impact.dmg, pierce: w.impact.pierceShield });

    // 视觉延迟：火花飞到该敌人处才亮
    if (fx && w.fx === "rayshot") {
      fx.push({
        type: "impact", hue,
        x: o.x, y: o.y,
        delay: RAY_AIM + ORDER[k].t * RAY_FLY,
        life: 0.20, max: 0.20,
      });
    }
  }

  if (!fx) return;

  if (w.fx === "beam") {
    fx.push({
      type: "beam", faction: myF, hue,
      x1: u.x, y1: u.y, x2: tgt.x, y2: tgt.y,
      life: 0.09, max: 0.09,
    });
  } else if (w.fx === "rayshot") {
    fx.push({
      type: "rayshot", faction: myF, hue,
      x1: x0, y1: y0, x2: x1, y2: y1,
      aim: RAY_AIM, fly: RAY_FLY,
      seed: Math.random() * Math.PI * 2,
      life: RAY_AIM + RAY_FLY + RAY_HOLD,
      max: RAY_AIM + RAY_FLY + RAY_HOLD,
    });
  }
}

/**
 * 一帧的武器结算。
 * @param units      全部单位
 * @param squads     小队（取 faction）
 * @param projectiles 飞行中的弹丸（会被本函数增删）
 * @param dt         时间步长
 * @param hits       输出：本帧的伤害事件 [{t, dmg, pierce}]
 * @param grid       空间索引（可选）。为 null 时退化成全量扫描，行为完全一致
 */
export function stepWeapons(units, squads, projectiles, dt, hits, now = 0, fx = null, grid = null) {
  const n = units.length;

  // 每帧刷新一次「大半径单位」清单（基地 / 防御塔），供宽相位补漏
  BIG.length = 0;
  for (let i = 0; i < n; i++) {
    if (units[i].hp > 0 && hitROf(units[i]) > UNIT_PAD) BIG.push(i);
  }

  // ---------- 1. 开火 ----------
  for (let i = 0; i < n; i++) {
    const u = units[i];
    if (u.hp <= 0) continue;

    const w = WEAPONS[u.weapon];
    if (!w) continue;

    const myF = squads[u.squad].faction;
    const hue = squads[u.squad].hue;
    const range = weaponRange(w);
    const shots = w.fire.burst > 0 ? (w.fire.burst | 0) : 1;

    // ---- 决定这一帧要不要开一枪，以及打谁 ----
    let tgt;

    if (u.burstLeft > 0) {
      // 一轮还没打完：继续朝同一个目标按短装填间隔一发一发地打
      tgt = u.burstTarget;
      if (!tgt || tgt.hp <= 0) {          // 目标没了就中止这一轮
        u.burstLeft = 0;
        u.burstTarget = null;
        u.cd = w.fire.cd;
        continue;
      }
      u.burstTimer -= dt;
      if (u.burstTimer > 0) continue;     // 还在等下一发
    } else {
      if (u.cd > 0) { u.cd -= dt; continue; }

      // 锁定射程内最近的敌人
      // （保持全量扫描：每帧只发生几次，见 05-空间索引层.md §5.5）
      tgt = null;
      let bd = range * range;
      for (let j = 0; j < n; j++) {
        const o = units[j];
        if (o.hp <= 0) continue;
        if (squads[o.squad].faction === myF) continue;
        const dx = o.x - u.x, dy = o.y - u.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bd) { bd = d2; tgt = o; }
      }
      if (!tgt) continue;

      u.burstLeft = shots;
      u.burstTarget = tgt;
      u.burstTimer = 0;
    }

    // ---- 打这一枪（每帧最多一发） ----
    u.lastFire = now;          // 供 UI 统计"最近 1 秒开过火"

    const dx = tgt.x - u.x, dy = tgt.y - u.y;
    const baseAng = Math.atan2(dy, dx);
    const fanRad = (w.fire.fan || 0) * Math.PI / 180;
    const idx = shots - u.burstLeft;                 // 本轮第几发（0 起）
    const ang = baseAng + spreadOffset(idx, shots, fanRad);

    if (w.delivery === "hitscan") {
      fireHitscan(u, w, Math.cos(ang), Math.sin(ang),
                  range, myF, hue, tgt, units, squads, hits, fx, grid);
    } else {
      // 飞行弹：朝「当前瞄准点」发射；tracking 的会自己拐过去
      const spd = w.travel.speed;
      projectiles.push({
        x: u.x, y: u.y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        travelled: 0,
        maxDist: range,                   // = speed × lifetime
        dmg: w.impact.dmg,
        blastR: w.impact.blastR,
        blastDmg: w.impact.blastDmg,
        pierce: w.impact.pierceShield,
        faction: myF,
        hue,
        contactR: w.hit.contactR,

        // 制导
        turnRate: w.travel.turnRate || 0,
        guideR: w.travel.guideR || 0,

        // 视觉
        style: w.trail || "smoke",
        path: w.trail === "line" ? [u.x, u.y] : null,
        seed: Math.random() * Math.PI * 2,   // 烟迹扰动的相位
      });

      if (fx) fx.push({
        type: "muzzle", faction: myF, hue,
        x: u.x, y: u.y,
        life: 0.12, max: 0.12,
      });
    }

    // ---- 一轮的记账 ----
    u.burstLeft--;
    if (u.burstLeft > 0) {
      u.burstTimer = w.fire.burstDelay || 0;   // 短装填：等下一发
    } else {
      u.cd = w.fire.cd;                        // 一轮打完，进冷却
      u.burstTarget = null;
    }
  }

  // ---------- 2. 弹丸推进 + 飞行中碰撞 + 起爆 ----------
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];

    // ---- 制导：每帧朝「制导范围内敌人最密集的方向」转一点 ----
    // 只改方向不改速率，所以弹道是等曲率圆弧。
    // 不锁定任何目标 —— 目标死了也无所谓，下一步自然被旁边的人吸过去。
    if (p.turnRate > 0 && p.guideR > 0) {
      const ga = guideAngle(p, units, squads, grid);
      if (ga !== null) {
        const va = Math.atan2(p.vy, p.vx);

        let da = ga - va;
        if (da >  Math.PI) da -= Math.PI * 2;
        if (da < -Math.PI) da += Math.PI * 2;

        const maxTurn = p.turnRate * dt;
        const turn = da > maxTurn ? maxTurn : (da < -maxTurn ? -maxTurn : da);

        const spd = Math.hypot(p.vx, p.vy);
        p.vx = Math.cos(va + turn) * spd;
        p.vy = Math.sin(va + turn) * spd;
      }
    }

    const p0x = p.x, p0y = p.y;
    const p1x = p0x + p.vx * dt, p1y = p0y + p.vy * dt;
    const step = Math.hypot(p.vx, p.vy) * dt;
    p.x = p1x;
    p.y = p1y;
    p.travelled += step;

    // 航迹（只有线状拖尾需要；最多留 TRAIL_PTS 个采样）
    if (p.path) {
      p.path.push(p1x, p1y);
      if (p.path.length > TRAIL_PTS * 2) p.path.splice(0, 2);
    }

    // ---- 飞行中的碰撞：取这一帧**最早**接触到的敌人 ----
    // 判定和弹道解耦：这里只吃 p0→p1 这一段，不管 p1 是怎么算出来的
    let hitT = -1, hitUnit = null;
    const cr = p.contactR || 0;
    if (cr > 0) {
      fillSegment(grid, p0x, p0y, p1x, p1y, cr + UNIT_PAD, units, CAND);
      for (let cj = 0; cj < CAND.length; cj++) {
        const o = units[CAND[cj]];
        if (o.hp <= 0) continue;
        if (squads[o.squad].faction === p.faction) continue;
        const t = sweptHit(p0x, p0y, p1x, p1y, cr, o.x, o.y, hitROf(o));
        if (t >= 0 && (hitT < 0 || t < hitT)) { hitT = t; hitUnit = o; }
      }
    }

    // 没撞上东西、也还没飞到落点 —— 继续飞
    if (hitT < 0 && p.travelled < p.maxDist) continue;

    // ---- 起爆 / 命中 ----
    projectiles.splice(i, 1);
    if (hitT >= 0) {
      // 炸在接触点，不是帧末位置
      p.x = p0x + (p1x - p0x) * hitT;
      p.y = p0y + (p1y - p0y) * hitT;
    }

    if (p.blastR > 0) {
      // 有爆炸：接触即起爆，伤害由范围结算（鱼雷）
      if (fx) fx.push({
        type: "blast", faction: p.faction, hue: p.hue,
        x: p.x, y: p.y, r: p.blastR,
        life: 0.40, max: 0.40,
      });

      const r2 = p.blastR * p.blastR;
      fillCircle(grid, p.x, p.y, p.blastR + UNIT_PAD, units, CAND);
      for (let cj = 0; cj < CAND.length; cj++) {
        const o = units[CAND[cj]];
        if (o.hp <= 0) continue;
        if (squads[o.squad].faction === p.faction) continue;
        const dx = o.x - p.x, dy = o.y - p.y;
        if (dx * dx + dy * dy > r2) continue;
        hits.push({ t: o, dmg: p.blastDmg, pierce: p.pierce });
      }
    } else if (hitUnit) {
      // 纯动能弹：只打命中的那一个，不波及（链炮 / 机枪）
      hits.push({ t: hitUnit, dmg: p.dmg, pierce: p.pierce });

      // 命中泛白：和激光命中点同源的观感
      if (fx) fx.push({
        type: "spark", hue: p.hue,
        x: p.x, y: p.y,
        s: Math.max(0.8, (p.contactR || 2) / 2),
        life: 0.15, max: 0.15,
      });
    }
  }
}
