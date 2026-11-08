/**
 * 方案库自检
 *   node test/library.smoke.mjs
 *
 * 验的是「玩家能做的那几件事」：
 *   新建 / 改名 / 复制 / 删除 / 改装配，以及改完会不会同步到在用的小队。
 * 另外守一条：存档往返之后，所有方案的 derived 必须逐字节一致。
 */

import { GameCore } from "../src/core/core.js";
import {
  createLibrary, MAX_SHIPS, serializeLibrary, deserializeLibrary
} from "../src/core/data/ship-library.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
                          : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));
const eq = (n, a, b) => ok(n, a === b, `期望 ${b}，实际 ${a}`);

const mk = () => new GameCore({ width: 1000, height: 700 });

console.log("\n[1] 预置库");
{
  const lib = createLibrary();
  eq("6 条预置方案", Object.keys(lib).length, 6);
  ok("全部装配合法", Object.values(lib).every(s => s.derived.ok),
    Object.values(lib).filter(s => !s.derived.ok).map(s => s.id).join(","));
  eq("标准矛隼 2 个武器槽", lib["ship.std_falcon"].derived.weapons.length, 2);
}

console.log("\n[2] 新建");
{
  const core = mk();
  const r = core.command({ type: "createShip", hull: "hull.hammer", name: "我的重锤" });
  ok("创建成功", r.ok === true, JSON.stringify(r));
  eq("拿到 id", r.id, "ship.usr_0001");
  const s = core.ships[r.id];
  eq("名字正确", s.name, "我的重锤");
  eq("船体正确", s.hull, "hull.hammer");
  eq("空装配 0 占用", s.derived.capacityUsed, 0);
  eq("方案库计数 +1", Object.keys(core.ships).length, 7);
  eq("版本号前进", core.shipRev, 1);

  const bad = core.command({ type: "createShip", hull: "hull.nope" });
  ok("未知船体被拒", bad.ok === false, JSON.stringify(bad));
}

console.log("\n[3] 上限 20");
{
  const core = mk();
  let lastOk = null;
  while (Object.keys(core.ships).length < MAX_SHIPS) {
    lastOk = core.command({ type: "createShip", hull: "hull.falcon" });
  }
  eq("刚好 20 条", Object.keys(core.ships).length, MAX_SHIPS);
  const over = core.command({ type: "createShip", hull: "hull.falcon" });
  ok("第 21 条被拒", over.ok === false, JSON.stringify(over));
  ok("理由提到上限", /上限 20/.test((over.reasons || []).join("")), JSON.stringify(over.reasons));
  ok("被拒时没有留下半成品", Object.keys(core.ships).length === MAX_SHIPS);
}

console.log("\n[4] 改名");
{
  const core = mk();
  const r = core.command({ type: "renameShip", shipId: "ship.std_falcon", name: "矛隼·改" });
  ok("改名成功", r.ok === true);
  eq("名字已变", core.ships["ship.std_falcon"].name, "矛隼·改");

  const empty = core.command({ type: "renameShip", shipId: "ship.std_falcon", name: "   " });
  ok("空名被拒", empty.ok === false, JSON.stringify(empty));
  eq("空名没生效", core.ships["ship.std_falcon"].name, "矛隼·改");

  const long = core.command({ type: "renameShip", shipId: "ship.std_falcon", name: "一".repeat(25) });
  ok("超长名被拒", long.ok === false);
}

console.log("\n[5] 复制");
{
  const core = mk();
  const r = core.command({ type: "duplicateShip", shipId: "ship.std_falcon", name: "副本" });
  ok("复制成功", r.ok === true, JSON.stringify(r));
  eq("新 id 是自增的", r.id, "ship.usr_0001");
  eq("名字可取", core.ships[r.id].name, "副本");
  ok("装配和原件一致",
    JSON.stringify(core.ships[r.id].fit) === JSON.stringify(core.ships["ship.std_falcon"].fit));

  // 改副本不该影响原件
  core.command({ type: "setShipFit", shipId: r.id, slotId: "w1", itemId: null });
  eq("原件 w1 还在", core.ships["ship.std_falcon"].fit.w1, "laser");
  eq("副本 w1 已清空", core.ships[r.id].fit.w1, null);
}

console.log("\n[6] 删除");
{
  const core = mk();
  const used = core.command({ type: "deleteShip", shipId: "ship.std_falcon" });
  ok("在用的方案不能删", used.ok === false, JSON.stringify(used));
  ok("理由说明有几支小队在用", /小队在用/.test((used.reasons || []).join("")),
    JSON.stringify(used.reasons));

  const r = core.command({ type: "createShip", hull: "hull.falcon" });
  const del = core.command({ type: "deleteShip", shipId: r.id });
  ok("没人用的可以删", del.ok === true, JSON.stringify(del));
  ok("库里确实没了", core.ships[r.id] === undefined);
}

