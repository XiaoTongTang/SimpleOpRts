/**
 * 墙体硬碰撞 + 地图平滑（格角倒角）自检
 *   node test/wall.smoke.mjs
 *
 * 验的是：
 *   1. 倒角几何：各种格型下的顶点数与剩余面积（沙盒那套会退化的地方必须不退化）
 *   2. 孤立单格**必须挡船**（沙盒原样会塌成一点 → 完全无碰撞）
 *   3. 穿透：全宽墙带 / 实心方块（含凸角），半径 6 / 9 / 13 三档，600 帧穿透帧数 = 0
 *   4. 世界边框：推到边上停在 radius 处，不出现"穿出去再弹回来"
 *   5. 沿墙滑：只去法向速度，切向保留
 *   6. 出生点：不会落在墙里
 *   7. 确定性
 */

import { MapGrid } from "../src/core/map.js";
import {
  getChamferedCellPolygon, getWallChamferMask, polygonArea, CHAMFER_DEPTH_CELLS
} from "../src/core/sim/wall-geometry.js";
import {
  collectCircleWallContacts, findDeepestContact, moveUnitWithWalls,
  resolveUnitWall, isBlockedCircle, findFreeSpawnPoint
} from "../src/core/sim/wall-collision.js";
import { seedRng, rand } from "../src/core/sim/rng.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
                          : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));

const C = 8;

function makeMap(cols, rows, cells, name = "test") {
  const walls = new Uint8Array(cols * rows);
  for (const [x, y] of cells) walls[y * cols + x] = 1;
  return new MapGrid({ width: cols * C, height: rows * C, cols, rows, cellSize: C, walls, name });
}

/** 实心矩形块 */
function blockCells(x0, y0, w, h) {
  const out = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.push([x, y]);
  return out;
}

const full = C * C;
const pct = a => (a / full * 100).toFixed(0) + "%";

console.log("\n[1] 倒角几何：切进深度与「暴露角」判定");
ok("切进深度默认是半格（不改的话薄墙会碎）", CHAMFER_DEPTH_CELLS === 0.5, String(CHAMFER_DEPTH_CELLS));
{
  const m = makeMap(20, 20, blockCells(5, 5, 3, 3));
  ok("厚墙内部格 mask = 0（完全不切）", getWallChamferMask(m, 6, 6) === 0);
  ok("厚墙内部格面积 100%", Math.abs(polygonArea(getChamferedCellPolygon(m, 6, 6)) - full) < 1e-6);
  ok("3×3 左上角格只切 1 个角", getWallChamferMask(m, 5, 5) === 1, String(getWallChamferMask(m, 5, 5)));
  ok("3×3 左上角格剩 87.5%",
    Math.abs(polygonArea(getChamferedCellPolygon(m, 5, 5)) - full * 0.875) < 0.01,
    pct(polygonArea(getChamferedCellPolygon(m, 5, 5))));
  ok("非墙格返回 null", getChamferedCellPolygon(m, 0, 0) === null);
}

console.log("\n[2] 倒角不退化（沙盒那套的三个坑）");
{
  // 2×2 方块：沙盒原样会变成一个菱形（50%）；半格倒角之后只削掉四角
  const m2 = makeMap(20, 20, blockCells(5, 5, 2, 2));
  let area2 = 0;
  for (const [x, y] of blockCells(5, 5, 2, 2)) area2 += polygonArea(getChamferedCellPolygon(m2, x, y));
  ok("2×2 方块不是菱形（总面积 ≥ 80%）", area2 >= 4 * full * 0.8, pct(area2 / 4));

  // 1 格厚墙的端头：沙盒原样塌成三角形（25%），现在应该是 75%
  const m1 = makeMap(20, 20, blockCells(4, 5, 3, 1));
  const endArea = polygonArea(getChamferedCellPolygon(m1, 4, 5));
  ok("1 格厚墙端头剩 75%（不是三角形）",
    Math.abs(endArea - full * 0.75) < 0.01, pct(endArea));

  // L 形拐角
  const m3 = makeMap(20, 20, [[5, 5], [5, 6], [5, 7], [6, 7], [7, 7]]);
  const cornerArea = polygonArea(getChamferedCellPolygon(m3, 5, 5));
  ok("L 形拐角剩 75%（不是被啃掉 3/4）",
    Math.abs(cornerArea - full * 0.75) < 0.01, pct(cornerArea));

  // 孤立单格：沙盒原样四角全切 → 塌成一点 → 返回 null → 船直接穿过去
  const m4 = makeMap(20, 20, [[10, 10]]);
  const iso = getChamferedCellPolygon(m4, 10, 10);
  ok("孤立单格返回完整方块（不是 null、不是一点）",
    iso !== null && iso.length === 4, iso ? String(iso.length) : "null");
  ok("孤立单格面积 100%", Math.abs(polygonArea(iso) - full) < 1e-6, pct(polygonArea(iso)));
}

