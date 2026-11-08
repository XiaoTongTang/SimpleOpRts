/**
 * 船体 / 武器 / 插件 / 能力 / 舰船 模板的结构自检
 *   node test/templates.smoke.mjs
 */

import { HULL_TEMPLATES, slotIds, slotVolume, findSlot } from "../src/core/data/hull-templates.js";
import { PLUGIN_TEMPLATES } from "../src/core/data/plugin-templates.js";
import { ABILITY_TEMPLATES } from "../src/core/data/ability-templates.js";
import { WEAPONS } from "../src/core/sim/weapons.js";
import {
  createShipTemplate, createDefaultFit, computeShip, setFit, compileShip, cloneShip
} from "../src/core/data/ship-template.js";
import { recommendHull } from "../src/core/data/recommend.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
                          : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));
const eq = (n, a, b) => ok(n, a === b, `期望 ${b}，实际 ${a}`);

/** 连续改多个槽位，每次都拿到新模板 */
function fitOf(hullId, pairs) {
  let t = createShipTemplate({ id: "ship.t", hull: hullId });
  const reasons = [];
  for (const [slot, item] of pairs) {
    const r = setFit(t, slot, item);
    t = r.template;
    reasons.push(...r.reasons);
  }
  return { tpl: t, reasons };
}

console.log("\n[1] 船体表");
eq("5 条船体", Object.keys(HULL_TEMPLATES).length, 5);
eq("矛隼级 command", HULL_TEMPLATES["hull.falcon"].command, 4);
eq("矛隼级 buildTime", HULL_TEMPLATES["hull.falcon"].buildTime, 8);
eq("矛隼级 capacity", HULL_TEMPLATES["hull.falcon"].capacity, 14);
eq("堡垒级 command", HULL_TEMPLATES["hull.citadel"].command, 22);
eq("方舟级 command", HULL_TEMPLATES["hull.ark"].command, 0);
const src = JSON.stringify(HULL_TEMPLATES);
ok("槽位里没有 arc 字段", !/"arc"\s*:/.test(src));
ok("模板是冻结的", Object.isFrozen(HULL_TEMPLATES["hull.falcon"].armor));

console.log("\n[2] 推荐值必须复现手填值（4 / 6 / 10 / 22）");
for (const h of Object.values(HULL_TEMPLATES)) {
  const r = recommendHull(h);
  eq(`${h.name} capacity`, h.capacity, r.capacity);
  eq(`${h.name} command`, h.command, r.command);
  eq(`${h.name} buildTime`, h.buildTime, r.buildTime);
}
eq("矛隼级容积", slotVolume(HULL_TEMPLATES["hull.falcon"]), 18);
eq("堡垒级容积", slotVolume(HULL_TEMPLATES["hull.citadel"]), 42);

console.log("\n[3] 空装配");
const empty = createShipTemplate({ id: "ship.a", hull: "hull.falcon" });
ok("空装配合法", empty.derived.ok, empty.derived.reasons.join("/"));
eq("承载上限", empty.derived.capacity, 14);
eq("占用 0", empty.derived.capacityUsed, 0);
eq("工时 = 船体基准", empty.derived.buildTime, 8);
eq("指挥值", empty.derived.command, 4);
eq("fit 键数 = 插槽数", Object.keys(empty.fit).length, slotIds(HULL_TEMPLATES["hull.falcon"]).length);
ok("空槽值为 null", empty.fit.w1 === null && empty.fit.p1 === null);

console.log("\n[4] 装两枚导弹");
const { tpl: armed, reasons: r4 } = fitOf("hull.falcon", [["w1", "missile"], ["w2", "missile"]]);
ok("合法", armed.derived.ok, r4.join("/"));
eq("占用 5+5", armed.derived.capacityUsed, 10);
eq("余量 4", armed.derived.capacityFree, 4);
eq("工时 8+2+2", armed.derived.buildTime, 12);
eq("武器数", armed.derived.weapons.length, 2);
eq("指挥值不因装配变化", armed.derived.command, 4);

console.log("\n[5] 尺寸兼容");
const bad = setFit(empty, "w1", "railgun");     // M 装不进 S
ok("S 槽装不下 M", !bad.ok, bad.reasons.join("/"));
ok("原因说明尺寸", /装不下/.test(bad.reasons.join("")));
const big = setFit(createShipTemplate({ id: "ship.c", hull: "hull.citadel" }), "w1", "railgun");
ok("M 武器能进 M 槽", big.ok, big.reasons.join("/"));

console.log("\n[6] 承载超限");
const { tpl: over, reasons: r6 } = fitOf("hull.hammer",
  [["w1", "missile"], ["w2", "missile"], ["w3", "missile"],
   ["p1", "plugin.capacitor"], ["p2", "plugin.shellplate"], ["p3", "plugin.charger_l"]]);
ok("超承载被拒", !over.derived.ok, r6.join("/"));
eq("占用 15+5+3+16", over.derived.capacityUsed, 39);
eq("上限 24+6", over.derived.capacity, 30);
eq("余量 -9", over.derived.capacityFree, -9);
ok("原因提到承载量", /超出承载量/.test(over.derived.reasons.join("")));

