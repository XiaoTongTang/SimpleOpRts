/**
 * core 冒烟测试（无浏览器、无 UI）
 * -----------------------------------------------------------------
 * 这条测试存在的意义：证明「core 先于 React 存在」这条纪律是真的，
 * 不是写在文档里的口号。用 node 直接跑：
 *
 *   node test/core.smoke.mjs
 */

import { GameCore } from "../src/core/core.js";
import { createBuild, commandsUsed, entryCost } from "../src/core/state.js";
import { createLibrary } from "../src/core/data/ship-library.js";

let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    console.log("  ✓ " + name);
  } else {
    failed++;
    console.log("  ✗ " + name + (extra ? "  → " + extra : ""));
  }
}

console.log("build state（小队引用舰船模板）");
{
  const ships = createLibrary();
  const b = createBuild();

  check("10 支小队", b.squads.length === 10, String(b.squads.length));
  check("每条小队都有 ship 字段", b.squads.every(s => typeof s.ship === "string"));
  check("引用的方案都存在", b.squads.every(s => !!ships[s.ship]));
  check("不再有 hull/count 之外的旧字段", b.squads.every(s => s.hull === undefined));

  const used = commandsUsed(b, ships);
  check("初始指挥值 = 816", used === 816, String(used));
  check("初始编制不超指挥值", used <= b.commandCap, used + " / " + b.commandCap);

  const falcon = ships["ship.std_falcon"];
  check("标准矛隼单舰 4 人口", entryCost(falcon, 1) === 4, String(entryCost(falcon, 1)));
  check("方案自带装配结果", falcon.derived.ok && falcon.derived.weapons.length === 2);
}

console.log("core 无 DOM 也能跑");
{
  const core = new GameCore({ width: 1200, height: 700 });
  const n0 = core.units.length;
  check("初始单位按编制生成", n0 === 8 * 24 + 2 * 6, String(n0));
  check("单位带战斗属性", typeof core.units[0].hp === "number");
  check("血量来自船体模板（60）", core.units[0].maxHp === 60, String(core.units[0].maxHp));
  check("受击半径来自船体模板（6）", core.units[0].hitR === 6, String(core.units[0].hitR));
  check("每艘船有武器槽", core.units[0].weapons.length === 2, String(core.units[0].weapons.length));

  for (let i = 0; i < 120; i++) core.step(1 / 60);
  check("推进 2 秒后时间前进", Math.abs(core.time - 2) < 1e-6, String(core.time));
  check("单位仍在场", core.units.length > 0, String(core.units.length));

  const v = core.getView();
  check("getView 有 units/squads/fx", Array.isArray(v.units) && Array.isArray(v.squads));
  const s = core.snapshot();
  check("snapshot 不含 units", s.units === undefined);
  check("snapshot 有指挥值", typeof s.commandUsed === "number");
  check("snapshot 带方案列表", Array.isArray(s.shipList) && s.shipList.length > 0);
  check("snapshot 小队带承载量", typeof s.squads[0].capacity === "number");
}

console.log("命令：合法性校验由 core 决定");
{
  const core = new GameCore({ width: 1200, height: 700 });

  const ok = core.command({ type: "setLoadout", squadId: 0, count: 26 });
  check("正常加 2 艘通过", ok.ok === true, JSON.stringify(ok));
  check("模组被扣 2", core.build.modules === 22, String(core.build.modules));

  const bad = core.command({ type: "setLoadout", squadId: 0, count: 48 });
  check("超指挥值被拒绝", bad.ok === false, JSON.stringify(bad));
  check("拒绝理由含指挥值", (bad.reasons || []).some(r => r.includes("指挥值")),
        JSON.stringify(bad.reasons));

  const ghost = core.command({ type: "setLoadout", squadId: 0, ship: "ship.nope" });
  check("未知方案被拒绝", ghost.ok === false);
  check("拒绝理由含未知方案", (ghost.reasons || []).some(r => r.includes("未知舰船方案")),
        JSON.stringify(ghost.reasons));

  const core2 = new GameCore({ width: 1200, height: 700 });
  core2.build.modules = 1;
  const noMods = core2.command({ type: "setLoadout", squadId: 0, count: 26 });
  check("超模组被拒绝", noMods.ok === false, JSON.stringify(noMods));
  check("拒绝理由含预制模组", (noMods.reasons || []).some(r => r.includes("预制模组")),
        JSON.stringify(noMods.reasons));
  check("被拒绝时编制未改动", core2.build.squads[0].count === 24,
        String(core2.build.squads[0].count));

  const huge = core.command({ type: "setLoadout", squadId: 0, count: 999 });
  check("超单队上限被拒绝", huge.ok === false);

  core.build.modules = 9999;
  let rejectedByCommand = false;
  for (const sq of core.build.squads) {
    const r = core.command({
      type: "setLoadout", squadId: sq.id, ship: "ship.std_citadel", count: 40
    });
    if (!r.ok && (r.reasons || []).some(t => t.includes("指挥值"))) rejectedByCommand = true;
  }
  check("超指挥值被拒绝", rejectedByCommand);

  const afterReject = core.snapshot();
  check("被拒绝后状态未被写入", afterReject.commandUsed <= core.build.commandCap,
        afterReject.commandUsed + " / " + core.build.commandCap);
}

console.log("命令：换方案保留战损比");
{
  const core = new GameCore({ width: 1200, height: 700 });
  for (let i = 0; i < 30; i++) core.step(1 / 60);
  const u = core.units.find(x => x.squad === 0);
  u.hp = u.maxHp * 0.5;
  const before = u.hp / u.maxHp;

  core.command({ type: "setLoadout", squadId: 0, count: 26 });
  const u2 = core.units.find(x => x.squad === 0);
  const after = u2.hp / u2.maxHp;
  check("战损比大致保留", Math.abs(after - before) < 0.02,
        before.toFixed(2) + " → " + after.toFixed(2));

  const r = core.command({
    type: "setLoadout", squadId: 0, ship: "ship.std_citadel", count: 2
  });
  check("换成堡垒级通过", r.ok === true, JSON.stringify(r));
  const u3 = core.units.find(x => x.squad === 0);
  check("maxHp 变为堡垒级 280", u3.maxHp === 280, String(u3.maxHp));
  check("武器槽变成 4 个", u3.weapons.length === 4, String(u3.weapons.length));
  check("方案 id 写进 build", core.build.squads[0].ship === "ship.std_citadel");

  const snap = core.snapshot();
  const sq0 = snap.squads.find(s => s.id === 0);
  check("单舰指挥值变成 22", sq0.command === 22, String(sq0.command));
  check("本队指挥值 2×22", sq0.cost === 44, String(sq0.cost));
}

console.log("支援方案真的进了 sim");
{
  const core = new GameCore({ width: 1200, height: 700 });
  const loose = core.build.squads.find(s => s.ship === "ship.support_charger");
  check("初始编制里有护盾支援队", !!loose);
  const sq = core.squads[loose.id];
  check("小队参数带 abilities", Array.isArray(sq.p.abilities) && sq.p.abilities.length === 1,
        JSON.stringify((sq.p.abilities || []).map(a => a.id)));
  check("能力来自插件装配", sq.p.abilities[0].resource === "shield");
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
