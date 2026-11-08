/**
 * 多武器齐射自检
 *   node test/weapons.smoke.mjs
 *
 * 验的是「每个武器槽位是一套独立状态」：
 *   装两门炮 = 两条独立冷却，不是共用一套节奏。
 * 同时守一条底线：只有一门炮时，行为必须和单武器时代完全一致。
 */

import { stepWeapons, WEAPONS } from "../src/core/sim/weapon-system.js";
import { buildWeaponStates, applyCombatParams } from "../src/core/sim/defense-system.js";
import { seedRng } from "../src/core/sim/rng.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
                          : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));
const eq = (n, a, b) => ok(n, a === b, `期望 ${b}，实际 ${a}`);
const near = (n, a, b) => ok(n, Math.abs(a - b) < 1e-6, `期望 ${b}，实际 ${a}`);

/** 造一个最小战场：一个射手 + 一个打不死的靶子 */
function mk(weaponIds, opts = {}) {
  seedRng(1);
  const squads = [
    { id: 0, faction: 0, hue: 200, p: {} },
    { id: 1, faction: 1, hue: 0, p: {} }
  ];
  const hero = {
    squad: 0, x: 0, y: 0, vx: 0, vy: 0,
    hp: 100, maxHp: 100, hitR: 5,
    fireRate: opts.fireRate ?? 1,
    weapons: weaponIds.map((id, i) => ({
      slot: i, id, cd: 0, burstLeft: 0, burstTimer: 0, target: null
    }))
  };
  const foe = {
    squad: 1, x: opts.foeX ?? 50, y: 0, vx: 0, vy: 0,
    hp: 1e9, maxHp: 1e9, hitR: 5, weapons: []
  };
  return { units: [hero, foe], squads, hero, foe, proj: [] };
}

function tick(w, dt = 1 / 60) {
  const hits = [];
  stepWeapons(w.units, w.squads, w.proj, dt, hits, 0, null, null);
  return { hits, proj: w.proj };
}

console.log("\n[1] 槽位状态构造");
{
  const one = buildWeaponStates({ weapon: "laser" });
  eq("单武器 → 1 个槽", one.length, 1);
  eq("id 正确", one[0].id, "laser");
  ok("每个槽有自己的 cd", typeof one[0].cd === "number");

  const many = buildWeaponStates({ weapons: ["laser", "railgun", "missile"], weapon: "laser" });
  eq("多武器 → 3 个槽", many.length, 3);
  eq("槽序号递增", many.map(s => s.slot).join(","), "0,1,2");
  ok("各自独立的对象", many[0] !== many[1]);
}

console.log("\n[2] 一门炮 vs 两门炮");
{
  const w1 = mk(["laser"]);
  const r1 = tick(w1);
  eq("单门：第一帧 1 次命中", r1.hits.length, 1);

  const w2 = mk(["laser", "laser"]);
  const r2 = tick(w2);
  eq("双门：第一帧 2 次命中", r2.hits.length, 2);
}

console.log("\n[3] 冷却互相独立");
{
  const w = mk(["laser", "laser"]);
  tick(w);                                   // 两门都开火，都进 2.0s 冷却
  const cd0 = w.hero.weapons[0].cd;
  ok("打完进冷却 2.0", Math.abs(cd0 - 2.0) < 1e-9, String(cd0));

  w.hero.weapons[0].cd = 0;                  // 只把第一门清冷却
  const r = tick(w);
  eq("只有第一门再开火", r.hits.length, 1);
  ok("第二门还在冷却", w.hero.weapons[1].cd > 1.9, String(w.hero.weapons[1].cd));
}

console.log("\n[4] 不同武器各打各的");
{
  // 激光射程 300，导弹射程 480，靶子在 400
  const w = mk(["laser", "missile"], { foeX: 400 });
  const r = tick(w);
  eq("激光够不到 → 0 次命中", r.hits.length, 0);
  eq("导弹打出去了 → 1 发弹丸", r.proj.length, 1);
  ok("只用了导弹槽的冷却",
    Math.abs(w.hero.weapons[1].cd - 2.6) < 1e-9, String(w.hero.weapons[1].cd));
  ok("激光槽还在等（冷却没被推进到负数之外）", w.hero.weapons[0].cd <= 0,
    String(w.hero.weapons[0].cd));
}

