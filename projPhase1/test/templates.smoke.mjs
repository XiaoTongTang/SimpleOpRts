/**
 * 船体模板 / 舰船模板 的结构自检
 *   node test/templates.smoke.mjs
 *
 * 只验「结构与算账」，不验画面。
 */

import { HULL_TEMPLATES, hullCommand, hullBuildTime } from "../src/core/data/hull-templates.js";
import {
  createShipTemplate, computeShip, setFit, compileShip
} from "../src/core/data/ship-template.js";

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  → " + extra : ""}`); }
}
function eq(name, a, b) {
  ok(name, a === b, `期望 ${b}，实际 ${a}`);
}

console.log("\n[1] 指挥值推导（必须复现 4 / 10 / 22）");
eq("矛隼级 frigate", hullCommand(HULL_TEMPLATES["hull.falcon"]), 4);
eq("壁垒级 frigate", hullCommand(HULL_TEMPLATES["hull.bulwark"]), 6);
eq("重锤级 destroyer", hullCommand(HULL_TEMPLATES["hull.hammer"]), 10);
eq("堡垒级 cruiser", hullCommand(HULL_TEMPLATES["hull.citadel"]), 22);
eq("方舟级 mothership 不计人口", hullCommand(HULL_TEMPLATES["hull.ark"]), 0);

console.log("\n[2] 建造时间推导");
eq("矛隼级 4×2.0", hullBuildTime(HULL_TEMPLATES["hull.falcon"]), 8);
eq("重锤级 10×2.6", hullBuildTime(HULL_TEMPLATES["hull.hammer"]), 26);
eq("堡垒级 22×2.9", hullBuildTime(HULL_TEMPLATES["hull.citadel"]), 63.8);

console.log("\n[3] 空装配模板");
const empty = createShipTemplate({ id: "ship.a", hull: "hull.falcon" });
ok("空装配合法", empty.derived.ok, empty.derived.reasons.join("/"));
eq("承载力上限", empty.derived.capacity, 12);
eq("占用 0", empty.derived.capacityUsed, 0);
eq("指挥值", empty.derived.command, 4);
eq("建造时间 = 船体基准", empty.derived.buildTime, 8);
ok("fit 键覆盖全部插槽", Object.keys(empty.fit).length === 4, Object.keys(empty.fit).join(","));

console.log("\n[4] 装两门激光");
const laser = setFit(setFit(empty, "w1", "laser").template, "w2", "laser").template;
ok("合法", laser.derived.ok, laser.derived.reasons.join("/"));
eq("承载占用 3+3", laser.derived.capacityUsed, 6);
eq("建造时间 8+1.2+1.2", laser.derived.buildTime, 10.4);
eq("武器列表长度", laser.derived.weapons.length, 2);
eq("指挥值不变（装配不影响人口）", laser.derived.command, 4);

console.log("\n[5] 插槽尺寸限制");
const bad = setFit(empty, "w1", "railgun");   // 轨道炮是 M，w1 是 S
ok("S 槽装 M 武器被拒", !bad.ok, bad.reasons.join("/"));
ok("拒绝原因提到尺寸", /装不下/.test(bad.reasons.join("")));

console.log("\n[6] 承载力超限");
// 矛隼级上限 12：两发导弹(5+5) + 偏导护盾(4) + 自动装填机(3) = 17
let over = setFit(empty, "w1", "missile");
over = setFit(over.template, "w2", "missile");
over = setFit(over.template, "p1", "plugin.deflector");
over = setFit(over.template, "p2", "plugin.autoloader");
ok("超承载被拒", !over.ok, over.reasons.join("/"));
eq("占用算出来 17", over.template.derived.capacityUsed, 17);
eq("剩余为负 5", over.template.derived.capacityFree, -5);
ok("拒绝原因提到承载量", /超出承载量/.test(over.reasons.join("")));

const citadel = createShipTemplate({ id: "ship.c", hull: "hull.citadel" }); // 60 承载
const big = setFit(citadel, "w1", "railgun");   // L 槽装 M，允许
ok("大槽能装小武器", big.ok, big.reasons.join("/"));

console.log("\n[7] 插件加成");
let p = setFit(empty, "p1", "plugin.shellplate");
p = setFit(p.template, "p2", "plugin.capacitor");
const withP = p.template;
ok("合法", withP.derived.ok, withP.derived.reasons.join("/"));
eq("扩容电容把上限抬到 18", withP.derived.capacity, 18);
eq("插件自身占 3+2", withP.derived.capacityUsed, 5);
eq("血量 60+25", withP.derived.armor.hp, 85);
eq("受击半径 6+1.5", withP.derived.armor.hullHitR, 7.5);

console.log("\n[8] 编译到运行时参数");
const rt = compileShip(laser);
eq("maxHp", rt.maxHp, 60);
eq("weapon 取首槽", rt.weapon, "laser");
eq("weapons 齐列", rt.weapons.join(","), "laser,laser");
eq("command", rt.command, 4);
ok("class 带过来了", rt.class === "frigate");

console.log("\n[9] 未知 id 不崩");
const junk = { id: "ship.x", name: "x", hull: "hull.falcon", fit: { w1: "nope", p1: "nope2" }, meta: {} };
const jr = computeShip(junk);
ok("返回 ok=false 而不是抛异常", !jr.ok);
ok("两条未知原因", jr.reasons.length === 2, jr.reasons.join("/"));

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
