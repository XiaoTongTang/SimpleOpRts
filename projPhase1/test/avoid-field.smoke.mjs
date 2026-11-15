/**
 * 静息避墙场自检
 *   node test/avoid-field.smoke.mjs
 *
 * 设计：design/261115_2流场通行成本/技术设计-静息避墙场.md
 *
 * 验的是：
 *   1. 只在离墙 B 格以内有方向；带外 ax = ay = 0（"其他区域没有流场方向"）
 *   2. 带内的方向是单位向量；力的大小恒定（与离墙几格无关）
 *   3. 凹角处方向连续（多墙叠加；不是最近墙法向的 90° 跳变）
 *   4. 确定性：同图两次建场逐位相同
 *   5. 集成：无信标小队会被推离墙；**有信标的小队完全不读它**
 */

import { MapGrid } from "../src/core/map.js";
import { GameCore } from "../src/core/core.js";
import { buildAvoidField, avoidAt, AVOID_BAND_CELLS } from "../src/core/sim/avoid-field.js";
import { CLEARANCE_BAND_CELLS } from "../src/core/sim/clearance-field.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
  : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));
const eq = (n, a, b) => ok(n, a === b, `期望 ${b}，实际 ${a}`);

const C = 8;

function makeMap(cols, rows, cells, name = "t") {
  const walls = new Uint8Array(cols * rows);
  for (const [x, y] of cells) walls[y * cols + x] = 1;
  return new MapGrid({ cols, rows, cellSize: C, walls, name });
}
const block = (x0, y0, w, h) => {
  const a = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) a.push([x, y]);
  return a;
};

/** 某格到最近墙的欧氏距离（格） */
function clearance(map, cx, cy, maxR = 20) {
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

console.log("\n[1] 只在离墙 B 格以内有方向");
{
  const B = AVOID_BAND_CELLS;
  eq("避墙带宽与通行成本共用同一个常量", AVOID_BAND_CELLS, CLEARANCE_BAND_CELLS);

  // 40×30 的空图（只有边界）：中心区域离墙 ≥ B，必须没有方向
  const m = makeMap(40, 30, []);
  const f = buildAvoidField(m);
  ok("有方向的格数 > 0（场地边界那一圈也算墙）", f.cells > 0, String(f.cells));

  let outsideWithDir = 0, insideWithoutDir = 0;
  for (let cy = 0; cy < m.rows; cy++) {
    for (let cx = 0; cx < m.cols; cx++) {
      const i = cy * m.cols + cx;
      const has = f.ax[i] !== 0 || f.ay[i] !== 0;
      const d = clearance(m, cx, cy);
      if (d >= B && has) outsideWithDir++;
      if (d <= B - 3 && !has) insideWithoutDir++;
    }
  }
  eq("离墙 ≥ B 的格一个方向都没有", outsideWithDir, 0);
  eq("离墙 ≤ B−3 的格都有方向（带内不空）", insideWithoutDir, 0);

  let wallWithDir = 0;
  for (let i = 0; i < m.walls.length; i++) {
    if (m.walls[i] === 1 && (f.ax[i] || f.ay[i])) wallWithDir++;
  }
  eq("墙格没有方向", wallWithDir, 0);
}

console.log("\n[2] 带内是单位向量：力的大小恒定");
{
  const m = makeMap(60, 50, [...block(10, 10, 6, 6)]);
  const f = buildAvoidField(m);
  let bad = 0, checked = 0, minLen = 9, maxLen = 0;
  for (let i = 0; i < f.ax.length; i++) {
    if (!f.ax[i] && !f.ay[i]) continue;
    checked++;
    const len = Math.hypot(f.ax[i], f.ay[i]);
    if (Math.abs(len - 1) > 1e-5) bad++;
    minLen = Math.min(minLen, len);
    maxLen = Math.max(maxLen, len);
  }
  ok(`所有有方向的格都是单位向量（${checked} 格）`, bad === 0,
    `${bad} 格长度 ≠ 1（${minLen.toFixed(4)} ~ ${maxLen.toFixed(4)}）`);

  // avoidAt 返回的也是单位向量 → 力 = 常数 × 单位向量，与离墙几格无关
  // 块在 (10..15, 10..15)：取它正下方 1 格 / 5 格
  const one = avoidAt(f, m, (11 + 0.5) * C, (16 + 0.5) * C);
  const five = avoidAt(f, m, (11 + 0.5) * C, (20 + 0.5) * C);
  ok("贴墙处有力", !!one && Math.abs(Math.hypot(one.x, one.y) - 1) < 1e-5,
    one ? `(${one.x.toFixed(2)}, ${one.y.toFixed(2)})` : "null");
  ok("同一条带内更远处的力大小一样（常数力）",
    !!five && Math.abs(Math.hypot(five.x, five.y) - 1) < 1e-5);
  // (40,30)：离四边和障碍都 ≥ band
  ok("带外没有力", avoidAt(f, m, (40 + 0.5) * C, (30 + 0.5) * C) === null);
}

console.log("\n[3] 凹角：方向连续（不是最近墙法向的 90° 跳变）");
{
  // 上边一排 + 左边一列 → 一个 90° 凹角，角平分线是 y = x
  const cells = [];
  for (let x = 0; x < 12; x++) cells.push([x, 0]);
  for (let y = 0; y < 12; y++) cells.push([0, y]);
  const m = makeMap(24, 24, cells);
  const f = buildAvoidField(m);

  /** 沿着横穿角平分线的一条斜线，量"相邻格之间的最大转向角" */
  const maxStep = get => {
    let worst = 0;
    for (let x = 2; x < 10; x++) {
      const y = 12 - x;                       // (2,10) → (9,3)，穿过 y = x
      const a = get(x, y), b = get(x + 1, y - 1);
      if (!a || !b) continue;
      const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y));
      const ang = Math.acos(dot) * 180 / Math.PI;
      if (ang > worst) worst = ang;
    }
    return worst;
  };

  const multi = maxStep((x, y) => {
    const i = y * 24 + x;
    if (!f.ax[i] && !f.ay[i]) return null;
    return { x: f.ax[i], y: f.ay[i] };
  });

  // 对照：最近墙的法向（测试里现算一遍，用来证明它确实会跳）
  const nearest = (x, y) => {
    let best = Infinity, bx = 0, by = 0;
    for (let wy = 0; wy < 24; wy++) {
      for (let wx = 0; wx < 24; wx++) {
        if (m.walls[wy * 24 + wx] !== 1) continue;
        const dd = Math.hypot(wx - x, wy - y);
        if (dd < best) { best = dd; bx = x - wx; by = y - wy; }
      }
    }
    if (!best) return null;
    return { x: bx / best, y: by / best };
  };
  const near = maxStep(nearest);

  ok(`多墙叠加：相邻格最大转向 ${multi.toFixed(1)}° < 30°`, multi < 30, `${multi.toFixed(1)}°`);
  ok(`最近墙法向：同一段上最大转向 ${near.toFixed(1)}° ≥ 60°（会跳）`, near >= 60,
    `${near.toFixed(1)}°`);

  const di = 4 * 24 + 4;
  ok("角平分线上的方向指向对角外", f.ax[di] > 0.2 && f.ay[di] > 0.2,
    `(${f.ax[di].toFixed(2)}, ${f.ay[di].toFixed(2)})`);
}

