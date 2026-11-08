/**
 * 生产队列自检
 *   node test/production.smoke.mjs
 *
 * 只调 stepProduction，不调 core.step —— 免得战斗噪音干扰计数。
 *
 * 核心那条换算：效率单位是「工时/分钟」。
 *   一条线分到 10 点 → 每秒 10/60 工时
 *   一艘 10 工时的船 → 10 / (10/60) = 60 秒
 */

import { GameCore } from "../src/core/core.js";
import { allocatedEff, queuedCount } from "../src/core/sim/production.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
                          : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));
const eq = (n, a, b) => ok(n, a === b, `期望 ${b}，实际 ${a}`);
const near = (n, a, b, tol = 1e-6) => ok(n, Math.abs(a - b) <= tol, `期望 ${b}，实际 ${a}`);

const mk = () => new GameCore({ width: 1000, height: 700 });
const alive = (core, id) => core.units.filter(u => u.squad === id && u.hp > 0).length;
const advance = (core, seconds, dt = 1 / 60) => {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) core.stepProduction(dt);
};

console.log("\n[1] 初始产能");
{
  const core = mk();
  eq("两个阵营各一个设施", core.production.length, 2);
  eq("每条阵营 3 条线", core.production[0].lines.length, 3);
  eq("效率总和 30", core.production[0].efficiencyTotal, 30);
  eq("平均分配 10/10/10", core.production[0].lines.map(l => l.alloc).join("/"), "10/10/10");
  eq("已分配 30", allocatedEff(core.production[0]), 30);
  eq("初始没有排队", queuedCount(core.production[0]), 0);
  eq("模组上限 60", core.moduleCap, 60);
}

console.log("\n[2] 效率分配");
{
  const core = mk();
  // 先压低另外两条线，再把第一条抬上去 —— 效率总和是硬上限，顺序不能反
  const r2 = core.command({ type: "setLineEfficiency", faction: 0, line: 1, value: 5 });
  const r3 = core.command({ type: "setLineEfficiency", faction: 0, line: 2, value: 5 });
  const r1 = core.command({ type: "setLineEfficiency", faction: 0, line: 0, value: 20 });
  ok("20/5/5 都能设", r1.ok && r2.ok && r3.ok, JSON.stringify([r1, r2, r3]));
  eq("分配结果", core.production[0].lines.map(l => l.alloc).join("/"), "20/5/5");
  eq("总和仍是 30", allocatedEff(core.production[0]), 30);

  const over = core.command({ type: "setLineEfficiency", faction: 0, line: 0, value: 25 });
  ok("超总和被拒", over.ok === false, JSON.stringify(over));
  ok("理由给出具体数字", /超出生产效率总和/.test((over.reasons || []).join("")),
    JSON.stringify(over.reasons));
  eq("被拒后没变", core.production[0].lines[0].alloc, 20);

  const neg = core.command({ type: "setLineEfficiency", faction: 0, line: 0, value: -1 });
  ok("负数被拒", neg.ok === false);
}

console.log("\n[3] 工时 → 秒（设计文档里那个例子）");
{
  const core = mk();
  core.units.splice(core.units.findIndex(u => u.squad === 0), 1);   // 缺 1 艘
  eq("现在少一艘", alive(core, 0), 23);

  const ship = core.ships[core.build.squads[0].ship];
  const bt = ship.derived.buildTime;
  const q = core.command({ type: "queueShip", squadId: 0, count: 1 });
  ok("排队成功", q.ok === true, JSON.stringify(q));

  const line = core.production[0].lines.find(l => l.queue.length > 0);
  eq("排到了一条线", !!line, true);
  const seconds = bt / (line.alloc / 60);
  console.log(`      工时 ${bt}s ÷ 效率 ${line.alloc}/分钟 = ${seconds.toFixed(1)}s`);

  advance(core, seconds - 2);
  eq("差 2 秒时还没造好", alive(core, 0), 23);

  advance(core, 3);
  eq("到点后补上 1 艘", alive(core, 0), 24);
  eq("队列清空", queuedCount(core.production[0]), 0);
}

console.log("\n[4] 三条线并行，总速率等于效率总和");
{
  const core = mk();
  for (const id of [0]) for (let i = 0; i < 3; i++) core.units.splice(core.units.findIndex(u => u.squad === id), 1);
  // 让 3 条线各排 1 艘
  core.production[0].lines.forEach(l => l.queue.length = 0);
  core.jobSeq = 1;
  core.command({ type: "queueShip", squadId: 0, count: 3 });
  eq("三条线各 1 艘", core.production[0].lines.map(l => l.queue.length).join("/"), "1/1/1");

  core.command({ type: "setLineEfficiency", faction: 0, line: 1, value: 5 });
  core.command({ type: "setLineEfficiency", faction: 0, line: 2, value: 5 });
  core.command({ type: "setLineEfficiency", faction: 0, line: 0, value: 20 });

  const before = core.production[0].lines.map(l => l.queue[0].progress);
  core.stepProduction(1);
  const after = core.production[0].lines.map(l => l.queue[0].progress);

  near("20 效率那条每秒 20/60 工时", after[0] - before[0], 20 / 60);
  near("5 效率那条每秒 5/60 工时", after[1] - before[1], 5 / 60);
  const total = after.reduce((s, v, i) => s + v - before[i], 0);
  near("三条加起来等于 30/60", total, 30 / 60);
}

