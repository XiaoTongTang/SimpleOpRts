/**
 * 散兵池自检
 *   node test/scatter.smoke.mjs
 *
 * 设计见 design/261107_2机制改进/战斗中小队，散兵，建造关系.md：
 *   1. 每个阵营有一个散兵池，收纳所有未编队舰船；它在战场上就是一支小队
 *   2. 解散小队 → 舰船退回池子，编制保留（可以再吸收回来）
 *   3. 生产线造好的船 → 进池子
 *   4. 吸收散兵 → 从池子里挑「同型号」的船补进编制
 *   5. 池子没有编制，所以按实际舰船计价
 */

import { GameCore } from "../src/core/core.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
                          : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));
const eq = (n, a, b) => ok(n, a === b, `期望 ${b}，实际 ${a}`);

const mk = () => new GameCore({ width: 1000, height: 700 });
const alive = (core, id) => core.units.filter(u => u.squad === id && u.hp > 0).length;

console.log("\n[1] 每个阵营一个池子");
{
  const core = mk();
  const p0 = core.poolOf(0);
  const p1 = core.poolOf(1);
  ok("两个池子是不同的小队", p0 >= 0 && p1 >= 0 && p0 !== p1, `${p0} / ${p1}`);
  eq("池子 0 是蓝方的", core.build.squads[p0].faction, 0);
  eq("池子 1 是红方的", core.build.squads[p1].faction, 1);
  ok("池子打了 loose 标记", core.build.squads[p0].loose === true);
  eq("开局有 6 艘未编队舰船", alive(core, p0), 6);
  eq("b.count 跟着实际舰数", core.build.squads[p0].count, 6);
}

console.log("\n[2] 解散 = 删除小队实例（数据上完全不存在）");
{
  const core = mk();
  const usedBefore = core.snapshot().commandUsed;
  const squadsBefore = core.build.squads.length;
  const poolBefore = alive(core, core.poolOf(0));

  core.command({ type: "setGoal", squadId: 0, x: 300, y: 300 });
  ok("解散前有命令信标", core.squads[0].goal !== null);

  const r = core.command({ type: "disband", squadId: 0 });
  ok("解散成功", r.ok === true && r.moved === 24, JSON.stringify(r));

  eq("编制表少了一支", core.build.squads.length, squadsBefore - 1);
  eq("运行时表同步缩短", core.squads.length, squadsBefore - 1);
  eq("24 艘进了池子", alive(core, core.poolOf(0)), poolBefore + 24);

  ok("A 队不存在了（id 0 现在是原来的 B 队）",
    core.build.squads[0].key === "B", core.build.squads[0].key);
  ok("快照里也找不到这支队", !core.snapshot().squads.some(s => s.key === "A"));
  ok("右栏会看到的小队里没有 alive=0 且无编制的幽灵",
    core.snapshot().squads.every(s => s.loose || s.count > 0));

  // 重编号之后两条不变量必须仍然成立
  let aligned = true;
  for (let i = 0; i < core.build.squads.length; i++) {
    if (core.build.squads[i].id !== i || core.squads[i].id !== i) aligned = false;
  }
  ok("两张表的 id 与下标仍然对齐", aligned);

  ok("没有船指向不存在的小队",
    core.units.every(u => u.squad >= 0 && u.squad < core.squads.length));

  eq("指挥值没变（船还在战场上）", core.snapshot().commandUsed, usedBefore);
}

console.log("\n[3] 解散之后：吸收作用在重编号后的队上，重建要靠一键建造");
{
  const core = mk();
  core.build.modules = 60;
  const squadsBefore = core.build.squads.length;

  core.command({ type: "disband", squadId: 0 });

  // id 0 现在是原来的 B 队，满编 → 吸收被拒
  const r = core.command({ type: "absorb", squadId: 0 });
  ok("解散后 id 0 指向下一支队（满编，拒绝吸收）", r.ok === false, JSON.stringify(r));

  // "再组建一支" = 全新实例，不是复活
  const built = core.command({ type: "buildFromTemplate", templateId: "squad.assault", faction: 0 });
  ok("一键建造成功", built.ok === true, JSON.stringify(built));
  eq("小队数回到解散前", core.build.squads.length, squadsBefore);
  const nb = core.build.squads[core.build.squads.length - 1];
  ok("新队是末尾的新实例", nb.id === squadsBefore - 1, String(nb.id));
  ok("新队有自己的 id 与下标", core.squads[nb.id].id === nb.id);
}

