/**
 * 船图接线自检（不加载图片，只验数据接线）
 *   node test/skin.smoke.mjs
 *
 * 船图的选择链必须是：
 *   hull-templates.sprite  →  compileShip 的 rt.sprite  →  initUnit 的 u.skin  →  渲染层挑图集与帧
 * 任何一环断了，渲染层都会退回"按属性哈希"，表现为全场的船随机撞图 —— 而不会报错。
 * 所以这里逐环验一遍。
 */

import { GameCore } from "../src/core/core.js";
import { compileShip } from "../src/core/data/ship-template.js";
import { getHull } from "../src/core/data/hull-templates.js";
import { initUnit } from "../src/core/sim/defense-system.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
                          : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));

console.log("\n[1] 船体模板都配了 sprite");
{
  for (const id of ["hull.falcon", "hull.bulwark", "hull.hammer", "hull.citadel"]) {
    const h = getHull(id);
    ok(`${id} 用 frigate 图集`, h.sprite && h.sprite.sheet === "frigate",
      JSON.stringify(h.sprite));
    ok(`${id} 帧下标合法`, Number.isInteger(h.sprite.index) && h.sprite.index >= 0 && h.sprite.index < 64,
      String(h.sprite && h.sprite.index));
  }
  const ark = getHull("hull.ark");
  ok("母舰用 mothership 图集", ark.sprite && ark.sprite.sheet === "mothership",
    JSON.stringify(ark.sprite));
  ok("母舰帧下标落在 4×4 图集内",
    ark.sprite.index >= 0 && ark.sprite.index < 16, String(ark.sprite.index));
}

console.log("\n[2] 四种护卫舰外壳用的是不同的帧");
{
  const idx = ["hull.falcon", "hull.bulwark", "hull.hammer", "hull.citadel"]
    .map(id => getHull(id).sprite.index);
  ok("四个下标互不相同", new Set(idx).size === 4, idx.join(","));
}

console.log("\n[3] compileShip 把 sprite 抄进运行时规格");
{
  const core = new GameCore({ width: 1000, height: 700, seed: 3 });
  const rt = core.runtimeOf("ship.std_falcon");
  ok("rt.sprite 存在", !!rt.sprite, JSON.stringify(rt && rt.sprite));
  ok("rt.sprite.sheet = frigate", rt.sprite && rt.sprite.sheet === "frigate");
}

console.log("\n[4] initUnit 把它写进 u.skin（渲染层只认这个）");
{
  const core = new GameCore({ width: 1000, height: 700, seed: 3 });
  let bad = 0, missing = 0;
  for (const u of core.units) {
    if (!u.skin) { missing++; continue; }
    if (!/^[a-z]+#\d+$/.test(u.skin)) bad++;
  }
  ok("每个单位都有 skin", missing === 0, `${missing} 个缺失`);
  ok("skin 形如 图集名#下标", bad === 0, `${bad} 个格式不对`);

  // 混编队里两种船必须拿到不同 skin
  const wall = core.build.squads.find(b => !b.loose && b.template === "squad.wall");
  const skins = new Set();
  for (const u of core.units) if (wall && u.squad === wall.id) skins.add(u.skin);
  ok("混编队里出现了 2 种 skin", skins.size === 2, [...skins].join(","));
}

console.log("\n[5] 母舰外壳走单独图集");
{
  const rt = compileShip({
    hull: "hull.ark", name: "t", fit: { weapons: {}, plugins: {} }
  });
  const u = { x: 0, y: 0, vx: 0, vy: 0, squad: 0 };
  initUnit(u, rt);
  ok("母舰 skin = mothership#0", u.skin === "mothership#0", String(u.skin));
  ok("母舰半径仍是 40（没被贴图影响）", u.radius === 40, String(u.radius));
}

console.log("\n[6] 三个界面共用同一张表（core/data/sprite-atlas.js）");
{
  const { frameOf, skinOf, parseSkin, cellOf, hashFrame, frameCount } = await import("../src/core/data/sprite-atlas.js");

  ok("frameOf 认 {sheet,index}", JSON.stringify(frameOf({ sheet: "frigate", index: 12 })) ===
    JSON.stringify({ sheet: "frigate", index: 12 }));
  ok("frameOf 也认旧写法 {frame:'frigate_13'}（尾部数字 - 1）",
    frameOf({ sheet: "frigate", frame: "frigate_13" }).index === 12,
    String(frameOf({ sheet: "frigate", frame: "frigate_13" }).index));
  ok("frameOf 遇到没配的返回 null", frameOf(null) === null && frameOf({}) === null);

  const skin = skinOf({ sheet: "frigate", index: 12 });
  ok("skinOf → frigate#12", skin === "frigate#12", String(skin));
  ok("parseSkin 能转回来", JSON.stringify(parseSkin(skin)) === JSON.stringify({ sheet: "frigate", index: 12 }));
  ok("parseSkin 拒绝越界", parseSkin("frigate#999") === null);
  ok("parseSkin 拒绝未知图集", parseSkin("nope#0") === null);

  const cell = cellOf({ sheet: "frigate", index: 12 });
  ok("帧下标 12 → 第 1 行第 4 列", cell.col === 4 && cell.row === 1, `${cell.col},${cell.row}`);
  ok("母舰图集是 4 列", cellOf({ sheet: "mothership", index: 5 }).col === 1);
  ok("两个图集帧数正确", frameCount("frigate") === 64 && frameCount("mothership") === 16);

  // 每个船体都能被"构筑界面那套"解析出格子（否则那两个界面会退化成随机图）
  for (const id of ["hull.falcon", "hull.bulwark", "hull.hammer", "hull.citadel", "hull.ark"]) {
    const f = frameOf(getHull(id).sprite);
    ok(`${id} 在构筑界面也能解析出格子`, !!f, JSON.stringify(getHull(id).sprite));
  }

  ok("兜底哈希是稳定的", JSON.stringify(hashFrame("hull.x")) === JSON.stringify(hashFrame("hull.x")));
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
