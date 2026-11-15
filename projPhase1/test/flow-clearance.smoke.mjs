/**
 * 流场净空成本自检
 *   node test/flow-clearance.smoke.mjs
 *
 * 设计：design/261115_2流场通行成本/技术设计-流场通行成本.md
 *
 * 验的是：
 *   1. 长距离贴墙走时，路径会被推离墙（λ>0 比 λ=0 更宽）
 *   2. 开阔地/不贴墙的路径**一格都不变**（净空加权只在墙边生效）
 *   3. 可达性不变（只改权重不改通行性）
 *   4. 确定性不变
 *   5. 关掉加权（λ=0 或 band=0）时与纯几何流场逐格一致
 *   6. 带内的格代价确实变高
 */

import { MapGrid } from "../src/core/map.js";
import {
  buildFlowField, CLEARANCE_BAND_CELLS, CLEARANCE_LAMBDA
} from "../src/core/sim/flow-field.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
  : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));
const eq = (n, a, b) => ok(n, a === b, `期望 ${b}，实际 ${a}`);

const C = 8;
const OFF = { band: 0, lambda: 0 };

function makeMap(cols, rows, cells) {
  const walls = new Uint8Array(cols * rows);
  for (const [x, y] of cells) walls[y * cols + x] = 1;
  return new MapGrid({ cols, rows, cellSize: C, walls });
}
const block = (x0, y0, w, h) => {
  const a = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) a.push([x, y]);
  return a;
};
const worldCenter = (cx, cy) => [(cx + 0.5) * C, (cy + 0.5) * C];

/** 顺着流场从 (sx,sy) 走到目标，返回路径格序列 */
function walk(map, flow, sx, sy, maxSteps = 8000) {
  let cx = sx, cy = sy;
  const path = [[cx, cy]];
  for (let s = 0; s < maxSteps; s++) {
    if (cx === flow.targetCellX && cy === flow.targetCellY) break;
    const i = cy * map.cols + cx;
    const dx = Math.round(flow.dirX[i]);
    const dy = Math.round(flow.dirY[i]);
    if (dx === 0 && dy === 0) break;
    cx += dx; cy += dy;
    if (cx < 0 || cy < 0 || cx >= map.cols || cy >= map.rows) break;
    path.push([cx, cy]);
  }
  return path;
}

/** 某格到最近墙的欧氏距离（格），上限 maxR */
function clearance(map, cx, cy, maxR = 12) {
  let best = maxR;
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        if (map.isWall(cx + dx, cy + dy)) {
          const d = Math.hypot(dx, dy);
          if (d < best) best = d;
        }
      }
    }
    if (best < r) break;
  }
  return best;
}

/** 路径中段的平均离墙（去掉两端各 2 格：端点位置固定，不反映路径选择） */
function midAvgClearance(map, path) {
  const mid = path.slice(2, Math.max(2, path.length - 2));
  if (!mid.length) return 0;
  let s = 0;
  for (const [x, y] of mid) s += clearance(map, x, y);
  return s / mid.length;
}

function pathLen(path) {
  let s = 0;
  for (let k = 1; k < path.length; k++) {
    s += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
  }
  return s;
}

console.log("\n[1] 长距离贴墙走：λ>0 会把路径推离墙");
{
  // 60×12 的走廊，上下各 1 格墙；起点与终点都贴北墙（y=2），路径有 50 格是"沿墙平移"
  const m = makeMap(60, 12, [...block(0, 0, 60, 1), ...block(0, 11, 60, 1)]);
  const [tx, ty] = worldCenter(55, 2);

  const f0 = buildFlowField(m, tx, ty, OFF);
  const f1 = buildFlowField(m, tx, ty);
  const p0 = walk(m, f0, 4, 2);
  const p1 = walk(m, f1, 4, 2);

  ok("两种都能走到目标", p0.length > 1 && p1.length > 1);
  const c0 = midAvgClearance(m, p0);
  const c1 = midAvgClearance(m, p1);
  ok(`默认 λ 把路径推离了墙（${c0.toFixed(2)} → ${c1.toFixed(2)} 格）`, c1 > c0 + 0.5,
    `λ=0 ${c0.toFixed(2)} / λ=${CLEARANCE_LAMBDA} ${c1.toFixed(2)}`);

  const l0 = pathLen(p0), l1 = pathLen(p1);
  ok("绕出来只多走一点点（长度增幅 < 5%）", l1 < l0 * 1.05,
    `${l0.toFixed(1)} → ${l1.toFixed(1)}`);
}