console.log("\n[4] 吸收只挑同型号，别型留在池子里");
{
  const core = mk();
  const p0 = core.poolOf(0);
  core.build.modules = 60;

  // A 队打掉 3 艘矛隼进池，同时造 2 艘堡垒级也进池
  let lost = 0;
  for (const u of core.units) {
    if (u.squad === 0 && lost < 3) { u.squad = p0; lost++; }
  }
  core.command({ type: "instantBuild", faction: 0, shipId: "ship.std_citadel", count: 2 });

  eq("池里 3 艘矛隼", core.poolCountOf(0, core.sigOf("ship.std_falcon")), 3);
  eq("池里 2 艘堡垒级", core.poolCountOf(0, core.sigOf("ship.std_citadel")), 2);
  eq("池子共 11 艘（6 支援 + 3 矛隼 + 2 堡垒）", alive(core, p0), 11);

  const r = core.command({ type: "absorb", squadId: 0 });
  ok("只吸收同型号的 3 艘", r.ok === true && r.moved === 3, JSON.stringify(r));
  eq("堡垒级还留在池里", core.poolCountOf(0, core.sigOf("ship.std_citadel")), 2);
  eq("池子剩 8 艘", alive(core, p0), 8);
}

console.log("\n[5] 池子本身不能被解散 / 不能被吸收");
{
  const core = mk();
  const p0 = core.poolOf(0);
  const d = core.command({ type: "disband", squadId: p0 });
  ok("解散池子被拒", d.ok === false, JSON.stringify(d));

  const a = core.command({ type: "absorb", squadId: p0 });
  ok("池子吸收自己被拒", a.ok === false, JSON.stringify(a));
}

console.log("\n[6] 吸收散兵要编制缺额，不能超编");
{
  const core = mk();
  const p0 = core.poolOf(0);
  core.build.modules = 60;
  core.command({ type: "instantBuild", faction: 0, shipId: "ship.std_falcon", count: 10 });

  // A 队满编 → 拒绝
  const full = core.command({ type: "absorb", squadId: 0 });
  ok("满编时被拒", full.ok === false && /满编/.test((full.reasons || []).join("")),
    JSON.stringify(full));

  // 打掉 3 艘 → 只吸收 3 艘
  let killed = 0;
  for (const u of core.units) {
    if (u.squad !== 0 || killed >= 3) continue;
    u.squad = p0; killed++;
  }
  const r = core.command({ type: "absorb", squadId: 0 });
  ok("补齐缺额", r.ok === true && r.moved === 3, JSON.stringify(r));
  eq("A 队 24", alive(core, 0), 24);
}

console.log("\n[7] 池子的指挥值按实际舰船算");
{
  const core = mk();
  const p0 = core.poolOf(0);
  const used0 = core.snapshot().commandUsed;

  core.build.modules = 60;
  core.command({ type: "instantBuild", faction: 0, shipId: "ship.std_citadel", count: 2 });
  // 堡垒级 22 指挥值 / 艘
  const used1 = core.snapshot().commandUsed;
  eq("造 2 艘堡垒级 +44 指挥值", used1 - used0, 44);

  core.command({ type: "disband", squadId: 0 });
  const snap = core.snapshot();
  const p1 = core.poolOf(0);                     // 解散后池子的 id 会变，必须重算
  const poolSnap = snap.squads.find(s => s.id === p1);
  ok("池子的 cost = Σ 每艘船的指挥值", poolSnap.cost > 6 * 4,
    `cost=${poolSnap.cost}`);
  eq("总指挥值不变", snap.commandUsed, used1);
}

console.log("\n[8] 池子里可以混装（战场上也能一起动）");
{
  const core = mk();
  const p0 = core.poolOf(0);
  core.build.modules = 60;
  core.command({ type: "instantBuild", faction: 0, shipId: "ship.std_citadel", count: 1 });

  const kinds = new Set();
  for (const u of core.units) if (u.squad === p0) kinds.add(u.maxHp);
  ok("池子里有多种血量的船", kinds.size >= 2, [...kinds].join(","));

  // 池子是普通小队：跑一段不会崩，也没有编制约束
  for (let i = 0; i < 60; i++) core.step(1 / 60);
  ok("池子在战场上有位置", core.squads[p0].cn > 0, String(core.squads[p0].cn));
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
