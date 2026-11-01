/**
 * 空间索引层回归测试
 *   node prototype/test/spatial.test.mjs
 *
 * 覆盖四件事：
 *   1. sweptHit 的解析解对照（文档 02 第 10 节的手算例）
 *   2. Grid 宽相位不能漏（精确命中者必须在候选集里）
 *   3. stepWeapons 有 grid / 无 grid 的逐帧差分（行为必须完全一致）
 *   4. 候选集压缩比（验证收益是否符合文档 05 的推导）
 */

import { Grid, sweptHit } from "../js/spatial.js";
import { stepWeapons } from "../js/weapon-system.js";
import { WEAPONS, weaponRange } from "../js/weapons.js";

let fail = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log("  ✗ " + msg); fail++; }
  else console.log("  ✓ " + msg);
};

const mulberry32 = a => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---------------------------------------------------------------
console.log("\n[1] sweptHit 对照（文档 02 第 10 节）");
{
  const t = sweptHit(0, 0, 100, 0, 2, 50, 10, 10);
  ok(Math.abs(t - 0.4337) < 0.001, "斜穿 t ≈ 0.4337  实际 " + t.toFixed(4));

  ok(Math.abs(sweptHit(0, 0, 100, 0, 2, 50, 10, 8) - 0.5) < 1e-9, "相切 t = 0.5");
  ok(sweptHit(0, 0, 100, 0, 2, 50, 25, 11) === -1, "未命中 → -1");
  ok(sweptHit(50, 5, 105, 5, 3, 50, 12, 11) === 0, "帧首已重叠 → 0");
  ok(sweptHit(-5, 0, 20, 0, 3, 50, 0, 11) === -1, "这一帧还走不到 → -1");
  ok(sweptHit(10, 10, 10, 10, 3, 50, 0, 11) === -1, "静止弹丸 → -1");
}

// ---------------------------------------------------------------
console.log("\n[2] 宽相位不漏格（候选集 ⊇ 真命中集）");
{
  const rnd = mulberry32(20261101);
  const W = 1600, H = 600, N = 400;
  const grid = new Grid(W, H, 64);
  const units = [];
  for (let i = 0; i < N; i++) units.push({ x: rnd() * W, y: rnd() * H });

  grid.clear();
  for (let i = 0; i < N; i++) grid.insert(i, units[i]);

  let hit = 0, miss = 0;
  for (let k = 0; k < 3000; k++) {
    const x0 = rnd() * W, y0 = rnd() * H;
    const ang = rnd() * Math.PI * 2;
    const L = 20 + rnd() * 360;
    const x1 = x0 + Math.cos(ang) * L, y1 = y0 + Math.sin(ang) * L;
    const r = 2 + rnd() * 12;

    const set = new Set(grid.querySegment(x0, y0, x1, y1, r + 8, []));
    for (let i = 0; i < N; i++) {
      const o = units[i];
      if (sweptHit(x0, y0, x1, y1, r, o.x, o.y, 0) >= 0) {
        hit++;
        if (!set.has(i)) miss++;
      }
    }
  }
  ok(miss === 0, "线段查询 3000 次 / 命中 " + hit + " 个 / 漏格 " + miss);

  let hit2 = 0, miss2 = 0;
  for (let k = 0; k < 3000; k++) {
    const x = rnd() * W, y = rnd() * H, r = 5 + rnd() * 50;
    const set = new Set(grid.queryCircle(x, y, r + 8, []));
    for (let i = 0; i < N; i++) {
      const o = units[i];
      const dx = o.x - x, dy = o.y - y;
      if (dx * dx + dy * dy <= r * r) {
        hit2++;
        if (!set.has(i)) miss2++;
      }
    }
  }
  ok(miss2 === 0, "圆形查询 3000 次 / 命中 " + hit2 + " 个 / 漏格 " + miss2);
}

