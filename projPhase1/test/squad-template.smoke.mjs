/**
 * 小队编制模板自检
 *   node test/squad-template.smoke.mjs
 *
 * 设计见 design/261107_2机制改进/战斗中小队，散兵，建造关系.md：
 *   1. 小队可以引用一个编制模板：模板说「有哪些船」+「能用哪些阵型」
 *   2. 改模板 = 追溯改所有引用它的小队：不符合编制的舰船剔除回散兵池，
 *      阵型重置成模板默认（formations[0]）
 *   3. 缺口不自动补：要船就按「吸收散兵」去池子里拿
 *   4. 脱离模板（改这支队的编制）= 无编制小队：不受模板影响，但失去吸收能力
 */

import { GameCore } from "../src/core/core.js";
import { SQUAD_TEMPLATES } from "../src/core/data/squad-templates.js";
import { unitSignature } from "../src/core/sim/defense-system.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
                          : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));
const eq = (n, a, b) => ok(n, a === b, `期望 ${b}，实际 ${a}`);

const mk = () => new GameCore({ width: 1000, height: 700 });
const alive = (core, id) => core.units.filter(u => u.squad === id).length;
const countType = (core, id, shipId) => {
  const sig = core.sigOf(shipId);
  let n = 0;
  for (const u of core.units) if (u.squad === id && unitSignature(u) === sig) n++;
  return n;
};
const poolAlive = core => alive(core, core.poolOf(0));
const entriesOf = (core, id) => core.build.squads[id].entries
  .map(e => `${e.ship}:${e.n}`).join(",");

console.log("\n[1] 开局：4 个编制模板，8 支队各自引用");
{
  const core = mk();
  eq("模板数量", Object.keys(SQUAD_TEMPLATES).length, 4);

  const b0 = core.build.squads[0];
  eq("A 队引用突击队", b0.template, "squad.assault");
  eq("A 队编制 24 矛隼", entriesOf(core, 0), "ship.std_falcon:24");
  eq("A 队阵型是模板默认", b0.form, "form.standard");
  eq("A 队场上 24 艘", alive(core, 0), 24);

  const b1 = core.build.squads[1];
  eq("B 队是混编（盾墙队）", entriesOf(core, 1),
    "ship.std_falcon:12,ship.std_bulwark:8");
  eq("B 队场上 20 艘", alive(core, 1), 20);
  eq("B 队阵型是密集", b1.form, "form.dense");

  eq("初始指挥值 816", core.snapshot().commandUsed, 816);
}

console.log("\n[2] 改模板：多出来的船剔除回散兵池");
{
  const core = mk();
  const poolBefore = poolAlive(core);

  // 突击队 24 → 20（A 和 E 都引用它，两个阵营各一支）
  const r = core.command({
    type: "editSquadTemplate", templateId: "squad.assault",
    entries: [{ ship: "ship.std_falcon", n: 20 }]
  });
  ok("改模板成功", r.ok === true, JSON.stringify(r));
  eq("影响到 2 支小队", r.touched, 2);
  eq("共剔除 8 艘", r.ejected, 8);

  eq("A 队剩 20 艘", alive(core, 0), 20);
  eq("E 队也剩 20 艘", alive(core, 4), 20);
  eq("池子各多 4 艘", poolAlive(core), poolBefore + 4);
  eq("编制已变", entriesOf(core, 0), "ship.std_falcon:20");
  // 剔除只是"退编"，船还在战场上：指挥值不归还（编制少了 16，池子里多了 16）
  eq("指挥值不变（船还在）", core.snapshot().commandUsed, 816);
}

console.log("\n[3] 改模板：加船不会凭空变出来，缺口等吸收");
{
  const core = mk();
  const r = core.command({
    type: "editSquadTemplate", templateId: "squad.assault",
    entries: [{ ship: "ship.std_falcon", n: 30 }]
  });
  ok("改模板成功", r.ok === true, JSON.stringify(r));
  eq("没有船被剔除", r.ejected, 0);
  eq("编制涨到 30", entriesOf(core, 0), "ship.std_falcon:30");
  eq("场上还是 24 艘", alive(core, 0), 24);
  eq("指挥值按 30 算（816 + 24×2）", core.snapshot().commandUsed, 864);

  // 池子里原本只有 6 艘支援舰，先造 6 艘矛隼进池子
  core.command({ type: "instantBuild", faction: 0, shipId: "ship.std_falcon", count: 6 });
  const ab = core.command({ type: "absorb", squadId: 0 });
  ok("吸收补上 6 艘", ab.ok === true && ab.moved === 6, JSON.stringify(ab));
  eq("A 队 30 艘", alive(core, 0), 30);
}