console.log("\n[7] 改装配：事务式");
{
  const core = mk();
  const before = JSON.stringify(core.ships["ship.std_falcon"].fit);

  const bad = core.command({ type: "setShipFit", shipId: "ship.std_falcon", slotId: "w1", itemId: "railgun" });
  ok("装不下被拒（M 进 S 槽）", bad.ok === false, JSON.stringify(bad));
  ok("被拒后库里没变", JSON.stringify(core.ships["ship.std_falcon"].fit) === before);

  const good = core.command({ type: "setShipFit", shipId: "ship.std_falcon", slotId: "w1", itemId: "missile" });
  ok("合法装配通过", good.ok === true, JSON.stringify(good));
  eq("w1 变成导弹", core.ships["ship.std_falcon"].fit.w1, "missile");
  eq("承载 5+3", core.ships["ship.std_falcon"].derived.capacityUsed, 8);

  const over = core.command({
    type: "setShipFit", shipId: "ship.std_falcon", slotId: "p1", itemId: "plugin.charger_l"
  });
  ok("超承载被拒", over.ok === false, JSON.stringify(over));
  ok("理由给出具体数字", /超出承载量/.test((over.reasons || []).join("")),
    JSON.stringify(over.reasons));
}

console.log("\n[8] 改装配同步到在用的小队");
{
  const core = mk();
  eq("小队的第二个武器是激光", core.squads[0].p.weapons[1], "laser");
  core.command({ type: "setShipFit", shipId: "ship.std_falcon", slotId: "w2", itemId: "missile" });
  eq("小队立刻换成导弹", core.squads[0].p.weapons[1], "missile");
  ok("战场单位也换了",
    core.units.find(u => u.squad === 0 && u.hp > 0).weapons[1].id === "missile");
}

console.log("\n[9] 预览不写库");
{
  const core = mk();
  const rev = core.shipRev;
  const p1 = core.query({ type: "previewFit", shipId: "ship.std_falcon", slotId: "w1", itemId: "railgun" });
  ok("预览非法装配返回 ok:false", p1.ok === false);
  ok("预览给出原因", (p1.reasons || []).length > 0);
  eq("版本号没动", core.shipRev, rev);
  eq("库没动", core.ships["ship.std_falcon"].fit.w1, "laser");

  const p2 = core.query({ type: "previewFit", shipId: "ship.std_falcon", slotId: "w1", itemId: "missile" });
  ok("预览合法装配返回 ok:true", p2.ok === true);
  eq("预览带出 derived", p2.derived.capacityUsed, 8);
  eq("库仍然没动", core.ships["ship.std_falcon"].fit.w1, "laser");
}

console.log("\n[10] 存档往返：derived 必须一致");
{
  const core = mk();
  core.command({ type: "createShip", hull: "hull.citadel", name: "旗舰" });
  core.command({ type: "setShipFit", shipId: "ship.usr_0001", slotId: "w1", itemId: "railgun" });
  core.command({ type: "setShipFit", shipId: "ship.usr_0001", slotId: "p1", itemId: "plugin.deflector" });

  const data = serializeLibrary(core.ships);
  const json = JSON.stringify(data);
  ok("存档是可序列化 JSON", typeof json === "string" && json.length > 100);
  ok("存档里没有 derived（派生值不落盘）", !/"[^"]*derived"/.test(json));

  const restored = deserializeLibrary(JSON.parse(json));
  eq("方案数一致", Object.keys(restored).length, Object.keys(core.ships).length);

  let mismatch = [];
  for (const id of Object.keys(core.ships)) {
    const a = JSON.stringify(core.ships[id].derived);
    const b = JSON.stringify(restored[id].derived);
    if (a !== b) mismatch.push(id);
  }
  ok("每条方案的 derived 完全一致", mismatch.length === 0, mismatch.join(","));

  // 坏数据不应该让整份存档报废
  const broken = deserializeLibrary({
    ships: [
      { id: "ship.ok", hull: "hull.falcon", name: "好的", fit: { w1: "laser" } },
      { id: "ship.bad", hull: "hull.nope", name: "坏的", fit: {} },
      { hull: "hull.falcon" }
    ]
  });
  eq("坏记录被跳过，好的留下", Object.keys(broken).length, 1);
  ok("留下的就是那条好的", !!broken["ship.ok"]);
}

console.log("\n[11] 重开一局不清空方案库");
{
  const core = mk();
  core.command({ type: "createShip", hull: "hull.falcon", name: "留存" });
  const n = Object.keys(core.ships).length;
  core.command({ type: "reset" });
  eq("方案数不变", Object.keys(core.ships).length, n);
  ok("自建方案还在", !!core.ships["ship.usr_0001"]);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