// ---------------------------------------------------------------
console.log("\n[3] stepWeapons 差分（600 帧，有 grid vs 无 grid）");
{
  const IDS = ["railgun", "laser", "torpedo"];

  function makeWorld(seed) {
    const rnd = mulberry32(seed);
    const units = [];
    const squads = [{ faction: 0 }, { faction: 1 }];
    for (let i = 0; i < 400; i++) {
      units.push({
        x: 40 + rnd() * 1520, y: 40 + rnd() * 520,
        vx: 0, vy: 0, squad: i & 1,
        hp: 120, maxHp: 120, hitR: 4.5,
        weapon: IDS[(rnd() * 3) | 0],
        cd: rnd() * 1.5,
      });
    }
    return { units, squads, rnd };
  }

  function run(useGrid, frames) {
    const { units, squads, rnd } = makeWorld(987654321);
    const projectiles = [], hits = [];
    const grid = useGrid ? new Grid(1600, 600, 64) : null;
    const log = [];

    for (let f = 0; f < frames; f++) {
      for (const u of units) {
        u.x += (rnd() - 0.5) * 2;
        u.y += (rnd() - 0.5) * 2;
        if (u.x < 0) u.x = 0; else if (u.x > 1600) u.x = 1600;
        if (u.y < 0) u.y = 0; else if (u.y > 600) u.y = 600;
      }
      if (grid) {
        grid.clear();
        for (let i = 0; i < units.length; i++) grid.insert(i, units[i]);
      }
      hits.length = 0;
      stepWeapons(units, squads, projectiles, 1 / 60, hits, f / 60, null, grid);

      for (const h of hits) h.t.hp -= h.dmg;

      let hpSum = 0;
      for (const u of units) hpSum += u.hp;
      log.push(hits.length + "|" + hpSum.toFixed(6) + "|" + projectiles.length);

      for (let i = units.length - 1; i >= 0; i--) if (units[i].hp <= 0) units.splice(i, 1);
    }
    return log;
  }

  const a = run(false, 600), b = run(true, 600);
  let diff = -1;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { diff = i; break; }

  ok(diff === -1, diff === -1
    ? "600 帧逐帧一致（命中数 / 总血量 / 弹丸数）"
    : "第 " + diff + " 帧起不一致：" + a[diff] + " vs " + b[diff]);
}

// ---------------------------------------------------------------
console.log("\n[4] 候选集压缩比（对照文档 05 §5.3 的推导）");
{
  const rnd = mulberry32(7);
  const W = 1600, H = 600, N = 400;
  const grid = new Grid(W, H, 64);
  const units = [];
  for (let i = 0; i < N; i++) units.push({ x: rnd() * W, y: rnd() * H });
  grid.clear();
  for (let i = 0; i < N; i++) grid.insert(i, units[i]);

  const cases = [
    ["弹丸命中  线段 15 × r3", "seg", 15, 3],
    ["hitscan   线段 250 × r22", "seg", 250, 22],
    ["爆炸      圆 r50", "cir", 50, 0],
    ["找目标    圆 r300", "cir", 300, 0],
  ];
  for (const [name, kind, a, r] of cases) {
    let sum = 0;
    for (let k = 0; k < 2000; k++) {
      const x = rnd() * W, y = rnd() * H, out = [];
      if (kind === "seg") {
        const ang = rnd() * Math.PI * 2;
        grid.querySegment(x, y, x + Math.cos(ang) * a, y + Math.sin(ang) * a, r, out);
      } else {
        grid.queryCircle(x, y, a, out);
      }
      sum += out.length;
    }
    const avg = sum / 2000;
    console.log("  " + name.padEnd(26) + "候选 " + avg.toFixed(1).padStart(6) +
                " / 400   收益 " + (400 / avg).toFixed(1) + "×");
  }
}

// ---------------------------------------------------------------
console.log("\n[5] 鱼雷飞行中接触起爆");
{
  // 敌舰在 (600,300)；鱼雷从 (100,300) 向右飞，落点设到 900（远超敌舰）
  // 有接触判定 → 应该在敌舰前方 ~9.5px 处起爆
  // 无接触判定 → 会飞到 x=900 才炸，敌舰毫发无伤
  const squads = [{ faction: 1 }];
  const units = [
    { x: 600, y: 300, hp: 200, maxHp: 200, squad: 0, hitR: 4.5 },
  ];
  const projectiles = [{
    x: 100, y: 300, vx: 210, vy: 0,
    travelled: 0, maxDist: 800,
    dmg: 18, blastR: 50, blastDmg: 18, pierce: false,
    faction: 0, hue: 30, contactR: 5,
  }];
  const hits = [], fx = [];
  const grid = new Grid(1600, 600, 64);

  let guard = 0;
  while (projectiles.length && guard++ < 1000) {
    grid.clear();
    for (let i = 0; i < units.length; i++) grid.insert(i, units[i]);
    hits.length = 0;
    stepWeapons(units, squads, projectiles, 1 / 60, hits, guard / 60, fx, grid);
    for (const h of hits) h.t.hp -= h.dmg;
  }

  const blast = fx.find(e => e.type === "blast");
  const bx = blast ? blast.x : NaN;

  ok(!isNaN(bx) && bx > 560 && bx < 596,
     "在接触点提前起爆（x=" + bx.toFixed(1) + "，敌舰在 600）");
  ok(hits.length > 0, "起爆造成了伤害（" + hits.length + " 个目标）");
  ok(units[0].hp < 200, "敌舰掉血：" + units[0].hp.toFixed(1));
}

