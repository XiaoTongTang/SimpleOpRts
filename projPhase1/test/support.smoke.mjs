/**
 * 支援能力自检
 *   node test/support.smoke.mjs
 *
 * 只验机制，不验画面。重点验三件容易写错的事：
 *   1. 两遍遍历 → 结果与 units 数组顺序无关
 *   2. dt 封顶 → 掉帧不会一次奶满
 *   3. 护盾临时上限 → 光环走了要回落，且不能叠成 200
 *
 * 注意：能力挂在小队上（同一队的舰船装配相同），所以测试里必须把
 * 「携带支援模块的船」和「被支援的船」放在**不同小队**，否则它们会互相支援。
 */

import { stepSupport, MAX_SUPPORT_DT, FX_PERIOD } from "../src/core/sim/support-system.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
                          : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));
const eq = (n, a, b) => ok(n, a === b, `期望 ${b}，实际 ${a}`);
const near = (n, a, b) => ok(n, Math.abs(a - b) < 1e-9, `期望 ${b}，实际 ${a}`);

// ---- 构造 ------------------------------------------------------

const REPAIR = {
  id: "a.repair", resource: "hull", radius: 200, rate: 8, maxTargets: 1,
  grant: 0, includeSelf: false, select: "lowestRatio", fx: "repairbeam"
};
const CHARGER = {
  id: "a.charger", resource: "shield", radius: 200, rate: 10, maxTargets: 2,
  grant: 30, includeSelf: false, select: "lowestRatio", fx: "shieldlink"
};

/**
 * 0 = 普通友军（无能力）
 * 1 = 敌军
 * 2 / 3 = 友军支援舰
 */
function sq(o = {}) {
  return [
    { id: 0, faction: 0, p: { abilities: o.ally || [] } },
    { id: 1, faction: 1, p: { abilities: o.enemy || [] } },
    { id: 2, faction: 0, p: { abilities: o.s2 || [] } },
    { id: 3, faction: 0, p: { abilities: o.s3 || [] } }
  ];
}

function U(id, squad, x, y, o = {}) {
  return {
    id, squad, x, y, vx: 0, vy: 0,
    hp: o.hp ?? 100,
    maxHp: o.maxHp ?? 100,
    regen: 0,
    shield: o.shield ?? 0,
    maxShieldBase: o.maxShieldBase ?? 0,
    shieldCap: o.maxShieldBase ?? 0,
    shieldRegen: 0,
    fxCd: 0
  };
}

function run(units, squads, n, dt = 1 / 60, fx = null) {
  for (let i = 0; i < n; i++) stepSupport(units, squads, null, dt, fx);
  return units;
}

// ---- 1 维修 ----------------------------------------------------

console.log("\n[1] 维修：按速率回血、封顶、不打敌人、不自修");
{
  const squads = sq({ s2: [REPAIR] });
  const healer = U("h", 2, 0, 0, { hp: 100 });
  const victim = U("v", 0, 20, 0, { hp: 50 });
  const enemy = U("e", 1, 25, 0, { hp: 10 });
  const units = [healer, victim, enemy];

  stepSupport(units, squads, null, 0.05, null);
  near("友军回血 8×0.05=0.4", victim.hp, 50.4);
  eq("敌人没被修", enemy.hp, 10);
  eq("自己没被修（includeSelf=false）", healer.hp, 100);

  run(units, squads, 600);
  eq("封顶在 maxHp", victim.hp, 100);
}

console.log("\n[2] 维修：maxTargets 限制 + 选最需要");
{
  const two = { ...REPAIR, maxTargets: 2 };
  const squads = sq({ s2: [two] });
  const healer = U("h", 2, 0, 0, { hp: 100 });
  const a = U("a", 0, 10, 0, { hp: 10 });
  const b = U("b", 0, 12, 0, { hp: 50 });
  const c = U("c", 0, 14, 0, { hp: 90 });
  const units = [healer, a, b, c];

  stepSupport(units, squads, null, 0.05, null);
  ok("a 回血", a.hp > 10, String(a.hp));
  ok("b 回血", b.hp > 50, String(b.hp));
  eq("c 没轮上", c.hp, 90);
}

console.log("\n[3] 护盾：临时上限 + 光环消失后回落");
{
  const squads = sq({ s2: [CHARGER] });
  const src = U("s", 2, 0, 0, { hp: 100 });
  const a = U("a", 0, 20, 0, { hp: 100 });
  const b = U("b", 0, 24, 0, { hp: 100 });
  const units = [src, a, b];

  stepSupport(units, squads, null, 0.05, null);
  eq("护盾容量被抬到 30", a.shieldCap, 30);
  near("护盾充上去了 10×0.05", a.shield, 0.5);
  eq("第二个目标也给到（maxTargets=2）", b.shieldCap, 30);

  squads[2].p.abilities = [];                    // 支援舰没了
  stepSupport(units, squads, null, 0.05, null);
  eq("容量回落到 0", a.shieldCap, 0);
  eq("护盾被夹紧到 0", a.shield, 0);
}

