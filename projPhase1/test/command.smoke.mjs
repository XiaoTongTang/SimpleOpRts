/**
 * 战斗界面的三条命令 + 阵营统计
 *   node test/command.smoke.mjs
 *
 * 界面（ui.js）只发命令，所以这里验的是界面依赖的那几个核心行为：
 *   1. 命令信标：setGoal / clearGoal（每队一个点，散兵池也能下）
 *   2. 一键建造：按编制模板造一支新小队（扣模组、占指挥值、进战场）
 *   3. 阵营统计：snapshot.factions（界面左上角的阵营切换要用）
 */

import { GameCore } from "../src/core/core.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
                          : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));
const eq = (n, a, b) => ok(n, a === b, `期望 ${b}，实际 ${a}`);

const mk = () => new GameCore({ width: 1200, height: 700 });
const alive = (core, id) => core.units.filter(u => u.squad === id).length;

console.log("\n[1] 命令信标");
{
  const core = mk();
  eq("开局没有信标", core.snapshot().squads[0].goal, null);

  const r = core.command({ type: "setGoal", squadIds: [0, 1], x: 400, y: 300 });
  ok("下达成功", r.ok === true && r.squads === 2, JSON.stringify(r));

  const s = core.snapshot();
  eq("A 队有信标", JSON.stringify(s.squads[0].goal), '{"x":400,"y":300}');
  eq("B 队也有", JSON.stringify(s.squads[1].goal), '{"x":400,"y":300}');
  eq("C 队没有", s.squads[2].goal, null);

  // sim 真的会朝信标走：跑 2 秒，离信标更近
  const d0 = Math.hypot(s.squads[0].x - 400, s.squads[0].y - 300);
  for (let i = 0; i < 120; i++) core.step(1 / 60);
  const d1 = Math.hypot(core.snapshot().squads[0].x - 400, core.snapshot().squads[0].y - 300);
  ok("向信标靠近", d1 < d0, `${d0.toFixed(0)} → ${d1.toFixed(0)}`);

  const c = core.command({ type: "clearGoal", squadIds: [0] });
  ok("取消成功", c.ok === true && c.cleared === 1, JSON.stringify(c));
  eq("A 队没了", core.snapshot().squads[0].goal, null);
  eq("B 队还在", !!core.snapshot().squads[1].goal, true);

  const all = core.command({ type: "clearGoal" });
  ok("不给 id 就全清", all.ok === true && all.cleared === 1, JSON.stringify(all));
}

console.log("\n[2] 散兵池也能领命令信标");
{
  const core = mk();
  const poolId = core.poolOf(0);
  const r = core.command({ type: "setGoal", squadId: poolId, x: 200, y: 200 });
  ok("池子能下命令", r.ok === true, JSON.stringify(r));
  eq("快照里能看到", !!core.snapshot().squads.find(s => s.id === poolId).goal, true);
}

console.log("\n[3] 一键建造一支小队");
{
  const core = mk();
  const before = core.build.modules;
  const n0 = core.build.squads.length;

  const r = core.command({ type: "buildFromTemplate", templateId: "squad.assault", faction: 0 });
  ok("建造成功", r.ok === true, JSON.stringify(r));
  eq("新小队 id", r.squadId, n0);
  eq("造了 24 艘", r.built, 24);
  eq("小队数 +1", core.build.squads.length, n0 + 1);
  eq("变成 24 艘", alive(core, r.squadId), 24);
  eq("扣了 24 个模组", core.build.modules, before - 24);

  const s = core.snapshot().squads.find(x => x.id === r.squadId);
  eq("名字用了模板名（重名自动编号）", s.name, "突击队 2");
  eq("编制 24", s.count, 24);
  eq("阵型是模板默认", s.form, "form.standard");
  eq("引用了模板", s.template, "squad.assault");

  // 再次建造：名字继续编号
  core.build.modules = 100;
  const r2 = core.command({ type: "buildFromTemplate", templateId: "squad.assault", faction: 0 });
  eq("第二支编号 3", core.snapshot().squads.find(x => x.id === r2.squadId).name, "突击队 3");
}

console.log("\n[4] 一键建造的拒绝条件");
{
  const core = mk();

  const noMods = core.command({ type: "buildFromTemplate", templateId: "squad.wall", faction: 0 });
  core.build.modules = 5;
  const lack = core.command({ type: "buildFromTemplate", templateId: "squad.wall", faction: 0 });
  ok("模组不够被拒", lack.ok === false, JSON.stringify(lack));
  ok("理由提到模组", /预制模组不足/.test((lack.reasons || []).join("")));

  core.build.modules = 999;
  const bad = core.command({ type: "buildFromTemplate", templateId: "squad.nope", faction: 0 });
  ok("未知模板被拒", bad.ok === false);

  // 指挥值上限：一次造一堆，直到超
  let rejected = false;
  for (let i = 0; i < 20; i++) {
    const r = core.command({ type: "buildFromTemplate", templateId: "squad.wall", faction: 0 });
    if (!r.ok && (r.reasons || []).some(t => t.includes("指挥值"))) { rejected = true; break; }
  }
  ok("超指挥值被拒", rejected);
}