// 对照：把 contactR 设成 0，鱼雷应该飞过敌舰、在 900 处空爆
{
  const squads = [{ faction: 1 }];
  const units = [{ x: 600, y: 300, hp: 200, maxHp: 200, squad: 0, hitR: 4.5 }];
  const projectiles = [{
    x: 100, y: 300, vx: 210, vy: 0,
    travelled: 0, maxDist: 800,
    dmg: 18, blastR: 50, blastDmg: 18, pierce: false,
    faction: 0, hue: 30, contactR: 0,
  }];
  const hits = [], fx = [];
  const grid = new Grid(1600, 600, 64);

  let guard = 0;
  while (projectiles.length && guard++ < 1000) {
    grid.clear();
    for (let i = 0; i < units.length; i++) grid.insert(i, units[i]);
    hits.length = 0;
    stepWeapons(units, squads, projectiles, 1 / 60, hits, guard / 60, fx, grid);
  }

  const blast = fx.find(e => e.type === "blast");
  ok(blast && blast.x > 880, "contactR=0 时飞到落点空爆（x=" + (blast ? blast.x.toFixed(1) : "?") + "）");
  ok(units[0].hp === 200, "敌舰毫发无伤（证明上一项不是保底命中）");
}

// ---------------------------------------------------------------
console.log("\n[6] 轨道炮最多穿透 3 个单位");
{
  const squads = [{ faction: 0 }, { faction: 1 }];
  const units = [{ x: 100, y: 300, hp: 500, maxHp: 500, squad: 0, hitR: 4.5, weapon: "railgun", cd: 0 }];
  const xs = [150, 200, 250, 300, 340];        // 5 个敌人排在一条线上，都在射程 250 内
  for (const x of xs) {
    units.push({ x, y: 300, hp: 500, maxHp: 500, squad: 1, hitR: 4.5 });
  }

  const hits = [], projectiles = [];
  const grid = new Grid(1600, 600, 64);
  grid.clear();
  for (let i = 0; i < units.length; i++) grid.insert(i, units[i]);

  stepWeapons(units, squads, projectiles, 1 / 60, hits, 0, null, grid);
  for (const h of hits) h.t.hp -= h.dmg;

  ok(hits.length === 3, "一发只打中 3 个（实际 " + hits.length + "）");

  const hurt = units.slice(1).map(o => o.hp < 500);
  ok(hurt[0] && hurt[1] && hurt[2], "前 3 个被打中");
  ok(!hurt[3] && !hurt[4], "后 2 个没被打中");

  // 对照：激光 maxHits = 1，同样布置只该打中 1 个
  const units2 = [{ x: 100, y: 300, hp: 500, maxHp: 500, squad: 0, hitR: 4.5, weapon: "laser", cd: 0 }];
  for (const x of xs) units2.push({ x, y: 300, hp: 500, maxHp: 500, squad: 1, hitR: 4.5 });
  const hits2 = [];
  const g2 = new Grid(1600, 600, 64);
  g2.clear();
  for (let i = 0; i < units2.length; i++) g2.insert(i, units2[i]);
  stepWeapons(units2, squads, [], 1 / 60, hits2, 0, null, g2);
  ok(hits2.length === 1, "激光只打中 1 个（实际 " + hits2.length + "）");
}