console.log("\n[3] 孤立单格必须挡船（沙盒原样的硬 bug）");
{
  const m = makeMap(20, 20, [[10, 10]]);
  // 从正上方朝它飞过去
  const u = { x: 10 * C + C / 2, y: 10 * C - 40, vx: 0, vy: 200 };
  let minDist = Infinity;
  for (let f = 0; f < 300; f++) {
    moveUnitWithWalls(m, u, 6, 1 / 60);
    minDist = Math.min(minDist, Math.hypot(u.x - (10 * C + C / 2), u.y - (10 * C + C / 2)));
  }
  ok("船被孤立的墙格挡住（离格心 ≥ 半径）", minDist >= 6 - 0.5, `最近距离 ${minDist.toFixed(2)}`);
}

console.log("\n[4] 穿透：全宽墙带 / 实心方块，三档半径，600 帧");
{
  function stress2(map, seeds, radius, forceX, forceY, frames = 600) {
    const units = seeds.map(s => ({ x: s.x, y: s.y, vx: 0, vy: 0 }));
    let framesWithPenetration = 0, maxDepth = 0;
    const tmp = [];
    for (let f = 0; f < frames; f++) {
      for (const u of units) {
        u.vx += forceX * (1 / 60);
        u.vy += forceY * (1 / 60);
        moveUnitWithWalls(map, u, radius, 1 / 60);
      }
      let any = false;
      for (const u of units) {
        collectCircleWallContacts(map, u.x, u.y, radius, tmp);
        const d = findDeepestContact(tmp);
        if (d && d.depth > 1e-6) { any = true; maxDepth = Math.max(maxDepth, d.depth); }
      }
      if (any) framesWithPenetration++;
    }
    return { framesWithPenetration, maxDepth };
  }

  // (a) 全宽墙带：rows 10–11 全封
  const bandMap = makeMap(50, 20, blockCells(0, 10, 50, 2));
  const bandSeeds = [];
  for (let i = 0; i < 12; i++) bandSeeds.push({ x: 20 + i * 30, y: 40 });

  // (b) 实心方块 12×12，含 4 个凸角
  const blockMap = makeMap(50, 40, blockCells(18, 14, 12, 12));
  const blockSeeds = [
    { x: 100, y: 60 }, { x: 200, y: 60 }, { x: 300, y: 60 },
    { x: 60, y: 150 }, { x: 340, y: 150 },
    { x: 100, y: 300 }, { x: 200, y: 300 }, { x: 300, y: 300 }
  ];

  for (const r of [6, 9, 13]) {
    const a = stress2(bandMap, bandSeeds, r, 0, 400);
    ok(`全宽墙带 r=${r}：穿透帧数 = 0`, a.framesWithPenetration === 0,
      `${a.framesWithPenetration} 帧，最大穿透 ${a.maxDepth.toFixed(2)}px`);
    const b = stress2(blockMap, blockSeeds, r, 150, 150);
    ok(`实心方块 r=${r}：穿透帧数 = 0`, b.framesWithPenetration === 0,
      `${b.framesWithPenetration} 帧，最大穿透 ${b.maxDepth.toFixed(2)}px`);
  }
}

console.log("\n[5] 世界边框：停在 radius 处");
{
  const m = makeMap(40, 30, []);
  for (const r of [6, 13]) {
    const u = { x: 20 * C, y: 15 * C, vx: -500, vy: 0 };
    for (let f = 0; f < 120; f++) moveUnitWithWalls(m, u, r, 1 / 60);
    ok(`r=${r} 贴着左边框停在 x = radius`, Math.abs(u.x - r) < 0.5, `x=${u.x.toFixed(2)}`);
  }
}