console.log("\n[4] 确定性");
{
  const m = makeMap(30, 24, [...block(8, 6, 5, 9)]);
  const a = buildAvoidField(m), b = buildAvoidField(m);
  let same = a.ax.length === b.ax.length && a.cells === b.cells;
  for (let i = 0; same && i < a.ax.length; i++) {
    if (a.ax[i] !== b.ax[i] || a.ay[i] !== b.ay[i]) same = false;
  }
  ok("两次建场逐位相同", same);
}

console.log("\n[5] 集成：无信标小队被推离墙；有信标的小队完全不读它");
{
  const ROWS = 24, COLS = 60;
  const m = makeMap(COLS, ROWS, [...block(0, 0, COLS, 1), ...block(0, ROWS - 1, COLS, 1)]);

  const meanClearance = core => {
    let sum = 0, n = 0;
    for (const u of core.units) {
      const cx = core.map.cellXOf(u.x), cy = core.map.cellYOf(u.y);
      sum += clearance(core.map, cx, cy); n++;
    }
    return sum / Math.max(1, n);
  };

  const runNoGoal = force => {
    const core = new GameCore({ map: m, seed: 7 });
    core.G.wallAvoidForce = force;
    for (let f = 0; f < 240; f++) core.step(1 / 60);
    return meanClearance(core);
  };

  const off = runNoGoal(0);
  const on = runNoGoal(40);
  ok(`开避墙力后无信标小队平均离墙更远（${off.toFixed(2)} → ${on.toFixed(2)} 格）`,
    on > off + 0.2, `${off.toFixed(2)} vs ${on.toFixed(2)}`);

  // 有信标：两组轨迹必须逐位相同（说明那条力根本没被加进去）
  const runGoal = force => {
    const core = new GameCore({ map: m, seed: 7 });
    core.G.wallAvoidForce = force;
    const ids = Object.keys(core.squads).map(Number);
    core.command({ type: "setGoal", squadIds: ids, x: (COLS - 4) * C, y: (ROWS / 2) * C });
    for (let f = 0; f < 90; f++) core.step(1 / 60);
    return core.units.map(u => `${u.x.toFixed(9)},${u.y.toFixed(9)}`).join("|");
  };
  eq("有信标时：避墙力 0 与 40 的轨迹完全一致", runGoal(40) === runGoal(0), true);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