// ---------------------------------------------------------------
console.log("\n[7] 导弹追踪 / 鱼雷直飞对照");
{
  function run(weaponId, frames = 150) {
    const squads = [{ faction: 0 }, { faction: 1 }];
    const shooter = { x: 100, y: 300, vx: 0, vy: 0, squad: 0, hp: 999, hitR: 4.5, weapon: weaponId, cd: 0 };
    const target  = { x: 400, y: 300, vx: 0, vy: 0, squad: 1, hp: 999, hitR: 4.5 };
    const units = [shooter, target];
    const projectiles = [], hits = [];
    const grid = new Grid(1600, 600, 64);

    let firstAngle = null, turned = 0;

    for (let f = 0; f < frames; f++) {
      target.y -= 96 / 60;                    // 目标向上匀速逃逸（96 px/s）
      grid.clear();
      for (let i = 0; i < units.length; i++) grid.insert(i, units[i]);

      hits.length = 0;
      stepWeapons(units, squads, projectiles, 1 / 60, hits, f / 60, null, grid);
      for (const h of hits) h.t.hp -= h.dmg;

      for (const p of projectiles) {
        const a = Math.atan2(p.vy, p.vx);
        if (firstAngle === null) firstAngle = a;
        turned = Math.max(turned, Math.abs(a - firstAngle));
      }
    }
    return { target, turned };
  }

  const m = run("missile");
  ok(m.target.hp < 999, "导弹追上了横移目标（掉血 " + (999 - m.target.hp).toFixed(0) + "）");
  ok(m.turned > 0.15, "导弹确实拐弯了（转过 " + m.turned.toFixed(2) + " rad）");

  const t = run("torpedo");
  ok(t.target.hp === 999, "同场景下鱼雷直飞打空（对照组）");
  ok(t.turned < 1e-9, "鱼雷航向没变过（turnRate = 0）");
}

// ---------------------------------------------------------------
console.log("\n[8] 突击链炮：逐发打出 / 3° 扇形");
{
  const W = WEAPONS.chaingun;
  const RANGE = weaponRange(W);
  const DMG = W.impact.dmg;
  const BURST = W.fire.burst;
  const DELAY = W.fire.burstDelay;
  const HIT_R = W.hit.contactR + 4.5;                 // 弹半径 + 目标半径
  const halfFan = (W.fire.fan / 2) * Math.PI / 180;
  const dFull = halfFan > 0 ? HIT_R / Math.tan(halfFan) : Infinity;   // 全中的最远距离

  console.log("  取自 weapons.js：射程 " + Math.round(RANGE) + "  伤害 " + DMG +
              "  burst " + BURST + "  间距 " + DELAY + "s");
  console.log("  全中临界距离 = (contactR + hitR) / tan(fan/2) = " + Math.round(dFull) + "px" +
              (dFull >= RANGE ? "  ≥ 射程 → 扇形不影响命中，只是视觉" : "  < 射程 → 远端会脱靶"));

  function run(dist, frames = 140) {
    const squads = [{ faction: 0 }, { faction: 1 }];
    const shooter = { x: 100, y: 300, squad: 0, hp: 99999, hitR: 4.5, weapon: "chaingun", cd: 0 };
    const target  = { x: 100 + dist, y: 300, squad: 1, hp: 99999, hitR: 4.5 };
    const units = [shooter, target];
    const projectiles = [], hits = [];
    const grid = new Grid(1600, 600, 64);

    const alive = [];
    let total = 0, nHits = 0;

    for (let f = 0; f < frames; f++) {
      grid.clear();
      for (let i = 0; i < units.length; i++) grid.insert(i, units[i]);

      hits.length = 0;
      stepWeapons(units, squads, projectiles, 1 / 60, hits, f / 60, null, grid);
      for (const h of hits) { h.t.hp -= h.dmg; total += h.dmg; nHits++; }

      alive.push(projectiles.length);
    }
    return { total, nHits, alive, peak: Math.max(...alive) };
  }

  // 距离取 95% 射程：飞行时间（≈0.48s）长于整轮射击窗口（0.36s），
  // 这样第 4 发出膛时第 1 发还没落地，才测得到峰值。
  const D = RANGE * 0.95;
  const t = run(D);

  ok(t.alive[0] === 1, "第 1 帧只打出 1 发（实际 " + t.alive[0] + "）");
  ok(t.alive[4] === 1, "约 0.07s 时仍是 1 发（实际 " + t.alive[4] + "）");
  ok(t.peak === BURST, "峰值 " + BURST + " 发同时在场（实际 " + t.peak + "）");

  const fBurst = t.alive.indexOf(BURST);
  const expectFrame = Math.ceil((BURST - 1) * DELAY * 60) - 2;
  ok(fBurst >= expectFrame,
     "第 " + BURST + " 发在约 " + ((BURST - 1) * DELAY).toFixed(2) + "s 后才出现（第 " + fBurst + " 帧）");

  if (D <= dFull) {
    ok(t.nHits === BURST, "该距离下 " + BURST + " 发全中（实际 " + t.nHits + " 次）");
    ok(t.total === BURST * DMG, "总伤害 " + (BURST * DMG) + "（实际 " + t.total + "）");
  } else {
    ok(t.nHits > 0 && t.nHits < BURST, "扇形导致脱靶（" + t.nHits + "/" + BURST + " 命中）");
  }
}