console.log("\n[5] 阵营统计");
{
  const core = mk();
  const s = core.snapshot();
  eq("两个阵营", s.factions.length, 2);
  eq("蓝方 4 队正规 + 1 个池子", s.factions[0].squads, 5);
  eq("蓝方指挥值 408（4×96 + 池子 24）", s.factions[0].commandUsed, 408);
  eq("红方对称", s.factions[1].commandUsed, 408);
  ok("蓝方有船", s.factions[0].ships > 0, String(s.factions[0].ships));
  eq("双方舰数相加等于总数", s.factions[0].ships + s.factions[1].ships, s.unitCount);

  // 造一支小队后，蓝方指挥值和舰数都涨
  core.command({ type: "buildFromTemplate", templateId: "squad.assault", faction: 0 });
  const s2 = core.snapshot();
  eq("蓝方指挥值 +96", s2.factions[0].commandUsed, 504);
  eq("蓝方舰队 +24", s2.factions[0].ships, s.factions[0].ships + 24);
  eq("红方不变", s2.factions[1].commandUsed, 408);
}

console.log("\n[6] 换船体（舰船设计界面用）");
{
  const core = mk();
  // 新建一条空方案（没在役），换船体应该成功且装配清空
  const r = core.command({ type: "createShip", hull: "hull.falcon", name: "试验舰" });
  const id = r.id;
  core.command({ type: "setShipFit", shipId: id, slotId: "w1", itemId: "missile" });
  eq("装了一枚导弹", core.ships[id].fit.w1, "missile");

  const okHull = core.command({ type: "setShipHull", shipId: id, hull: "hull.hammer" });
  ok("换船体成功", okHull.ok === true, JSON.stringify(okHull));
  eq("船体变了", core.ships[id].hull, "hull.hammer");
  eq("装配被清空（槽位不一样了）", core.ships[id].fit.w1, null);
  eq("槽位跟着新船体", Object.keys(core.ships[id].fit).join(","), "w1,w2,w3,p1,p2,p3");

  // 在役的方案不许换船体
  const locked = core.command({ type: "setShipHull", shipId: "ship.std_falcon", hull: "hull.citadel" });
  ok("在役方案被拒", locked.ok === false, JSON.stringify(locked));
  ok("理由说明在役", /在役/.test((locked.reasons || []).join("")), JSON.stringify(locked.reasons));
}

console.log("\n[7] 编制模板的新建 / 删除");
{
  const core = mk();
  const before = Object.keys(core.squadTemplates).length;

  const r = core.command({
    type: "createSquadTemplate", name: "混合试验",
    entries: [{ ship: "ship.std_falcon", n: 6 }, { ship: "ship.std_hammer", n: 2 }],
    formations: ["form.guerrilla", "form.standard"]
  });
  ok("新建成功", r.ok === true, JSON.stringify(r));
  eq("模板数 +1", Object.keys(core.squadTemplates).length, before + 1);
  const tpl = core.squadTemplates[r.id];
  eq("编制条目", tpl.entries.length, 2);
  eq("默认阵型是第一个", tpl.formations[0], "form.guerrilla");

  const delUsed = core.command({ type: "deleteSquadTemplate", templateId: "squad.assault" });
  ok("在用的模板不能删", delUsed.ok === false, JSON.stringify(delUsed));

  const del = core.command({ type: "deleteSquadTemplate", templateId: r.id });
  ok("没人用的可以删", del.ok === true, JSON.stringify(del));
  eq("模板数回到原样", Object.keys(core.squadTemplates).length, before);
}

console.log("\n[8] 界面要用的展示数据");
{
  const core = mk();
  const cat = core.query({ type: "catalog" });

  const hull = cat.hulls.find(h => h.id === "hull.falcon");
  ok("船体带血量/承载/槽位", hull.armor.hp > 0 && hull.capacity > 0 && hull.slots.weapon.length > 0,
    JSON.stringify(hull.armor));

  const laser = cat.weapons.find(w => w.id === "laser");
  ok("武器带伤害/冷却/射程/DPS",
    laser.dmg > 0 && laser.cd > 0 && laser.range > 0 && laser.dps > 0,
    JSON.stringify(laser));

  const cap = cat.plugins.find(p => p.id === "plugin.capacitor");
  ok("插件带 mods / 说明", cap.mods.capacity > 0 && !!cap.desc, JSON.stringify(cap.mods));
  const charger = cat.plugins.find(p => p.id === "plugin.charger_s");
  ok("支援插件的 abilities 有名字", charger.abilities.length > 0 && !!charger.abilities[0].name,
    JSON.stringify(charger.abilities));

  const ship = core.snapshot().shipList[0];
  ok("方案带 armor 与 dps", ship.armor && ship.armor.hp > 0 && ship.dps > 0,
    JSON.stringify({ hp: ship.armor?.hp, dps: ship.dps }));

  const tpl = core.snapshot().templates.find(t => t.id === "squad.assault");
  eq("编制统计：24 艘", tpl.stats.ships, 24);
  eq("编制统计：总血量 24×60", tpl.stats.hp, 1440);
  eq("编制统计：人口 96", tpl.stats.command, 96);
  ok("编制统计：总 DPS > 0", tpl.stats.dps > 0, String(tpl.stats.dps));
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
