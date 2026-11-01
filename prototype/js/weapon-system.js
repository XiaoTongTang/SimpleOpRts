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

// 复用的临时数组：每秒上千次查询，不能每次 new
const CAND = [];
const ORDER = [];

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
  }
  SpatialStats.queries++;
  SpatialStats.candidates += out.length;
  return out;
}

const hitROf = o => (o.hitR === undefined ? DEFAULT_HIT_R : o.hitR);

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

  // ---------- 1. 开火 ----------
  for (let i = 0; i < n; i++) {
    const u = units[i];
    if (u.hp <= 0) continue;
    if (u.cd > 0) { u.cd -= dt; continue; }

    const w = WEAPONS[u.weapon];
    if (!w) continue;
    const myF = squads[u.squad].faction;
    const hue = squads[u.squad].hue;
    const range = weaponRange(w);

    // 锁定射程内最近的敌人
    // （保持全量扫描：每帧只发生几次，见 05-空间索引层.md §5.5）
    let tgt = null, bd = range * range;
    for (let j = 0; j < n; j++) {
      const o = units[j];
      if (o.hp <= 0) continue;
      if (squads[o.squad].faction === myF) continue;
      const dx = o.x - u.x, dy = o.y - u.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; tgt = o; }
    }
    if (!tgt) continue;

    u.cd = w.fire.cd;
    u.lastFire = now;          // 供 UI 统计"最近 1 秒开过火"

    const dx = tgt.x - u.x, dy = tgt.y - u.y;
    const L = Math.hypot(dx, dy) || 1;
    const ux = dx / L, uy = dy / L;

    if (w.delivery === "hitscan") {
      fireHitscan(u, w, ux, uy, range, myF, hue, tgt, units, squads, hits, fx, grid);
    } else {
      // 飞行弹：飞向「锁定瞬间的位置」，不追踪
      projectiles.push({
        x: u.x, y: u.y,
        vx: ux * w.travel.speed,
        vy: uy * w.travel.speed,
        travelled: 0,
        maxDist: L,                       // 飞到锁定点
        dmg: w.impact.dmg,
        blastR: w.impact.blastR,
        blastDmg: w.impact.blastDmg,
        pierce: w.impact.pierceShield,
        faction: myF,
        hue,
        contactR: w.hit.contactR,
        seed: Math.random() * Math.PI * 2,   // 烟迹扰动的相位
      });
      if (fx) fx.push({
        type: "muzzle", faction: myF, hue,
        x: u.x, y: u.y,
        life: 0.12, max: 0.12,
      });
    }
  }

  // ---------- 2. 弹丸推进 + 飞行中碰撞 + 起爆 ----------
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];

    const p0x = p.x, p0y = p.y;
    const p1x = p0x + p.vx * dt, p1y = p0y + p.vy * dt;
    const step = Math.hypot(p.vx, p.vy) * dt;
    p.x = p1x;
    p.y = p1y;
    p.travelled += step;

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
      // 纯动能弹：只打命中的那一个，不波及（机枪 / 轨道炮同族）
      hits.push({ t: hitUnit, dmg: p.dmg, pierce: p.pierce });
    }
  }
}
