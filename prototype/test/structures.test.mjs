/**
 * 防御塔用导弹 + 大半径单位的回归测试
 *   node prototype/test/structures.test.mjs
 *
 * 两件事：
 *   1. 防御塔用导弹：射程与普通导弹一致、冷却 1s、命中按爆炸结算
 *   2. 基地 / 防御塔这类 hitR ≫ UNIT_PAD 的单位，不能被空间索引漏掉
 */

import { Grid, SpatialDebug } from "../js/spatial.js";
import { stepWeapons } from "../js/weapon-system.js";
import { WEAPONS, weaponRange } from "../js/weapons.js";

let fail = 0;
const ok = (cond, msg) => {
  if (!cond) fail++;
  console.log("  " + (cond ? "✓" : "✗") + " " + msg);
};

// ---------------------------------------------------------------
console.log("\n[1] 防御塔用导弹：射程 / 冷却 / 伤害");
{
  const W = WEAPONS.towermissile;
  const M = WEAPONS.missile;
  const RANGE = weaponRange(W);

  console.log("  取自 weapons.js：射程 " + Math.round(RANGE) + "（普通导弹 " +
              Math.round(weaponRange(M)) + "）  冷却 " + W.fire.cd + "s  伤害 " + W.impact.dmg);

  ok(RANGE === weaponRange(M), "射程与普通导弹一致（" + Math.round(RANGE) + "）");
  ok(W.fire.cd === 1, "冷却 1 秒（实际 " + W.fire.cd + "）");
  ok(W.impact.dmg === M.impact.dmg && W.impact.blastR === M.impact.blastR,
     "伤害 / 爆炸半径与普通导弹相同（" + W.impact.dmg + " / " + W.impact.blastR + "）");
  ok(W.delivery === "projectile", "是飞行弹而不是瞬发（" + W.delivery + "）");

  /** 塔打一个静止目标，跑 frames 帧，返回开火帧号 */
  function shotFrames(dist, frames) {
    const squads = [{ faction: 0 }, { faction: 1 }];
    const tower = { x: 100, y: 300, squad: 0, hp: 800, hitR: 22, weapon: "towermissile", cd: 0 };
    const target = { x: 100 + dist, y: 300, squad: 1, hp: 99999, hitR: 4.5 };
    const units = [tower, target];
    const projectiles = [], hits = [];
    const grid = new Grid(1600, 600, 64);
    const out = [];

    for (let f = 0; f < frames; f++) {
      grid.clear();
      for (let i = 0; i < units.length; i++) grid.insert(i, units[i]);
      const before = projectiles.length;
      hits.length = 0;
      stepWeapons(units, squads, projectiles, 1 / 60, hits, f / 60, null, grid);
      if (projectiles.length > before) out.push(f);
    }
    return out;
  }

  const near = shotFrames(200, 200);
  ok(near.length > 0 && near[0] === 0, "射程内第一帧就开火（第 " + near[0] + " 帧）");

  const BURST = W.fire.burst || 1;
  const DELAY = W.fire.burstDelay || 0;
  const CYCLE = W.fire.cd + (BURST - 1) * DELAY;      // 一轮打完到下一轮第一发

  console.log("  节奏取自 weapons.js：每轮 " + BURST + " 发，间隔 " + DELAY +
              "s，轮间 " + W.fire.cd + "s（整轮周期 " + CYCLE.toFixed(2) + "s）");

  const shots = shotFrames(400, Math.ceil((CYCLE * 2 + 0.02) * 60));
  ok(shots.length >= BURST * 2, "两轮内至少打出 " + (BURST * 2) + " 发（实际 " + shots.length + "）");

  // 逐发核对间隔：轮内 = burstDelay；轮间 = cd（cd 从一轮的最后一发起算）
  const tol = 1.5 / 60;
  let bad = [];
  for (let i = 1; i < shots.length; i++) {
    const gap = (shots[i] - shots[i - 1]) / 60;
    const expect = (i % BURST === 0) ? W.fire.cd : DELAY;
    if (Math.abs(gap - expect) > tol) bad.push(i + ":" + gap.toFixed(3) + "≠" + expect.toFixed(3));
  }
  ok(bad.length === 0, "逐发间隔与参数表一致（偏差 " + bad.length + " 处" +
     (bad.length ? "：" + bad.slice(0, 3).join(" ") : "") + "）");
}

// ---------------------------------------------------------------
console.log("\n[2] 大半径单位（基地 / 防御塔）不会被空间索引漏掉");
{
  // 塔的 hitR = 22 远大于 UNIT_PAD(8)：
  // 射线是朝着「更近的那个小兵」打的，从塔旁边擦过去（离塔心 30 < 22 + 弹半径 14），
  // 但塔心不在「按弹丸半径查出来的格子」里 —— 宽相位必须把这类单位补进候选集，
  // 否则塔对擦过去的子弹就是透明的。
  const squads = [{ faction: 0 }, { faction: 1 }];

  function run(brute, miss) {
    const grid = new Grid(1600, 600, 64);
    const shooter = { x: 100, y: 300, squad: 0, hp: 99999, hitR: 4.5, weapon: "railgun", cd: 0 };
    // 小兵更近 → 瞄准方向由它决定（射线沿 y = 300 水平打出去）
    const decoy = { x: 300, y: 300, squad: 1, hp: 9999, hitR: 4.5 };
    // 塔在射线旁边 miss 像素处
    const tower = { x: 330, y: 300 + miss, squad: 1, hp: 800, hitR: 22 };
    const units = [shooter, decoy, tower];

    grid.clear();
    for (let i = 0; i < units.length; i++) grid.insert(i, units[i]);

    const hits = [];
    SpatialDebug.brute = brute;
    stepWeapons(units, squads, [], 1 / 60, hits, 0, null, grid);
    SpatialDebug.brute = false;
    for (const h of hits) h.t.hp -= h.dmg;
    return { n: hits.length, towerHp: tower.hp, decoyHp: decoy.hp };
  }

  const MISS = 30;                 // 离射线 30px：22 + 14 = 36 ≥ 30，应当命中
  const g = run(false, MISS);
  const b = run(true, MISS);

  ok(g.n === b.n, "网格与全量扫描命中数一致（" + g.n + " vs " + b.n + "）");
  ok(g.towerHp === 800 - WEAPONS.railgun.impact.dmg,
     "擦边也打中了塔（实际剩 " + g.towerHp + " 血）");
  ok(g.decoyHp < 9999, "正对着的小兵也照打（实际剩 " + g.decoyHp + "）");

  // 更远（离射线 60px > 36）应该打不中，确认不是「一律算命中」
  const far = run(false, 60);
  ok(far.towerHp === 800, "太远就打不中塔（实际剩 " + far.towerHp + "）");
  ok(far.decoyHp < 9999, "但小兵还是被打中（实际剩 " + far.decoyHp + "）");
}

console.log(fail === 0 ? "\n全部通过 ✅" : "\n有 " + fail + " 项失败 ❌");
process.exit(fail === 0 ? 0 : 1);