console.log("\n[4] 护盾上限取 max，不叠加");
{
  const squads = sq({ s2: [{ ...CHARGER, grant: 20 }], s3: [{ ...CHARGER, grant: 60 }] });
  const a = U("a", 2, 0, 0, { hp: 100 });
  const b = U("b", 3, 10, 0, { hp: 100 });
  const v = U("v", 0, 5, 0, { hp: 100 });
  const units = [a, b, v];

  stepSupport(units, squads, null, 0.05, null);
  eq("上限是 60 而不是 80", v.shieldCap, 60);
}

console.log("\n[5] dt 封顶");
{
  const squads = sq({ s2: [REPAIR] });
  const h = U("h", 2, 0, 0, { hp: 100 });

  const v1 = U("v1", 0, 20, 0, { hp: 50 });
  stepSupport([h, v1], squads, null, 5, null);

  const v2 = U("v2", 0, 20, 0, { hp: 50 });
  stepSupport([h, v2], squads, null, MAX_SUPPORT_DT, null);

  eq("dt=5 与 dt=0.05 等价", v1.hp, v2.hp);
  near("一帧最多 8×0.05=0.4", v1.hp, 50.4);
}

console.log("\n[6] 顺序无关（两遍遍历）");
{
  const build = (rev) => {
    const squads = sq({ s2: [{ ...REPAIR, maxTargets: 3 }] });
    const list = [
      U("a", 0, 10, 0, { hp: 10 }),
      U("b", 0, 20, 0, { hp: 30 }),
      U("c", 0, 30, 0, { hp: 55 }),
      U("d", 0, 40, 0, { hp: 80 }),
      U("h", 2, 0, 0, { hp: 100 })
    ];
    const units = rev ? [...list].reverse() : list;
    for (let i = 0; i < 30; i++) stepSupport(units, squads, null, 1 / 60, null);
    const out = {};
    for (const u of units) out[u.id] = Math.round(u.hp * 1e6) / 1e6;
    return Object.keys(out).sort().map(k => k + ":" + out[k]).join(",");
  };
  const fwd = build(false);
  const rev = build(true);
  ok("正序与倒序结果一致", fwd === rev, `${fwd}  vs  ${rev}`);
}

console.log("\n[7] 目标按血量百分比，不按绝对值");
{
  const squads = sq({ s2: [{ ...REPAIR, maxTargets: 1 }] });
  const h = U("h", 2, 0, 0, { hp: 500, maxHp: 500 });
  const cruiser = U("c", 0, 30, 0, { hp: 200, maxHp: 400 });   // 50%
  const frigate = U("f", 0, 31, 0, { hp: 40, maxHp: 60 });    // 67%
  const units = [h, cruiser, frigate];

  stepSupport(units, squads, null, 0.05, null);
  ok("选了百分比更低的巡洋舰", cruiser.hp > 200 && frigate.hp === 40,
    `c=${cruiser.hp} f=${frigate.hp}`);
}

console.log("\n[8] includeSelf");
{
  const squads = sq({ s2: [{ ...REPAIR, includeSelf: true }] });
  const h = U("h", 2, 0, 0, { hp: 40 });
  stepSupport([h], squads, null, 0.05, null);
  near("能修自己", h.hp, 40.4);
}

console.log("\n[9] 满血不发特效");
{
  const squads = sq({ s2: [REPAIR] });
  const h = U("h", 2, 0, 0, { hp: 100 });
  const v = U("v", 0, 20, 0, { hp: 100 });
  const fx = [];
  stepSupport([h, v], squads, null, 0.05, fx);
  eq("fx 数量 0", fx.length, 0);
}

console.log("\n[10] 特效节流");
{
  const squads = sq({ s2: [REPAIR] });
  const h = U("h", 2, 0, 0, { hp: 100 });
  const v = U("v", 0, 20, 0, { hp: 1, maxHp: 100000 });
  const fx = [];
  run([h, v], squads, 60, 1 / 60, fx);
  const cap = Math.ceil(1 / FX_PERIOD) + 1;
  ok(`1 秒内 fx ≤ ${cap}（实际 ${fx.length}）`, fx.length <= cap);
  ok("确实发了 fx", fx.length >= 1);
  ok("fx 带 hue", fx[0].type === "supportlink" && typeof fx[0].hue === "number");
}

console.log("\n[11] 空能力 / 空单位不崩");
{
  const squads = sq();
  const u = U("a", 0, 0, 0, {});
  const fx = [];
  stepSupport([u], squads, null, 0.05, fx);
  eq("hp 不变", u.hp, 100);
  eq("无 fx", fx.length, 0);
  stepSupport([], squads, null, 0.05, null);
  stepSupport([u], [], null, 0.05, null);
  ok("空数组不崩", true);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
