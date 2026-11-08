/**
 * core 冒烟测试（无浏览器、无 UI）
 * -----------------------------------------------------------------
 * 这条测试存在的意义：证明「core 先于 React 存在」这条纪律是真的，
 * 不是写在文档里的口号。用 node 直接跑：
 *
 *   node test/core.smoke.mjs
 *
 * 注意：main.js 会 install 主循环，但 core.js 不 import 任何 DOM，
 * 所以这里能裸跑。
 */

import { GameCore } from "../src/core/core.js";
import { createBuild, commandsUsed, HULLS } from "../src/core/state.js";

let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    console.log("  ✓ " + name);
  } else {
    failed++;
    console.log("  ✗ " + name + (extra ? "  → " + extra : ""));
  }
}

console.log("build state");
{
  const b = createBuild();
  check("10 支小队", b.squads.length === 10, String(b.squads.length));
  check("指挥值可计算", commandsUsed(b) === 8 * 24 * HULLS.frigate.cost + 2 * 6 * HULLS.frigate.cost,
        String(commandsUsed(b)));
  check("初始编制不超指挥值", commandsUsed(b) <= b.commandCap,
        commandsUsed(b) + " / " + b.commandCap);
}

console.log("core 无 DOM 也能跑");
{
  const core = new GameCore({ width: 1200, height: 700 });
  const n0 = core.units.length;
  check("初始单位按编制生成", n0 === 8 * 24 + 2 * 6, String(n0));
  check("单位带战斗属性", typeof core.units[0].hp === "number");

  for (let i = 0; i < 120; i++) core.step(1 / 60);
  check("推进 2 秒后时间前进", Math.abs(core.time - 2) < 1e-6, String(core.time));
  check("单位仍在场", core.units.length > 0, String(core.units.length));

  const v = core.getView();
  check("getView 有 units/squads/fx", Array.isArray(v.units) && Array.isArray(v.squads));
  const s = core.snapshot();
  check("snapshot 不含 units", s.units === undefined);
  check("snapshot 有指挥值", typeof s.commandUsed === "number");
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

  // 单独验证「模组」这条规则：新建一支模组余额只有 1 的部队
  const core2 = new GameCore({ width: 1200, height: 700 });
  core2.build.modules = 1;
  const noMods = core2.command({ type: "setLoadout", squadId: 0, count: 26 });
  check("超模组被拒绝", noMods.ok === false, JSON.stringify(noMods));
  check("拒绝理由含预制模组", (noMods.reasons || []).some(r => r.includes("预制模组")),
        JSON.stringify(noMods.reasons));
  check("被拒绝时编制未改动", core2.build.squads[0].count === 24, String(core2.build.squads[0].count));

  const huge = core.command({ type: "setLoadout", squadId: 0, count: 999 });
  check("超单队上限被拒绝", huge.ok === false);

  // 把整个部队堆到超指挥值
  core.build.modules = 9999;
  let rejectedByCommand = false;
  for (const sq of core.build.squads) {
    const r = core.command({ type: "setLoadout", squadId: sq.id, hull: "cruiser", count: 40 });
    if (!r.ok && (r.reasons || []).some(t => t.includes("指挥值"))) rejectedByCommand = true;
  }
  check("超指挥值被拒绝", rejectedByCommand);

  const afterReject = core.snapshot();
  check("被拒绝后状态未被写入", afterReject.commandUsed <= core.build.commandCap,
        afterReject.commandUsed + " / " + core.build.commandCap);
}

console.log("命令：改编制保留战损比");
{
  const core = new GameCore({ width: 1200, height: 700 });
  for (let i = 0; i < 30; i++) core.step(1 / 60);
  const u = core.units.find(x => x.squad === 0);
  u.hp = u.maxHp * 0.5;
  const before = u.hp / u.maxHp;

  core.command({ type: "setLoadout", squadId: 0, count: 26 });
  const u2 = core.units.find(x => x.squad === 0);
  const after = u2.hp / u2.maxHp;
  check("战损比大致保留", Math.abs(after - before) < 0.02, before.toFixed(2) + " → " + after.toFixed(2));

  core.command({ type: "setLoadout", squadId: 0, hull: "cruiser", count: 2 });
  const u3 = core.units.find(x => x.squad === 0);
  check("换船体后 maxHp 变为巡洋舰", u3.maxHp === HULLS.cruiser.hp, String(u3.maxHp));
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