console.log("\n[6] 沿墙滑：只去法向速度，切向保留");
{
  const m = makeMap(40, 30, blockCells(0, 10, 40, 2));   // 横墙在中部
  const u = { x: 20 * C, y: 9 * C - 6, vx: 120, vy: 300 };  // 斜着压向墙
  for (let f = 0; f < 60; f++) moveUnitWithWalls(m, u, 6, 1 / 60);
  ok("法向速度被清掉（不会一直往下压）", Math.abs(u.vy) < 1, `vy=${u.vy.toFixed(2)}`);
  ok("切向速度保留（沿墙滑行）", u.vx > 100, `vx=${u.vx.toFixed(2)}`);
}

console.log("\n[7] 出生点：不会落在墙里");
{
  seedRng(4242);
  const m = makeMap(40, 30, blockCells(10, 10, 20, 10));
  let bad = 0;
  for (let i = 0; i < 200; i++) {
    const p = findFreeSpawnPoint(m, 240, 160, 80, 6, rand);
    if (!p) { bad++; continue; }
    if (isBlockedCircle(m, p.x, p.y, 6)) bad++;
  }
  ok("200 次采样全部落在空地", bad === 0, `${bad} 次失败`);

  // 正中心就在墙里时也必须能找出去
  const p = findFreeSpawnPoint(m, 20 * C, 15 * C, 120, 6, rand);
  ok("原点在墙里时也能找到空地", p !== null && !isBlockedCircle(m, p.x, p.y, 6),
    p ? `(${p.x.toFixed(0)},${p.y.toFixed(0)})` : "null");
}

console.log("\n[8] 确定性：同输入同输出");
{
  const run = () => {
    seedRng(99);
    const m = makeMap(40, 30, blockCells(10, 10, 20, 10));
    const u = { x: 100, y: 200, vx: 130, vy: -90 };
    for (let f = 0; f < 300; f++) moveUnitWithWalls(m, u, 6, 1 / 60);
    return `${u.x.toFixed(9)},${u.y.toFixed(9)}`;
  };
  ok("两次跑出完全相同的轨迹", run() === run());
}

console.log("\n[9] 端到端：带墙地图跑一局，没有人穿墙");
{
  const { GameCore } = await import("../src/core/core.js");
  const cols = 120, rows = 80, cell = 8;
  const cells = [];
  // 竖墙 x=40..41，y=0..50（留出下方通道）；再放一块 6×6 的障碍
  for (let y = 0; y < 50; y++) { cells.push([40, y]); cells.push([41, y]); }
  for (let y = 20; y < 26; y++) for (let x = 70; x < 76; x++) cells.push([x, y]);

  const walls = new Uint8Array(cols * rows);
  for (const [x, y] of cells) walls[y * cols + x] = 1;
  const map = new MapGrid({ width: cols * cell, height: rows * cell, cols, rows, cellSize: cell, walls, name: "e2e" });

  const core = new GameCore({ map, seed: 11 });
  // 全部单位先摆到空地上（出生点可能落在新加的墙里）
  for (const u of core.units) core.settleUnit(u);

  let badFrames = 0, maxDepth = 0;
  const tmp = [];
  for (let f = 0; f < 600; f++) {
    core.step(1 / 60);
    let any = false;
    for (const u of core.units) {
      collectCircleWallContacts(core.map, u.x, u.y, u.radius || 0, tmp);
      const d = findDeepestContact(tmp);
      if (d && d.depth > 1e-6) { any = true; maxDepth = Math.max(maxDepth, d.depth); }
    }
    if (any) badFrames++;
  }
  ok("600 帧里没有任何一帧有人压进墙", badFrames === 0, `${badFrames} 帧，最大穿透 ${maxDepth.toFixed(2)}px`);
  ok("没被打光（墙的处理没有把单位清空）", core.units.length > 30, `剩 ${core.units.length}`);
  ok("所有单位都在世界内", core.units.every(u => u.x >= 0 && u.x <= core.width && u.y >= 0 && u.y <= core.height));
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