console.log("\n[5] fireRate 乘数");
{
  const w = mk(["laser"], { fireRate: 0.5 });
  tick(w);
  eq("冷却 2.0×0.5", w.hero.weapons[0].cd, 1.0);
}

console.log("\n[6] 连发武器按槽位自己的节奏");
{
  const w = mk(["chaingun"]);
  let hits = 0;
  for (let i = 0; i < 30; i++) hits += tick(w).hits.length;   // 0.5 秒
  eq("0.5 秒内 4 发全中", hits, 4);
}

console.log("\n[7] 单武器时与旧字段行为一致");
{
  seedRng(1);
  const legacy = buildWeaponStates({ weapon: "laser" });        // 旧字段
  seedRng(1);
  const modern = buildWeaponStates({ weapons: ["laser"] });     // 新字段
  eq("同样 1 个槽", legacy.length, modern.length);
  eq("同样的初始冷却（随机序列没被打乱）", legacy[0].cd, modern[0].cd);
  eq("同样的武器", legacy[0].id, modern[0].id);
}

console.log("\n[8] 改装配会重建槽位，但保留冷却");
{
  const w = mk(["laser", "laser"]);
  tick(w);
  const cd0 = w.hero.weapons[0].cd;

  const sq = { p: { hp: 100, regen: 0, weapon: "laser", weapons: ["laser"] } };
  applyCombatParams([w.hero], [sq], 0);

  eq("槽位减少到 1", w.hero.weapons.length, 1);
  ok("第一个槽的冷却保留", Math.abs(w.hero.weapons[0].cd - cd0) < 1e-9,
    `${w.hero.weapons[0].cd} vs ${cd0}`);
  eq("兼容别名同步", w.hero.weapon, "laser");
}

console.log("\n[9] 炮口位置");
{
  // 局部 [+x 前, +y 左]；注意这一帧弹丸自己也飞了一点（240/60 = 4px），
  // 所以只看"是否偏到了炮口那一侧"，不比对精确坐标。
  const w = mk(["missile"]);
  w.hero.vx = 100; w.hero.vy = 0;                 // 朝 +x
  w.hero.weapons[0].pos = [10, 0];
  tick(w);
  ok("朝 +x 时炮口在前方",
    w.proj[0].x > 8 && Math.abs(w.proj[0].y) < 1,
    `${w.proj[0].x},${w.proj[0].y}`);

  // 同一个"前方"炮口，船朝 +y 飞时应当转到上方
  const w2 = mk(["missile"]);
  w2.hero.vx = 0; w2.hero.vy = 100;
  w2.hero.weapons[0].pos = [10, 0];
  tick(w2);
  ok("朝 +y 时同一个炮口转到上方",
    w2.proj[0].y > 8 && Math.abs(w2.proj[0].x) < 5,
    `${w2.proj[0].x},${w2.proj[0].y}`);

  // 没有 pos 就从船心出
  const w3 = mk(["missile"]);
  tick(w3);
  ok("没有 pos 从船心出",
    Math.hypot(w3.proj[0].x, w3.proj[0].y) < 8,
    `${w3.proj[0].x},${w3.proj[0].y}`);
}

console.log("\n[10] 槽位状态构造带炮口位置");
{
  const st = buildWeaponStates({
    weapons: ["laser", "missile"],
    weaponSlots: [{ id: "w1", pos: [-5, -7] }, { id: "w2", pos: [5, 7] }]
  });
  eq("第一个槽的位置", st[0].pos.join(","), "-5,-7");
  eq("第二个槽的位置", st[1].pos.join(","), "5,7");
}

console.log("\n[11] 空/坏数据不崩");
{
  const w = mk(["nope"]);
  const r = tick(w);
  eq("未知武器不开火", r.hits.length + r.proj.length, 0);

  const w2 = mk([]);
  w2.hero.weapons = [];
  tick(w2);
  ok("没有槽位也能跑", true);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
