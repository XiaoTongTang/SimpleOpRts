/**
 * 空间索引层性能对比
 *   node prototype/test/spatial.bench.mjs
 *
 * 两个场景：
 *   A. 现状（3 种武器，鱼雷已做飞行碰撞）
 *   B. 高弹量（每帧 400 发弹丸，每发每帧一次扫掠碰撞）—— P1 加机枪/防空炮之后的样子
 *
 * B 是纯微基准：直接重复 querySegment + 窄相位，不经过 stepWeapons。
 */

import { Grid, sweptHit } from "../js/spatial.js";
import { stepWeapons } from "../js/weapon-system.js";

const mulberry32 = a => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const IDS = ["railgun", "laser", "torpedo"];

function makeWorld(seed, n = 400) {
  const rnd = mulberry32(seed);
  const units = [];
  const squads = [{ faction: 0 }, { faction: 1 }];
  for (let i = 0; i < n; i++) {
    units.push({
      x: 40 + rnd() * 1520, y: 40 + rnd() * 520,
      vx: 0, vy: 0, squad: i & 1,
      hp: 1e9, maxHp: 1e9,
      weapon: IDS[(rnd() * 3) | 0],
      cd: rnd() * 1.5,
    });
  }
  return { units, squads };
}

function runA(useGrid, frames) {
  const { units, squads } = makeWorld(424242);
  const rnd = mulberry32(99);
  const projectiles = [], hits = [];
  const grid = useGrid ? new Grid(1600, 600, 64) : null;

  const tick = f => {
    for (const u of units) {
      u.x += (rnd() - 0.5) * 2; u.y += (rnd() - 0.5) * 2;
      if (u.x < 0) u.x = 0; else if (u.x > 1600) u.x = 1600;
      if (u.y < 0) u.y = 0; else if (u.y > 600) u.y = 600;
    }
    if (grid) { grid.clear(); for (let i = 0; i < units.length; i++) grid.insert(i, units[i]); }
    hits.length = 0;
    stepWeapons(units, squads, projectiles, 1 / 60, hits, f / 60, null, grid);
    for (const h of hits) h.t.hp -= h.dmg;
  };

  for (let f = 0; f < 200; f++) tick(f);               // 预热
  const t0 = process.hrtime.bigint();
  for (let f = 0; f < frames; f++) tick(f);
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6 / frames;
}

// 模拟 P1：每帧 400 发弹丸，各做一次 15px 的扫掠碰撞
function runB(useGrid, projectiles = 400, frames = 500) {
  const rnd = mulberry32(31337);
  const W = 1600, H = 600;
  const units = [];
  for (let i = 0; i < 400; i++) units.push({ x: rnd() * W, y: rnd() * H, hitR: 4.5 });

  const grid = useGrid ? new Grid(W, H, 64) : null;
  const px = new Float32Array(projectiles), py = new Float32Array(projectiles);
  const vx = new Float32Array(projectiles), vy = new Float32Array(projectiles);
  for (let i = 0; i < projectiles; i++) {
    px[i] = rnd() * W; py[i] = rnd() * H;
    const a = rnd() * Math.PI * 2;
    vx[i] = Math.cos(a) * 900; vy[i] = Math.sin(a) * 900;
  }

  const cands = [];
  let acc = 0;

  const tick = () => {
    if (grid) { grid.clear(); for (let i = 0; i < units.length; i++) grid.insert(i, units[i]); }
    for (let i = 0; i < projectiles; i++) {
      const x0 = px[i], y0 = py[i];
      const x1 = x0 + vx[i] / 60, y1 = y0 + vy[i] / 60;
      px[i] = x1; py[i] = y1;
      if (x1 < 0 || x1 > W) vx[i] = -vx[i];
      if (y1 < 0 || y1 > H) vy[i] = -vy[i];

      cands.length = 0;
      if (grid) grid.querySegment(x0, y0, x1, y1, 3, cands);
      else for (let j = 0; j < units.length; j++) cands.push(j);

      for (let k = 0; k < cands.length; k++) {
        const o = units[cands[k]];
        const t = sweptHit(x0, y0, x1, y1, 3, o.x, o.y, o.hitR);
        if (t >= 0) acc++;
      }
    }
  };

  for (let f = 0; f < 60; f++) tick();                 // 预热
  const t0 = process.hrtime.bigint();
  for (let f = 0; f < frames; f++) tick();
  const t1 = process.hrtime.bigint();
  return { ms: Number(t1 - t0) / 1e6 / frames, acc };
}

console.log("A. 现状（400 单位 / 3 种武器 / 鱼雷已做飞行碰撞）");
const a1 = runA(false, 2000), a2 = runA(true, 2000);
console.log("   全量扫描 " + a1.toFixed(4) + " ms/帧    空间索引 " + a2.toFixed(4) + " ms/帧    比值 " + (a1 / a2).toFixed(2) + "×");
console.log("   注：0.02 ms ≈ 16.7ms 帧预算的 0.1%，此时两者都是噪声级");

console.log("\nB. 高弹量（每帧 400 发弹丸 × 一次扫掠碰撞）");
const b1 = runB(false), b2 = runB(true);
console.log("   全量扫描 " + b1.ms.toFixed(4) + " ms/帧    空间索引 " + b2.ms.toFixed(4) + " ms/帧    比值 " + (b1.ms / b2.ms).toFixed(2) + "×");
console.log("   命中累计 " + b1.acc + " / " + b2.acc + (b1.acc === b2.acc ? "  ✅ 一致" : "  ❌ 不一致"));
