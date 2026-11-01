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

console.log(fail === 0 ? "\n全部通过 ✅" : "\n有 " + fail + " 项失败 ❌");
process.exit(fail === 0 ? 0 : 1);