console.log("\n[5] 取消订单不吞资源");
{
  const core = mk();
  core.units.splice(core.units.findIndex(u => u.squad === 0), 1);
  const modsBefore = core.build.modules;
  core.command({ type: "queueShip", squadId: 0, count: 1 });
  eq("排队不扣模组", core.build.modules, modsBefore);

  const jobId = core.production[0].lines.find(l => l.queue.length).queue[0].id;
  const c = core.command({ type: "cancelOrder", jobId });
  ok("取消成功", c.ok === true, JSON.stringify(c));
  eq("队列空了", queuedCount(core.production[0]), 0);
  eq("模组没变", core.build.modules, modsBefore);

  const again = core.command({ type: "cancelOrder", jobId });
  ok("重复取消被拒", again.ok === false);
}

console.log("\n[6] 预制模组瞬建");
{
  const core = mk();
  core.units.splice(core.units.findIndex(u => u.squad === 0), 1);
  const before = core.build.modules;
  const r = core.command({ type: "instantRefill", squadId: 0, count: 1 });
  ok("瞬建成功", r.ok === true, JSON.stringify(r));
  eq("立刻补上", alive(core, 0), 24);
  near("扣 1 个模组", core.build.modules, before - 1);

  const full = core.command({ type: "instantRefill", squadId: 0, count: 1 });
  ok("满编后瞬建被拒", full.ok === false, JSON.stringify(full));

  core.units.splice(core.units.findIndex(u => u.squad === 0), 1);
  core.build.modules = 0;
  const poor = core.command({ type: "instantRefill", squadId: 0, count: 1 });
  ok("模组不够被拒", poor.ok === false);
  ok("理由提到模组", /预制模组不足/.test((poor.reasons || []).join("")));
}

console.log("\n[7] 一键补满 / 满编拒绝");
{
  const core = mk();
  for (let i = 0; i < 5; i++) core.units.splice(core.units.findIndex(u => u.squad === 0), 1);
  eq("缺 5 艘", alive(core, 0), 19);

  const r = core.command({ type: "buildSquad", squadId: 0 });
  ok("一键补充成功", r.ok === true, JSON.stringify(r));
  eq("排了 5 艘", queuedCount(core.production[0]), 5);

  const again = core.command({ type: "buildSquad", squadId: 0 });
  ok("重复按被拒", again.ok === false, JSON.stringify(again));
  ok("理由是已经在补", /已经在补/.test((again.reasons || []).join("")),
    JSON.stringify(again.reasons));
}

console.log("\n[8] 单队上限");
{
  const core = mk();
  const tooMany = core.command({ type: "queueShip", squadId: 0, count: 48 });
  ok("超出单队上限被拒", tooMany.ok === false, JSON.stringify(tooMany));
  ok("理由给出算式", /超出单队上限/.test((tooMany.reasons || []).join("")));
}

console.log("\n[9] 预制模组自然恢复");
{
  const core = mk();
  core.build.modules = 0;
  advance(core, 10);
  near("10 秒恢复 6 个", core.build.modules, 6, 1e-6);

  core.build.modules = 59;
  advance(core, 10);
  near("封顶在 60", core.build.modules, 60);
}

console.log("\n[10] 造出来的船参数正确");
{
  const core = mk();
  core.units.splice(core.units.findIndex(u => u.squad === 0), 1);
  core.command({ type: "queueShip", squadId: 0, count: 1 });
  advance(core, 200);

  const u = core.units.find(x => x.squad === 0);
  eq("血量来自船体模板", u.maxHp, 60);
  eq("武器槽按装配", u.weapons.length, 2);
  eq("受击半径", u.hitR, 6);
  ok("有独立冷却", typeof u.weapons[0].cd === "number");
}

console.log("\n[11] 订单跟着小队走");
{
  const core = mk();
  core.units.splice(core.units.findIndex(u => u.squad === 0), 1);
  core.command({ type: "queueShip", squadId: 0, count: 2 });
  eq("记在自己名下", core.queuedForSquad(0), 2);
  eq("别的队是 0", core.queuedForSquad(1), 0);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
