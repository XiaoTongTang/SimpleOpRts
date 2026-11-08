/**
 * 数值偏离审计
 *   node test/balance.audit.mjs
 *
 * 这是数值设计阶段的守门人：
 *   1. 全表默认值必须等于推荐值（否则新加一条模板就先亮红灯，没人会去看）
 *   2. 审计必须**真的会报**——故意改歪一个值，得能看到 warn/alert
 *   3. 推荐函数必须是纯的（不改模板、不读时间）
 */

import { HULL_TEMPLATES } from "../src/core/data/hull-templates.js";
import { PLUGIN_TEMPLATES } from "../src/core/data/plugin-templates.js";
import { WEAPONS } from "../src/core/sim/weapons.js";
import {
  balanceReport, balanceSummary, recommendHull, recommendWeapon, recommendPlugin, driftLevel
} from "../src/core/data/recommend.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
                          : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));
const eq = (n, a, b) => ok(n, a === b, `期望 ${b}，实际 ${a}`);

console.log("\n[1] 全表审计");
const rows = balanceReport();
const sum = balanceSummary(rows);
console.log(`      ${sum.ok} ok / ${sum.warn} warn / ${sum.alert} alert（共 ${rows.length} 条）`);
eq("alert 必须为 0", sum.alert, 0);
eq("warn 必须为 0", sum.warn, 0);
ok("至少覆盖 30 个字段", rows.length >= 30, String(rows.length));

console.log("\n[2] 审计要真的会报（故意改歪）");
const falcon = HULL_TEMPLATES["hull.falcon"];
const tweaked = balanceReport({
  hulls: { ...HULL_TEMPLATES, "hull.falcon": { ...falcon, command: 8 } }
});
const cmdRow = tweaked.find(r => r.id === "hull.falcon" && r.field === "command");
eq("改歪的 command 被标 alert", cmdRow.level, "alert");
eq("drift 记录 +1", cmdRow.drift, 1);
eq("推荐值仍是 4", cmdRow.recommended, 4);

const mild = balanceReport({
  hulls: { ...HULL_TEMPLATES, "hull.falcon": { ...falcon, command: 5 } }
});
eq("+25% 记为 warn", mild.find(r => r.id === "hull.falcon" && r.field === "command").level, "warn");

console.log("\n[3] 分级阈值");
eq("0 → ok", driftLevel(0), "ok");
eq("±20% → ok", driftLevel(0.2), "ok");
eq("-20% → ok", driftLevel(-0.2), "ok");
eq("25% → warn", driftLevel(0.25), "warn");
eq("50% → warn", driftLevel(0.5), "warn");
eq("51% → alert", driftLevel(0.51), "alert");

console.log("\n[4] 推荐函数是纯的");
const snap = JSON.stringify(falcon);
recommendHull(falcon);
recommendWeapon(WEAPONS.laser);
recommendPlugin(PLUGIN_TEMPLATES["plugin.charger_s"]);
eq("调用后模板未被修改", JSON.stringify(falcon), snap);
const r1 = JSON.stringify(recommendHull(falcon));
const r2 = JSON.stringify(recommendHull(falcon));
ok("同输入同输出", r1 === r2);

console.log("\n[5] 已知的关键约定");
const hf = recommendHull(HULL_TEMPLATES["hull.falcon"]);
eq("矛隼级推荐 capacity 14", hf.capacity, 14);
eq("矛隼级推荐 command 4", hf.command, 4);
eq("矛隼级推荐 buildTime 8", hf.buildTime, 8);
eq("母舰 command 恒 0", recommendHull(HULL_TEMPLATES["hull.ark"]).command, 0);
const cap = recommendPlugin(PLUGIN_TEMPLATES["plugin.capacitor"]);
ok("扩容电容的占用 ≥ 加成×0.8", cap.capacity >= 6 * 0.8, String(cap.capacity));
const chg = recommendPlugin(PLUGIN_TEMPLATES["plugin.charger_s"]);
eq("充能器·小 推荐 4", chg.capacity, 4);
eq("充能器·小 工时 1.8", chg.buildTime, 1.8);
const rep = recommendPlugin(PLUGIN_TEMPLATES["plugin.repair_drone"]);
eq("维修无人机 推荐 1", rep.capacity, 1);

console.log("\n[6] 每个单独等级都有覆盖（防止某个循环根本没跑）");
const levels = new Set(rows.map(r => r.level));
ok("出现了 ok", levels.has("ok"));
const ids = new Set(rows.map(r => r.id));
for (const id of ["hull.falcon", "hull.citadel", "hull.ark", "laser", "railgun",
                  "plugin.capacitor", "plugin.charger_l", "plugin.repair_drone"]) {
  ok(`审计覆盖 ${id}`, ids.has(id));
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