console.log("\n[7] 同船数量上限");
const dup = fitOf("hull.falcon", [["p1", "plugin.capacitor"], ["p2", "plugin.capacitor"]]);
ok("两个扩容电容被拒", !dup.tpl.derived.ok, dup.tpl.derived.reasons.join("/"));
ok("原因提到每船最多", /每船最多 1 个/.test(dup.reasons.join("")));

console.log("\n[8] 槽位种类");
const wrongKind = setFit(empty, "w1", "plugin.capacitor");
ok("武器槽塞插件被拒", !wrongKind.ok, wrongKind.reasons.join("/"));
ok("原因说明只能装武器", /只能装武器/.test(wrongKind.reasons.join("")));
const wrongKind2 = setFit(empty, "p1", "laser");
ok("插件槽塞武器被拒", !wrongKind2.ok);
ok("原因说明只能装插件", /只能装插件/.test(wrongKind2.reasons.join("")));

console.log("\n[9] 插件加成");
const shell = fitOf("hull.falcon", [["p1", "plugin.shellplate"]]).tpl;
eq("血量 60+25", shell.derived.armor.hp, 85);
eq("受击半径 6+1.5", shell.derived.armor.hullHitR, 7.5);
const cap = fitOf("hull.falcon", [["p1", "plugin.capacitor"]]).tpl;
eq("扩容电容抬上限到 20", cap.derived.capacity, 20);
eq("它自己占 5", cap.derived.capacityUsed, 5);
const auto = fitOf("hull.falcon", [["p2", "plugin.autoloader"]]).tpl;
eq("自动装填机 fireRate", auto.derived.fireRate, 0.85);
ok("fireRate 不进 armor", auto.derived.armor.hp === 60);
ok("capacity 不进 armor", cap.derived.armor.hp === 60);

console.log("\n[10] 支援能力");
const ark = createShipTemplate({ id: "ship.ark", hull: "hull.ark" });
eq("母舰自带 1 条能力", ark.derived.abilities.length, 1);
eq("4 架无人机 = 4 个目标", ark.derived.abilities[0].maxTargets, 4);
eq("能力资源是 hull", ark.derived.abilities[0].resource, "hull");
const chg = fitOf("hull.falcon", [["p1", "plugin.charger_s"]]).tpl;
eq("充能器能力数", chg.derived.abilities.length, 1);
eq("资源是 shield", chg.derived.abilities[0].resource, "shield");
eq("单台照顾 2 个", chg.derived.abilities[0].maxTargets, 2);
eq("grant 30", chg.derived.abilities[0].grant, 30);
const both = fitOf("hull.hammer", [["p1", "plugin.charger_s"], ["p2", "plugin.repair_drone"]]).tpl;
eq("两种能力共存", both.derived.abilities.length, 2);
ok("模板表里 3 条能力", Object.keys(ABILITY_TEMPLATES).length === 3);

console.log("\n[11] 编译到运行时");
const rt = compileShip(armed);
eq("maxHp", rt.maxHp, 60);
eq("weapon 兼容别名取首槽", rt.weapon, "missile");
eq("weapons 齐列", rt.weapons.join(","), "missile,missile");
eq("command", rt.command, 4);
eq("class", rt.class, "frigate");
ok("abilities 是数组", Array.isArray(rt.abilities));

console.log("\n[12] 异常与蓝图");
const junk = { id: "x", name: "x", hull: "hull.nope", fit: {}, meta: {} };
ok("未知船体不抛异常", computeShip(junk).ok === false);
const badW = setFit(empty, "w1", "nope");
ok("未知武器被拒", !badW.ok);
ok("原因带槽位", /槽 w1/.test(badW.reasons.join("")));
const locked = computeShip(empty, { unlocked: { hulls: new Set() } });
ok("未解锁船体被拒", !locked.ok);
ok("原因提到蓝图", /未解锁船体蓝图/.test(locked.reasons.join("")));
const lockedW = computeShip(armed, { unlocked: { hulls: new Set(["hull.falcon"]), weapons: new Set() } });
ok("未解锁武器被拒", !lockedW.ok);
ok("原因提到武器蓝图", /未解锁武器蓝图/.test(lockedW.reasons.join("")));

console.log("\n[13] 幂等与不可变");
const d1 = JSON.stringify(computeShip(armed).derived);
const d2 = JSON.stringify(computeShip(armed).derived);
ok("同输入同输出", d1 === d2);
const before = JSON.stringify(empty.fit);
setFit(empty, "w1", "laser");
eq("setFit 不改入参", JSON.stringify(empty.fit), before);
const cl = cloneShip(armed);
cl.fit.w1 = null;
ok("clone 是深拷贝", armed.fit.w1 === "missile");

console.log("\n[14] 武器构筑字段齐全");
for (const w of Object.values(WEAPONS)) {
  ok(`${w.name} 有 size/capacity/buildTime/command`,
    !!w.size && w.capacity !== undefined && w.buildTime !== undefined && w.command !== undefined);
}
for (const p of Object.values(PLUGIN_TEMPLATES)) {
  ok(`${p.name} 有 command/buildTime/capacity`,
    p.command !== undefined && p.buildTime !== undefined && p.capacity !== undefined);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
