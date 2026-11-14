/**
 * 力模型（质量速度模型）逻辑自检
 *   node test/force-model.smoke.mjs
 *
 * 迁移期间 **只验证算法逻辑正确**，不验证任何"数字像不像旧模型"。
 * 参数调优在迁移完成之后单独做（见设计文档 §3.1.2 的说明）。
 *
 * 验的是这九条性质：
 *   1. 分离权重 w(gap) 的形状与封顶
 *   2. 积分：质量、阻尼、速度安全阀
 *   3. 朝向向量：单位长度、静止时保持
 *   4. 分离是全局的（敌我之间也分离）
 *   5. 对齐 / 凝聚只对亲和邻居（正规队只认同队；散兵认同阵营）
 *   6. 三区**互斥**：进了分离区就不再对齐 / 凝聚
 *   7. 力是**相加**的（寻敌 + 命令 同向时叠加），不做配平
 *   8. 没有 MAX_ACCEL 那种加速度上限
 *   9. 同输入同输出（确定性）
 */

import { makeParams } from "../src/core/sim/squad-layer.js";
import { stepUnits, SPD } from "../src/core/sim/group-layer.js";
import {
  sepWeight, integrateUnit, updateHeading,
  SEP_MAX_WEIGHT, SEP_MIN_GAP
} from "../src/core/sim/force-model.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
                          : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ------------------------------------------------------------------
// 造数据的小工具
// ------------------------------------------------------------------

const W = 4000, H = 4000;          // 远离边界，免得边界软推干扰
const DT = 1 / 60;

function G(over = {}) {
  return { damping: 1.5, mass: 1, boostSpeed: 0, boostForce: 0, maxSpeedFactor: 1.8, softWall: false, ...over };
}

function mkSquad(over = {}) {
  return {
    id: 0, faction: 0, loose: false,
    p: { ...makeParams(), ...(over.p || {}) },
    goal: null, target: null,
    cx: 0, cy: 0, cn: 0,
    ...over
  };
}

function mkUnit(x, y, over = {}) {
  return { x, y, vx: 0, vy: 0, squad: 0, hx: 1, hy: 0, radius: 0, mass: 1, alpha: 0, cAll: 0, ...over };
}

/** 只跑一步，返回单位 */
function oneStep(units, squads, g = G()) {
  stepUnits(units, squads, { ...G(), ...g }, DT, W, H);
  return units;
}

console.log("\n[1] 分离权重 w(gap) 的形状与封顶");
ok("gap = sepRadius 时 w = 1", near(sepWeight(22, 22), 1));
ok("gap 减半时 w = 4", near(sepWeight(11, 22), 4));
ok("gap 趋于 0 时被 gmin 兜住并封顶", near(sepWeight(0, 22), SEP_MAX_WEIGHT));
ok("封顶值确实是 25", SEP_MAX_WEIGHT === 25, String(SEP_MAX_WEIGHT));
ok("gmin = 1", SEP_MIN_GAP === 1, String(SEP_MIN_GAP));
ok("gap 缩小 w 单调变大", sepWeight(20, 22) < sepWeight(10, 22));

console.log("\n[2] 积分：质量 / 阻尼 / 速度安全阀");
{
  const a = mkUnit(0, 0), b = mkUnit(0, 0);
  a.mass = 1; b.mass = 2;
  integrateUnit(a, 100, 0, G({ damping: 0 }), DT, SPD);
  integrateUnit(b, 100, 0, G({ damping: 0 }), DT, SPD);
  ok("mass = 2 的加速度是 mass = 1 的一半", near(a.vx, 2 * b.vx, 1e-9), `${a.vx} vs ${b.vx}`);
}
{
  const u = mkUnit(0, 0, { vx: 100, vy: 0 });
  integrateUnit(u, 0, 0, G({ damping: 1.5 }), DT, 1e9);
  ok("无外力时速度按 e^(−λ·dt) 衰减", near(u.vx, 100 * Math.exp(-1.5 * DT), 1e-9), String(u.vx));
}
{
  const u = mkUnit(0, 0);
  integrateUnit(u, 1e6, 0, G(), DT, SPD);
  ok("安全阀把速度夹在 SPD × maxSpeedFactor", near(Math.hypot(u.vx, u.vy), SPD * 1.8, 1e-6),
    String(Math.hypot(u.vx, u.vy)));
}