console.log("\n[2] 离墙 ≥ band 的地方：一格都不变");
{
  // 同一张走廊，起点与终点都在中线。净空加权只该改"带内"的格，
  // 离墙 3 格以外的方向必须和关掉加权时逐格相同（否则说明加权漏到了开阔地）。
  const m = makeMap(60, 12, [...block(0, 0, 60, 1), ...block(0, 11, 60, 1)]);
  const [tx, ty] = worldCenter(55, 6);
  const f0 = buildFlowField(m, tx, ty, OFF);
  const f1 = buildFlowField(m, tx, ty);

  let changed = 0, checked = 0;
  for (let cy = 0; cy < m.rows; cy++) {
    for (let cx = 0; cx < m.cols; cx++) {
      if (m.isWall(cx, cy)) continue;
      if (clearance(m, cx, cy) < CLEARANCE_BAND_CELLS) continue;   // 带外的格才有"不该变"的承诺
      checked++;
      const i = cy * m.cols + cx;
      if (f0.dirX[i] !== f1.dirX[i] || f0.dirY[i] !== f1.dirY[i]) changed++;
    }
  }
  ok(`带外格子方向完全没变（检查了 ${checked} 格）`, changed === 0, `${changed} 格被改了`);

  const p0 = walk(m, f0, 4, 6), p1 = walk(m, f1, 4, 6);
  eq("中线路径完全一样", p1.map(p => p.join()).join(" "), p0.map(p => p.join()).join(" "));
}

console.log("\n[3] 可达性不变（权重不改变通行性）");
{
  // 一条 1 格宽的窄缝：加权后会变"贵"，但必须仍然可达
  const cells = [...block(0, 0, 30, 10), ...block(0, 11, 30, 10)];   // 中间留 1 格缝 y=10
  const m = makeMap(40, 21, cells);
  const [tx, ty] = worldCenter(35, 10);

  const f0 = buildFlowField(m, tx, ty, OFF);
  const f1 = buildFlowField(m, tx, ty);
  eq("可达格数与关掉加权时完全一致", f1.reachable, f0.reachable);
  ok("窄缝另一侧仍可达", f1.reachable > 40 * 21 * 0.2, `${f1.reachable}/${40 * 21}`);
}

console.log("\n[4] 确定性");
{
  const m = makeMap(40, 30, [...block(18, 10, 6, 12)]);
  const [tx, ty] = worldCenter(30, 20);
  const a = buildFlowField(m, tx, ty);
  const b = buildFlowField(m, tx, ty);
  let same = a.dirX.length === b.dirX.length && a.reachable === b.reachable;
  for (let i = 0; same && i < a.dirX.length; i++) {
    if (a.cost[i] !== b.cost[i] || a.dirX[i] !== b.dirX[i] || a.dirY[i] !== b.dirY[i]) same = false;
  }
  ok("两次建场逐格相同", same);
}

console.log("\n[5] 关掉加权 = 原来的纯几何流场");
{
  const m = makeMap(40, 30, []);
  const [tx, ty] = worldCenter(20, 15);

  const off = buildFlowField(m, tx, ty, OFF);
  const zeroLambda = buildFlowField(m, tx, ty, { band: 3, lambda: 0 });
  const zeroBand = buildFlowField(m, tx, ty, { band: 0, lambda: 0.25 });

  let same = true;
  for (let i = 0; same && i < off.dirX.length; i++) {
    if (off.dirX[i] !== zeroLambda.dirX[i] || off.cost[i] !== zeroLambda.cost[i]) same = false;
    if (off.dirX[i] !== zeroBand.dirX[i] || off.cost[i] !== zeroBand.cost[i]) same = false;
  }
  ok("band=0 与 λ=0 都退回原算法（逐格一致）", same);

  // 空图上代价就是八边形距离：从 (0,0) 到 (20,15) 应为 20 + (√2−1)·15
  const i00 = 0;
  const want = 20 + (Math.SQRT2 - 1) * 15;
  ok("空图代价 = 八边形距离（没有残留加权）",
    Math.abs(off.cost[i00] - want) < 1e-6, `${off.cost[i00].toFixed(4)} vs ${want.toFixed(4)}`);
}

console.log("\n[6] 带内的格确实变贵");
{
  const m = makeMap(60, 12, [...block(0, 0, 60, 1), ...block(0, 11, 60, 1)]);
  const [tx, ty] = worldCenter(55, 6);
  const f0 = buildFlowField(m, tx, ty, OFF);
  const f1 = buildFlowField(m, tx, ty);

  const nearWall = 2 * 60 + 30;      // (30, 2)：离北墙 2 格
  const openCell = 6 * 60 + 30;      // (30, 6)：走廊中线
  ok("贴墙格在加权后变贵", f1.cost[nearWall] > f0.cost[nearWall],
    `${f0.cost[nearWall].toFixed(2)} → ${f1.cost[nearWall].toFixed(2)}`);
  ok("中线格几乎不变（离墙 ≥ band）",
    Math.abs(f1.cost[openCell] - f0.cost[openCell]) < 1e-9,
    `${f0.cost[openCell].toFixed(2)} → ${f1.cost[openCell].toFixed(2)}`);

  eq("场里记录了用了什么参数", f1.band, CLEARANCE_BAND_CELLS);
  eq("λ 也记录在场里", f1.lambda, CLEARANCE_LAMBDA);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