console.log("\n[4] 改模板：把某型号从编制里删掉 → 那型全部剔除");
{
  const core = mk();
  // 盾墙队 12 矛隼 + 8 壁垒 → 只留 12 矛隼
  const r = core.command({
    type: "editSquadTemplate", templateId: "squad.wall",
    entries: [{ ship: "ship.std_falcon", n: 12 }]
  });
  ok("改模板成功", r.ok === true, JSON.stringify(r));
  eq("B 队编制只剩矛隼", entriesOf(core, 1), "ship.std_falcon:12");
  eq("B 队只剩 12 艘", alive(core, 1), 12);
  eq("壁垒全部回池", core.poolCountOf(0, core.sigOf("ship.std_bulwark")) >= 8, true);
}

console.log("\n[5] 改模板：阵型重置成模板默认");
{
  const core = mk();
  const sw = core.command({ type: "setFormation", squadId: 1, form: "form.standard" });
  ok("先把 B 队切到标准阵型", sw.ok === true, JSON.stringify(sw));
  eq("当前阵型", core.build.squads[1].form, "form.standard");

  core.command({
    type: "editSquadTemplate", templateId: "squad.wall",
    entries: [{ ship: "ship.std_falcon", n: 12 }, { ship: "ship.std_bulwark", n: 8 }]
  });
  eq("改模板后阵型回到默认（密集）", core.build.squads[1].form, "form.dense");
  eq("sq.p 真的被改了", core.squads[1].p.rRep, 35);
}

console.log("\n[6] 脱离模板 = 无编制小队：不受模板影响，也不能吸收");
{
  const core = mk();
  const r = core.command({ type: "setLoadout", squadId: 0, count: 20 });
  ok("改这支队的编制成功", r.ok === true, JSON.stringify(r));
  eq("模板引用被摘掉", core.build.squads[0].template, null);

  // 改模板不再影响它
  core.command({
    type: "editSquadTemplate", templateId: "squad.assault",
    entries: [{ ship: "ship.std_falcon", n: 10 }]
  });
  eq("A 队编制还是 20", entriesOf(core, 0), "ship.std_falcon:20");
  eq("E 队被模板改了", entriesOf(core, 4), "ship.std_falcon:10");

  const ab = core.command({ type: "absorb", squadId: 0 });
  ok("无编制小队不能吸收", ab.ok === false, JSON.stringify(ab));
  ok("理由说明没有编制", /无编制/.test((ab.reasons || []).join("")), JSON.stringify(ab.reasons));
}

console.log("\n[7] 混编队的吸收按型号分别补");
{
  const core = mk();
  // 从 B 队各踢几艘到池子
  const poolId = core.poolOf(0);
  let moved = 0;
  for (const u of core.units) {
    if (u.squad !== 1 || moved >= 5) continue;
    u.squad = poolId; moved++;
  }
  core.syncPoolCount(poolId);
  eq("B 队剩 15 艘", alive(core, 1), 15);

  const r = core.command({ type: "absorb", squadId: 1 });
  ok("吸收成功", r.ok === true && r.moved === 5, JSON.stringify(r));
  eq("B 队回到 20 艘", alive(core, 1), 20);
  eq("矛隼补到 12", countType(core, 1, "ship.std_falcon"), 12);
  eq("壁垒补到 8", countType(core, 1, "ship.std_bulwark"), 8);
}

console.log("\n[8] 阵型只能在编制解锁的范围里切");
{
  const core = mk();
  const bad = core.command({ type: "setFormation", squadId: 0, form: "form.guerrilla" });
  ok("没解锁的阵型被拒", bad.ok === false, JSON.stringify(bad));
  eq("阵型没变", core.build.squads[0].form, "form.standard");

  const good = core.command({ type: "setFormation", squadId: 0, form: "form.wide" });
  ok("解锁的阵型可以切", good.ok === true, JSON.stringify(good));
  eq("sq.p.rAtt 跟着换（大间距=200）", core.squads[0].p.rAtt, 200);
}

console.log("\n[9] 改模板超指挥值会被拒");
{
  const core = mk();
  const r = core.command({
    type: "editSquadTemplate", templateId: "squad.assault",
    entries: [{ ship: "ship.std_falcon", n: 48 }]
  });
  ok("超指挥值被拒", r.ok === false, JSON.stringify(r));
  ok("理由说明超指挥值", /指挥值/.test((r.reasons || []).join("")), JSON.stringify(r.reasons));
  eq("模板没被改", core.squadTemplates["squad.assault"].entries[0].n, 24);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
