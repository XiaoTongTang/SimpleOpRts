/**
 * 武器系统
 * ---------------------------------------------------------------
 * 只负责：锁定最近敌人、判定命中、产出伤害事件、推进弹丸。
 * 不负责：血量、护盾、死亡（那是 defense-system.js）。
 *
 * 三种武器（对应 design/攻击与防御机制.md）：
 *   贯穿射线  矩形范围 · 无视护盾 · 中等冷却/中等单发
 *   激光      点对点   · 被护盾抵扣 · 最快冷却/最低单发（DPM 最高）
 *   鱼雷      飞向锁定点（不追踪）· 大范围爆炸 · 最慢冷却/最高单发
 *
 * 与移动机制完全无关：这里不读也不写任何位置力。
 */

export const WEAPONS = {
  ray: {
    id: "ray", name: "贯穿射线",
    range: 250, dmg: 12, cd: 1.30,
    pierceShield: true,
    shape: "rect", width: 28
  },
  laser: {
    id: "laser", name: "激光",
    range: 300, dmg: 6, cd: 0.50,
    pierceShield: false,
    shape: "point"
  },
  torpedo: {
    id: "torpedo", name: "鱼雷",
    range: 380, dmg: 40, cd: 3.00,
    pierceShield: false,
    shape: "circle", radius: 68, speed: 210
  }
};

export const WEAPON_IDS = ["ray", "laser", "torpedo"];

// 贯穿射线的两段式时序（视觉用）
const RAY_AIM = 0.06;    // 先展示瞄准线
const RAY_FLY = 0.11;    // 再射出拖尾小方块
const RAY_HOLD = 0.10;   // 飞完后的余晖

/**
 * 一帧的武器结算。
 * @param units      全部单位
 * @param squads     小队（取 faction）
 * @param projectiles 飞行中的鱼雷（会被本函数增删）
 * @param dt         时间步长
 * @param hits       输出：本帧的伤害事件 [{t, dmg, pierce}]
 */
export function stepWeapons(units, squads, projectiles, dt, hits, now = 0, fx = null) {
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

    // 锁定射程内最近的敌人
    let tgt = null, bd = w.range * w.range;
    for (let j = 0; j < n; j++) {
      const o = units[j];
      if (o.hp <= 0) continue;
      if (squads[o.squad].faction === myF) continue;
      const dx = o.x - u.x, dy = o.y - u.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; tgt = o; }
    }
    if (!tgt) continue;

    u.cd = w.cd;
    u.lastFire = now;          // 供 UI 统计"最近 1 秒开过火"

    if (w.shape === "point") {
      // 激光：点对点，无范围
      hits.push({ t: tgt, dmg: w.dmg, pierce: w.pierceShield });
      if (fx) fx.push({
        type: "beam", faction: myF,
        hue: squads[u.squad].hue,      // 激光用小队色相，和单位颜色一致
        x1: u.x, y1: u.y, x2: tgt.x, y2: tgt.y,
        life: 0.09, max: 0.09
      });

    } else if (w.shape === "rect") {
      // 贯穿射线：以「射手→目标」为中轴的长方形
      const dx = tgt.x - u.x, dy = tgt.y - u.y;
      const L = Math.hypot(dx, dy) || 1;
      const ux = dx / L, uy = dy / L;
      const halfW = w.width * 0.5;
      for (let j = 0; j < n; j++) {
        const o = units[j];
        if (o.hp <= 0) continue;
        if (squads[o.squad].faction === myF) continue;
        const rx = o.x - u.x, ry = o.y - u.y;
        const along = rx * ux + ry * uy;            // 沿射线方向的投影
        if (along < 0 || along > w.range) continue;
        const perp = Math.abs(rx * uy - ry * ux);   // 到中轴的垂距
        if (perp > halfW) continue;
        hits.push({ t: o, dmg: w.dmg, pierce: w.pierceShield });
        // 只有视觉有延迟：火花等小方块飞到该敌人处才亮
        if (fx) fx.push({
          type: "impact", hue,
          x: o.x, y: o.y,
          delay: RAY_AIM + (along / w.range) * RAY_FLY,
          life: 0.20, max: 0.20
        });
      }
      // 视觉：先亮瞄准线，再飞出一个拖尾小方块
      if (fx) fx.push({
        type: "rayshot", faction: myF, hue,
        x1: u.x, y1: u.y,
        x2: u.x + ux * w.range,
        y2: u.y + uy * w.range,
        aim: RAY_AIM, fly: RAY_FLY,
        seed: Math.random() * Math.PI * 2,
        life: RAY_AIM + RAY_FLY + RAY_HOLD,
        max: RAY_AIM + RAY_FLY + RAY_HOLD
      });

    } else if (w.shape === "circle") {
      // 鱼雷：飞向「锁定瞬间的位置」，不追踪
      const dx = tgt.x - u.x, dy = tgt.y - u.y;
      const L = Math.hypot(dx, dy) || 1;
      projectiles.push({
        x: u.x, y: u.y,
        vx: (dx / L) * w.speed,
        vy: (dy / L) * w.speed,
        travelled: 0,
        maxDist: L,
        dmg: w.dmg,
        radius: w.radius,
        pierce: w.pierceShield,
        faction: myF,
        hue,
        seed: Math.random() * Math.PI * 2   // 烟迹扰动的相位
      });
      if (fx) fx.push({
        type: "muzzle", faction: myF, hue,
        x: u.x, y: u.y,
        life: 0.12, max: 0.12
      });
    }
  }

  // ---------- 2. 弹丸推进 + 爆炸 ----------
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    const step = Math.hypot(p.vx, p.vy) * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.travelled += step;

    if (p.travelled < p.maxDist) continue;

    projectiles.splice(i, 1);
    if (fx) fx.push({
      type: "blast", faction: p.faction, hue: p.hue,
      x: p.x, y: p.y, r: p.radius,
      life: 0.40, max: 0.40
    });
    const r2 = p.radius * p.radius;
    for (let j = 0; j < n; j++) {
      const o = units[j];
      if (o.hp <= 0) continue;
      if (squads[o.squad].faction === p.faction) continue;
      const dx = o.x - p.x, dy = o.y - p.y;
      if (dx * dx + dy * dy > r2) continue;
      hits.push({ t: o, dmg: p.dmg, pierce: p.pierce });
    }
  }
}