// ---------------------------------------------------------------
console.log("\n[9] 链炮的射弹外观与命中特效");
{
  const squads = [{ faction: 0 }, { faction: 1 }];
  const shooter = { x: 100, y: 300, squad: 0, hp: 999, hitR: 4.5, weapon: "chaingun", cd: 0 };
  const target  = { x: 300, y: 300, squad: 1, hp: 999, hitR: 4.5 };
  const units = [shooter, target];
  const projectiles = [], hits = [], fx = [];
  const grid = new Grid(1600, 600, 64);

  let styleAtBirth = null;

  for (let f = 0; f < 60; f++) {
    grid.clear();
    for (let i = 0; i < units.length; i++) grid.insert(i, units[i]);

    hits.length = 0;
    stepWeapons(units, squads, projectiles, 1 / 60, hits, f / 60, fx, grid);
    for (const h of hits) h.t.hp -= h.dmg;

    if (f === 0 && projectiles.length) styleAtBirth = projectiles[0].style;
  }

  ok(styleAtBirth === "streak", "射弹样式是 streak（线形），实际 " + styleAtBirth);
  ok(fx.some(e => e.type === "spark"), "命中产生了 spark（泛白闪光）");

  const sparks = fx.filter(e => e.type === "spark");
  ok(sparks.length === 4, "近距离 4 发各产生一次 spark（实际 " + sparks.length + "）");
  ok(sparks.every(e => e.max <= 0.2), "闪光很短（" + sparks[0].max + "s），不会糊成一片");

  // 鱼雷走爆炸分支，不应该产生 spark
  const p2 = [], fx2 = [];
  const u2 = [
    { x: 100, y: 300, squad: 0, hp: 999, hitR: 4.5, weapon: "torpedo", cd: 0 },
    { x: 300, y: 300, squad: 1, hp: 999, hitR: 4.5 },
  ];
  const g2 = new Grid(1600, 600, 64);
  for (let f = 0; f < 60; f++) {
    g2.clear();
    for (let i = 0; i < u2.length; i++) g2.insert(i, u2[i]);
    const h2 = [];
    stepWeapons(u2, squads, p2, 1 / 60, h2, f / 60, fx2, g2);
    for (const h of h2) h.t.hp -= h.dmg;
  }
  ok(!fx2.some(e => e.type === "spark"), "鱼雷不产生 spark（走 blast 分支）");
  ok(fx2.some(e => e.type === "blast"), "鱼雷产生了 blast");
}

// ---------------------------------------------------------------
console.log("\n[10] 导弹制导：被吸向「最密集方向」而不是锁定单体");
{
  // 上方 5 个挤成一坨，下方 1 个孤零零 —— 两者都在制导范围内
  function run(guideR, frames = 20) {
    const squads = [{ faction: 0 }, { faction: 1 }];
    const units = [];
    for (let i = 0; i < 5; i++) {
      units.push({ x: 200 + (i % 2) * 18, y: 200 + ((i / 2) | 0) * 18, squad: 1, hp: 9999, hitR: 4.5 });
    }
    units.push({ x: 200, y: 380, squad: 1, hp: 9999, hitR: 4.5 });

    const projectiles = [{
      x: 100, y: 300, vx: 240, vy: 0,
      travelled: 0, maxDist: 480,
      dmg: 40, blastR: 24, blastDmg: 24, pierce: false,
      faction: 0, hue: 200, contactR: 4,
      turnRate: 2.5, guideR,
      style: "line", path: [100, 300],
    }];

    const hits = [];
    const grid = new Grid(1600, 600, 64);

    for (let f = 0; f < frames && projectiles.length; f++) {
      grid.clear();
      for (let i = 0; i < units.length; i++) grid.insert(i, units[i]);
      hits.length = 0;
      stepWeapons(units, squads, projectiles, 1 / 60, hits, f / 60, null, grid);
      for (const h of hits) h.t.hp -= h.dmg;
    }
    return projectiles.length
      ? { vx: projectiles[0].vx, vy: projectiles[0].vy }
      : { vx: 0, vy: 0, gone: true };
  }

  const on = run(180);
  ok(!on.gone && on.vy < -60, "朝上方 5 个那一坨拐过去（vy = " + on.vy.toFixed(1) + "）");

  const off = run(0);
  ok(!off.gone && Math.abs(off.vy) < 1, "guideR = 0 时保持直飞（vy = " + off.vy.toFixed(2) + "）");
}

console.log(fail === 0 ? "\n全部通过 ✅" : "\n有 " + fail + " 项失败 ❌");
process.exit(fail === 0 ? 0 : 1);