console.log("\n[3] 朝向向量");
{
  const u = mkUnit(0, 0, { vx: 3, vy: 4 });
  updateHeading(u);
  ok("朝向是单位向量", near(Math.hypot(u.hx, u.hy), 1, 1e-12), `${u.hx},${u.hy}`);
  ok("朝向与速度同向", near(u.hx, 0.6, 1e-12) && near(u.hy, 0.8, 1e-12), `${u.hx},${u.hy}`);

  const s = mkUnit(0, 0, { vx: 0, vy: 0, hx: 0, hy: 1 });
  updateHeading(s);
  ok("速度为零时保持上一次朝向", s.hx === 0 && s.hy === 1, `${s.hx},${s.hy}`);
}

console.log("\n[4] 分离是全局的：敌我之间也分离");
{
  const a = mkUnit(0, 0);
  const b = mkUnit(10, 0, { squad: 1 });
  const sq0 = mkSquad({ id: 0, faction: 0, p: { sepRadius: 24, sepForce: 144 } });
  const sq1 = mkSquad({ id: 1, faction: 1, p: { sepRadius: 24, sepForce: 144 } });
  oneStep([a, b], [sq0, sq1]);
  ok("敌人在分离区里会把自己推开", a.vx < 0, String(a.vx));
  ok("自己也会把敌人推开", b.vx > 0, String(b.vx));
}

console.log("\n[5] 对齐 / 凝聚只对亲和邻居");
{
  // 对齐：同队邻居在 (sep, align] 之间，朝向 +y → 自己被拉向 +y
  const a = mkUnit(0, 0);
  const b = mkUnit(40, 0, { hx: 0, hy: 1 });
  const sq = mkSquad({ p: { sepRadius: 24, alignRadius: 52, sepForce: 0, alignForce: 91 } });
  oneStep([a, b], [sq]);
  ok("同队邻居能触发对齐", a.vy > 0, String(a.vy));

  // 同样的位置，但邻居是敌人 → 对齐不该发生（战斗组半径设 0，排除干扰）
  const a2 = mkUnit(0, 0);
  const b2 = mkUnit(40, 0, { hx: 0, hy: 1, squad: 1 });
  const sq0 = mkSquad({ id: 0, faction: 0, p: { sepRadius: 24, alignRadius: 52, r4: 0, r5: 0, sepForce: 0, alignForce: 91 } });
  const sq1 = mkSquad({ id: 1, faction: 1, p: { sepRadius: 24, alignRadius: 52, r4: 0, r5: 0, sepForce: 0, alignForce: 91 } });
  oneStep([a2, b2], [sq0, sq1]);
  ok("敌人不触发对齐", near(a2.vy, 0), String(a2.vy));

  // 凝聚：邻居在 (align, coh] 之间
  const c = mkUnit(0, 0);
  const d = mkUnit(70, 0, { hx: 0, hy: 1 });
  const sqc = mkSquad({ p: { sepRadius: 24, alignRadius: 52, cohRadius: 96, sepForce: 0, alignForce: 0, cohForce: 110 } });
  oneStep([c, d], [sqc]);
  ok("同队邻居能触发凝聚（朝邻居方向）", c.vx > 0, String(c.vx));

  // 散兵：认同阵营（不同队、同阵营）
  const e = mkUnit(0, 0, { squad: 0 });
  const f = mkUnit(40, 0, { hx: 0, hy: 1, squad: 1 });
  const l0 = mkSquad({ id: 0, faction: 0, loose: true, p: { sepRadius: 24, alignRadius: 52, sepForce: 0, alignForce: 91 } });
  const l1 = mkSquad({ id: 1, faction: 0, loose: true, p: { sepRadius: 24, alignRadius: 52, sepForce: 0, alignForce: 91 } });
  oneStep([e, f], [l0, l1]);
  ok("散兵对同阵营（不同队）也算亲和", e.vy > 0, String(e.vy));
}

console.log("\n[6] 三区互斥：进了分离区就不再对齐 / 凝聚");
{
  const base = { sepRadius: 24, alignRadius: 52, cohRadius: 96, sepForce: 144 };

  const run = (p) => {
    const a = mkUnit(0, 0);
    const b = mkUnit(3, 0, { hx: 0, hy: 1 });
    oneStep([a, b], [mkSquad({ p: { ...base, ...p } })]);
    return { vx: a.vx, vy: a.vy };
  };

  const only = run({ alignForce: 0, cohForce: 0 });
  const all = run({ alignForce: 91, cohForce: 110 });

  ok("邻居在分离区里时，对齐/凝聚完全不参与",
    near(only.vx, all.vx, 1e-12) && near(only.vy, all.vy, 1e-12),
    `${only.vx},${only.vy} vs ${all.vx},${all.vy}`);
}

