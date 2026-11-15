/**
 * 阵型库（玩家可编辑的 Couzin 参数组）自检
 *   node test/formation.smoke.mjs
 *
 * 验的是：
 *   1. 阵型库是**每个 core 一份**（reset 不清空、互不污染）
 *   2. 改参数会夹进合法区间，并立刻摊到"正在用它的那些小队"上
 *   3. 新建 / 复制 / 改名 / 删除的边界
 *   4. 快照给编辑界面的字段是齐的（13 个参数、分组、usedBy）
 */

import { GameCore } from "../src/core/core.js";
import { makeParams } from "../src/core/sim/squad-layer.js";
import { FORMATIONS, FORMATION_KEYS, FORMATION_PARAM_KEYS, FORMATION_PARAM_GROUPS } from "../src/core/data/formation-templates.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
                          : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));
const eq = (n, a, b) => ok(n, Object.is(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const mk = () => new GameCore({ width: 1200, height: 700, seed: 5 });

console.log("\n[1] 参数元数据与实际键一致");
{
  const specs = new Set(FORMATION_PARAM_KEYS);
  ok("面板里每一项都在 FORMATION_KEYS 里",
    FORMATION_PARAM_KEYS.every(k => FORMATION_KEYS.includes(k)),
    FORMATION_PARAM_KEYS.filter(k => !FORMATION_KEYS.includes(k)).join(","));
  ok("FORMATION_KEYS 里每一项都有面板元数据",
    FORMATION_KEYS.every(k => specs.has(k)),
    FORMATION_KEYS.filter(k => !specs.has(k)).join(","));
  eq("参数总数 13", FORMATION_PARAM_KEYS.length, 13);
  eq("分组 4 组", FORMATION_PARAM_GROUPS.length, 4);
  ok("每一项都有 name / desc / 上下限",
    FORMATION_PARAM_GROUPS.every(g => g.items.every(i =>
      i.name && i.desc && Number.isFinite(i.min) && Number.isFinite(i.max) && i.max > i.min)));
}

console.log("\n[2] 阵型库是每个 core 一份");
{
  const a = mk(), b = mk();
  ok("只剩 1 个内置阵型", Object.keys(a.formations).length === 1, String(Object.keys(a.formations).length));
  a.command({ type: "editFormation", formId: "form.default", key: "sepForce", value: 200 });
  eq("A 改了", a.formations["form.default"].p.sepForce, 200);
  eq("B 没被污染", b.formations["form.default"].p.sepForce, FORMATIONS["form.default"].p.sepForce);

  a.command({ type: "reset", width: 1200, height: 700, seed: 5 });
  eq("reset 之后改动还在（设计数据不清空）", a.formations["form.default"].p.sepForce, 200);
}

console.log("\n[3] 改参数：夹值 + 立刻生效");
{
  const core = mk();
  const sqId = core.build.squads.find(b => b.form === "form.default" && !b.loose).id;

  const r = core.command({ type: "editFormation", formId: "form.default", key: "sepForce", value: 9999 });
  ok("超上限被夹住", r.ok && r.value === 600, JSON.stringify(r));
  eq("core 里存的是夹过的值", core.formations["form.default"].p.sepForce, 600);
  eq("正在用它的队立刻跟着变", core.squads[sqId].p.sepForce, 600);
  ok("报告了影响了几支小队", r.applied >= 1, String(r.applied));

  const bad = core.command({ type: "editFormation", formId: "form.default", key: "nope", value: 1 });
  ok("非法键被拒", bad.ok === false, JSON.stringify(bad));

  const nan = core.command({ type: "editFormation", formId: "form.default", key: "cohForce", value: NaN });
  ok("NaN 不会写进去", nan.ok === true && Number.isFinite(core.formations["form.default"].p.cohForce),
    String(core.formations["form.default"].p.cohForce));

  const batch = core.command({
    type: "editFormationBatch", formId: "form.default",
    p: { sepRadius: 999, alignRadius: 40, bogus: 1 }
  });
  ok("批量改成功", batch.ok === true, JSON.stringify(batch));
  eq("批量也夹值", core.formations["form.default"].p.sepRadius, 80);
  eq("合法值照写", core.formations["form.default"].p.alignRadius, 40);
  ok("未知键被忽略", core.formations["form.default"].p.bogus === undefined);
}

console.log("\n[4] 新建 / 复制 / 改名");
{
  const core = mk();
  const created = core.command({ type: "createFormation", name: "侧翼包抄" });
  ok("新建成功", created.ok === true && !!created.formId, JSON.stringify(created));
  const f = core.formations[created.formId];
  ok("自建阵型不是内置", f && f.builtin === false);
  eq("13 个参数都齐", FORMATION_KEYS.filter(k => f.p[k] === undefined).length, 0);
  eq("名字写进去了", f.name, "侧翼包抄");

  const dup = core.command({ type: "duplicateFormation", formId: "form.default" });
  ok("复制成功", dup.ok === true && dup.formId !== "form.default", JSON.stringify(dup));
  eq("副本参数与原阵型一致",
    JSON.stringify(core.formations[dup.formId].p),
    JSON.stringify(core.formations["form.default"].p));
  ok("副本 id 不与已有冲突", !core.formations[dup.formId] || dup.formId !== created.formId);

  eq("改名成功", core.command({ type: "renameFormation", formId: dup.formId, name: "密集·改" }).ok, true);
  eq("名字变了", core.formations[dup.formId].name, "密集·改");
  ok("空名字被拒", core.command({ type: "renameFormation", formId: dup.formId, name: "  " }).ok === false);
  ok("超长名字被拒", core.command({ type: "renameFormation", formId: dup.formId, name: "x".repeat(40) }).ok === false);
}

console.log("\n[5] 删除的边界");
{
  const core = mk();
  ok("内置阵型不能删",
    core.command({ type: "deleteFormation", formId: "form.default" }).ok === false);

  const created = core.command({ type: "createFormation", name: "临时" });
  eq("没人用的自建阵型可以删", core.command({ type: "deleteFormation", formId: created.formId }).ok, true);
  ok("删完就没了", core.formations[created.formId] === undefined);

  // 挂进一个小队的阵型列表后不能删
  const c2 = core.command({ type: "createFormation", name: "被引用" });
  const b = core.build.squads.find(x => !x.loose);
  b.formations = [...(b.formations || []), c2.formId];
  const del = core.command({ type: "deleteFormation", formId: c2.formId });
  ok("被小队引用时拒绝删除", del.ok === false, JSON.stringify(del));

  ok("未知阵型删除被拒", core.command({ type: "deleteFormation", formId: "nope" }).ok === false);
}

console.log("\n[6] 快照给编辑界面的字段");
{
  const core = mk();
  const snap = core.snapshot();
  ok("有 formationList", Array.isArray(snap.formationList) && snap.formationList.length === 1);
  const f = snap.formationList.find(x => x.id === "form.default");
  ok("带 p（13 个参数）", f && Object.keys(f.p).length >= 13, String(f && Object.keys(f.p).length));
  ok("带 builtin / usedBy", f && typeof f.builtin === "boolean" && Number.isFinite(f.usedBy),
    JSON.stringify({ b: f && f.builtin, u: f && f.usedBy }));
  ok("有 formationParams 分组",
    Array.isArray(snap.formationParams) && snap.formationParams.length === 4);
  const flat = snap.formationParams.flatMap(g => g.items.map(i => i.k));
  eq("分组里的键数 = 13", flat.length, 13);
  ok("快照里的阵型是副本（改它不影响 core）", (() => {
    f.p.sepForce = -1;
    return core.formations["form.default"].p.sepForce !== -1;
  })());
}

console.log("\n[7] 没有阵型的小队（散兵池）默认值必须等于 form.default");
{
  const d = FORMATIONS["form.default"].p;

  const p = makeParams();
  const diff = FORMATION_KEYS.filter(k => p[k] !== d[k]);
  ok("P_DEFS 的 13 个移动参数与 form.default 逐项相等", diff.length === 0,
    diff.map(k => `${k}: ${p[k]} vs ${d[k]}`).join("; "));

  // 散兵池建队时 form === null，spawnAll 不会 applyFormation，只能靠默认值
  const core = mk();
  const pool = core.poolOf(0);
  const bad = FORMATION_KEYS.filter(k => core.squads[pool].p[k] !== d[k]);
  ok("散兵池的 sq.p 与编队队一致", bad.length === 0, bad.join(","));

  // 同一条命令下稳态速度应当同量级（曾经差 2.5 倍）
  const reg = 0;
  core.command({ type: "setGoal", squadIds: [reg, pool], x: 1500, y: 600 });
  const spd = id => {
    const a = core.units.filter(u => u.squad === id);
    return a.length ? a.reduce((s, u) => s + Math.hypot(u.vx, u.vy), 0) / a.length : 0;
  };
  for (let f = 0; f < 120; f++) core.step(1 / 60);
  const sr = spd(reg), sl = spd(pool);
  ok("2 秒后两者平均速度接近（比值 < 1.6）",
    Math.max(sr, sl) / Math.max(1e-6, Math.min(sr, sl)) < 1.6,
    `编队队 ${sr.toFixed(1)} / 散兵 ${sl.toFixed(1)}`);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
