/**
 * 单位战斗属性自检（"给舰船加属性"这一步的验收）
 *   node test/unit-attrs.smoke.mjs
 *
 * 设计约定（见 design/261107_2机制改进/战斗中小队，散兵，建造关系.md）：
 *   1. 舰船身上**不保存方案引用**，只保存自己的战斗属性
 *      （血量 / 护盾 / 武器槽 / 支援能力）
 *   2. 属性在造出来那一刻从所属小队的方案编译一次
 *   3. 之后改方案会连带改掉在役舰船 —— 所以用「在役就禁止改方案」从命令层堵住
 *
 * 这条测试守的就是上面三条：属性在单位上、出生即定格、锁是唯一防线。
 */

import { GameCore } from "../src/core/core.js";
import { setFit } from "../src/core/data/ship-template.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
                          : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));
const eq = (n, a, b) => ok(n, a === b, `期望 ${b}，实际 ${a}`);

const mk = () => new GameCore({ width: 1000, height: 700 });
const unitOf = (core, squad) => core.units.find(u => u.squad === squad);

console.log("\n[1] 属性长在每艘船上");
{
  const core = mk();
  const u = core.units[0];
  ok("有血量", typeof u.hp === "number" && typeof u.maxHp === "number");
  ok("有武器槽数组", Array.isArray(u.weapons) && u.weapons.length === 2,
    String(u.weapons && u.weapons.length));
  ok("有支援能力数组", Array.isArray(u.abilities), String(typeof u.abilities));
  eq("不保留方案引用（unit.shipId 不存在）", u.shipId, undefined);

  // 同队来自同一个方案 → 属性一致
  eq("同队血量一致", unitOf(core, 1).maxHp, u.maxHp);
  // 不同方案 → 属性不同（支援舰与矛隼不是一套数值）
  const sup = core.build.squads.find(b => b.ship === "ship.support_repair").id;
  ok("不同方案的舰船属性不同", unitOf(core, sup).maxHp !== u.maxHp,
    `${unitOf(core, sup).maxHp} vs ${u.maxHp}`);
}

console.log("\n[2] 出生即定格：直接改库不会追到在场舰船");
{
  const core = mk();
  const u = unitOf(core, 0);
  eq("改之前 w2 是激光", u.weapons[1].id, "laser");

  // 绕过命令层，直接换库里的方案（模拟"强行改动"）
  const r = setFit(core.ships["ship.std_falcon"], "w2", "missile", 0);
  core.ships["ship.std_falcon"] = r.template;

  eq("在场舰船没被追改", unitOf(core, 0).weapons[1].id, "laser");
}

console.log("\n[3] 强制同步会改到在役舰船（所以锁是唯一防线）");
{
  const core = mk();
  eq("改之前 w2 是激光", unitOf(core, 0).weapons[1].id, "laser");

  const r = setFit(core.ships["ship.std_falcon"], "w2", "missile", 0);
  core.ships["ship.std_falcon"] = r.template;
  core.syncShipUsage("ship.std_falcon");          // 这条就是被锁挡住的路径

  eq("同步之后在场舰船变成导弹", unitOf(core, 0).weapons[1].id, "missile");
  eq("小队默认参数也变了", core.squads[0].p.weapons[1], "missile");
}

console.log("\n[4] 补员造出来的船，拿到出生那一刻的属性");
{
  const core = mk();
  const b = core.build.squads[0];
  core.units = core.units.filter(u => u.squad !== b.id);   // 先打空这支小队
  core.build.modules = 10;

  const r = core.command({ type: "instantRefill", squadId: b.id, count: 3 });
  ok("补了 3 艘", r.ok === true && r.built === 3, JSON.stringify(r));

  const fresh = core.units.filter(u => u.squad === b.id);
  eq("3 艘都在场", fresh.length, 3);
  ok("都带完整战斗属性", fresh.every(u =>
    u.maxHp > 0 && Array.isArray(u.weapons) && u.weapons.length === 2));

  // 换掉方案库里的方案，新补的船不受影响（属性已经写在自己身上）
  const rr = setFit(core.ships["ship.std_falcon"], "w1", "missile", 0);
  core.ships["ship.std_falcon"] = rr.template;
  eq("补员船的 w1 还是激光", fresh[0].weapons[0].id, "laser");
}

console.log("\n[5] 一队里可以混装不同属性的船（散兵队的底座）");
{
  const core = mk();
  const rt = core.runtimeOf("ship.std_citadel");
  const heavy = core.makeUnit(0, rt, 100, 100);
  core.units.push(heavy);

  const sq0 = core.units.filter(u => u.squad === 0);
  eq("同一小队 25 艘", sq0.length, 25);
  eq("普通舰 60 血", unitOf(core, 0).maxHp, 60);
  eq("混进来的堡垒级 280 血", heavy.maxHp, 280);
  eq("两支船互不影响武器数", heavy.weapons.length, 4);

  const light = sq0.find(u => u !== heavy);
  eq("小队的枪手还是 2 个槽", light.weapons.length, 2);
  ok("重舰自己的血量认自己的", heavy.hp === heavy.maxHp && light.hp === light.maxHp);
}

console.log("\n[6] 支援能力按船走，不按队走");
{
  const core = mk();
  const supSquad = core.build.squads.find(b => b.ship === "ship.support_repair").id;
  const carrier = core.units.find(u => u.squad === supSquad);
  ok("支援舰自己有 abilities", carrier.abilities.length === 1,
    JSON.stringify(carrier.abilities.map(a => a.id)));

  const plain = unitOf(core, 0);
  ok("普通舰的 abilities 是空数组", Array.isArray(plain.abilities) &&
    plain.abilities.length === 0, JSON.stringify(plain.abilities));
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