console.log("\n[7] 力是相加的：寻敌 + 命令 同向叠加（不做配平）");
{
  const run = (withSeek) => {
    const a = mkUnit(0, 0);
    const sq = mkSquad({
      id: 0, faction: 0,
      goal: { x: 1000, y: 0 },
      target: withSeek ? { x: 1000, y: 0 } : null,
      p: { commandForce: 127, seekForce: 144, sepForce: 0, alignForce: 0, cohForce: 0, r4: 50, r5: 300, arriveR: 46 }
    });
    oneStep([a], [sq]);
    return a.vx;
  };
  const cmdOnly = run(false);
  const both = run(true);
  ok("命令力单独生效", cmdOnly > 0, String(cmdOnly));
  ok("寻敌力与命令力同向时速度更大", both > cmdOnly + 1e-9, `${cmdOnly} vs ${both}`);
  ok("两者是相加而不是取最大（约 271 / 质量 / 阻尼）",
    both > cmdOnly * 1.9, `cmdOnly=${cmdOnly.toFixed(2)} both=${both.toFixed(2)}`);
}

console.log("\n[8] 没有 MAX_ACCEL 那种加速度上限");
{
  // 一个贴脸的邻居：分离权重顶到 25，力 ≈ 25 × sepForce
  const a = mkUnit(0, 0);
  const b = mkUnit(0.5, 0, { hx: 0, hy: 1 });
  const sq = mkSquad({ p: { sepRadius: 24, sepForce: 144 } });
  oneStep([a, b], [sq]);
  const dv = Math.hypot(a.vx, a.vy);
  // 旧模型的 MAX_ACCEL = 430，单步最多改变 430/60 ≈ 7.2 px/s
  ok("单步 Δv 可以远超旧模型的 MAX_ACCEL·dt", dv > 7.2, `${dv.toFixed(1)} px/s`);
}

console.log("\n[9] 每鸟半径进入分离判据（gap = 圆心距 − 半径和）");
{
  const sep = (rA, rB, d) => {
    const a = mkUnit(0, 0, { radius: rA });
    const b = mkUnit(d, 0, { radius: rB });
    const sq = mkSquad({ p: { sepRadius: 24, sepForce: 144 } });
    oneStep([a, b], [sq]);
    return Math.abs(a.vx) > 1e-9;
  };
  ok("半径 0/0、圆心距 30 > 24 → 不分离", !sep(0, 0, 30));
  ok("半径 6/6、圆心距 30 → gap 18 ≤ 24 → 分离", sep(6, 6, 30));
  ok("半径 6/6、圆心距 40 → gap 28 > 24 → 不分离", !sep(6, 6, 40));
  ok("大个体挨得远也进分离区（13/13、圆心距 45 → gap 19）", sep(13, 13, 45));
}

console.log("\n[10] 低速助推无条件生效：没有命令信标时集群自己游走（设计如此）");
{
  // 这是在守一条**设计意图**，不是修 bug：
  // 无命令时每艘船沿各自朝向维持 ~boostForce/damping 的巡航速度，
  // 于是集群会自己随机游走、慢慢散开。**这是要的行为，不要加"有命令才助推"的门。**
  const a = mkUnit(0, 0, { hx: 1, hy: 0 });
  const sq = mkSquad({ id: 0, faction: 0, goal: null });
  for (let i = 0; i < 120; i++) oneStep([a], [sq], { boostSpeed: 60, boostForce: 100 });
  const moved = Math.hypot(a.x, a.y);
  ok("无命令信标时也会自己走起来（集群游走）", moved > 50, `移动了 ${moved.toFixed(1)} px`);
  // 助推只在 speed < boostSpeed 时生效，所以稳态会贴着阈值走：略低于 60
  const sp = Math.hypot(a.vx, a.vy);
  ok("游走速度贴着 boostSpeed（略低于 60）", sp > 55 && sp <= 61, String(sp.toFixed(2)));

  // 有命令时助推同样生效
  const b = mkUnit(0, 0, { hx: 1, hy: 0 });
  const sq2 = mkSquad({ id: 0, faction: 0, goal: { x: 1000, y: 0 } });
  oneStep([b], [sq2], { boostSpeed: 60, boostForce: 100 });
  ok("有命令信标时助推同样生效", b.vx > 0, String(b.vx));
}

console.log("\n[11] 确定性：同输入同输出");
{
  const run = () => {
    const a = mkUnit(0, 0);
    const b = mkUnit(10, 0, { squad: 1 });
    const sq0 = mkSquad({ id: 0, faction: 0 });
    const sq1 = mkSquad({ id: 1, faction: 1 });
    for (let i = 0; i < 30; i++) oneStep([a, b], [sq0, sq1]);
    return `${a.x.toFixed(9)},${a.y.toFixed(9)},${b.x.toFixed(9)},${b.y.toFixed(9)}`;
  };
  ok("两次跑出完全相同的轨迹", run() === run());
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
