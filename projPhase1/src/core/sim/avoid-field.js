/**
 * 静息避墙场（无信标小队专用）
 * -----------------------------------------------------------------
 * 解决的问题：没有命令信标的小队没有任何流场，闲逛时只能撞上去、贴着墙蹭。
 * 这里给它补一张**只含"离墙方向"**的静态场：只在离墙 B 格以内有方向，带外为空。
 *
 * 与流场的区别：
 *   - 每张地图**一张**（与目标格无关），按 `map.rev` 缓存
 *   - 只有方向、没有代价、没有 Dijkstra
 *   - 力的大小是**常数**（`G.wallAvoidForce`）：进带就推、出带就不推，与离墙几格无关
 *
 * 方向为什么用"多墙叠加"而不是"最近墙的法向"：
 * 凹角处最近墙会跳变，单位站在角平分线上时法向会整支翻 90°；
 * 多墙叠加在平分线上两侧对称相加，天然给出角平分线方向，连续、不跳。
 *
 * 设计：design/261115_2流场通行成本/技术设计-静息避墙场.md
 */

import { buildClearance, CLEARANCE_BAND_CELLS } from "./clearance-field.js";

/** 与通行成本共用同一个带宽常量 */
export const AVOID_BAND_CELLS = CLEARANCE_BAND_CELLS;

/**
 * 建一张避墙场。
 *
 * @param {{cols:number, rows:number, walls:Uint8Array, rev:number, cellSize:number}} map
 * @param {number} [band] 带宽（格），默认 6
 * @returns {{
 *   rev: number, band: number, cols: number, rows: number,
 *   ax: Float32Array, ay: Float32Array,   // 单位向量；带外恒为 0,0
 *   cells: number                          // 有方向的格数（调试用）
 * }}
 */
export function buildAvoidField(map, band = AVOID_BAND_CELLS) {
  const cols = map.cols, rows = map.rows, n = cols * rows;
  const B = Math.max(1, Math.round(band));

  const { d, PW, B2 } = buildClearance(map, B);

  // ---- 多墙泼洒：每个墙格向半径 B 内的空地加一份 1/r² 的斥力 ----
  // 用**带一圈实心边**的布局，这样"地图外"也自动算作墙（游戏里越界即墙），
  // 否则贴着场地边界的船不会被推。
  // 单位全部用"格"，和 cellSize 无关（方向是纯几何的）。
  const solid = new Uint8Array(PW * (rows + 2)).fill(1);
  for (let y = 0; y < rows; y++) {
    const src = y * cols;
    const dst = (y + 1) * PW + 1;
    for (let x = 0; x < cols; x++) {
      if (map.walls[src + x] === 0) solid[dst + x] = 0;
    }
  }

  const aw = PW * (rows + 2);
  const axP = new Float32Array(aw);
  const ayP = new Float32Array(aw);

  for (let py = 0; py <= rows + 1; py++) {
    for (let px = 0; px <= cols + 1; px++) {
      const p = py * PW + px;
      if (!solid[p]) continue;                       // 只从墙格发出

      const y0 = Math.max(0, py - B), y1 = Math.min(rows + 1, py + B);
      const x0 = Math.max(0, px - B), x1 = Math.min(cols + 1, px + B);

      for (let qy = y0; qy <= y1; qy++) {
        const dy = qy - py;
        for (let qx = x0; qx <= x1; qx++) {
          const dx = qx - px;
          if (dx === 0 && dy === 0) continue;
          const q = qy * PW + qx;
          if (solid[q]) continue;                    // 目标是墙

          const r2 = dx * dx + dy * dy;
          if (r2 > B * B) continue;

          const r = Math.sqrt(r2);
          const w = 1 / Math.max(1, r2);             // 1/r² 衰减（r < 1 按 1）
          axP[q] += (dx / r) * w;
          ayP[q] += (dy / r) * w;
        }
      }
    }
  }

  // ---- 归一化 + 带外清零，再拷成不带边的数组 ----
  const ax = new Float32Array(n);
  const ay = new Float32Array(n);
  let cells = 0;

  for (let y = 0; y < rows; y++) {
    const dst = y * cols;
    const pRow = (y + 1) * PW + 1;
    for (let x = 0; x < cols; x++) {
      const p = pRow + x;
      if (solid[p]) continue;                        // 墙格没有方向
      if (d[p] >= B2) continue;                      // 带外：没有方向（也不受力）

      const len = Math.hypot(axP[p], ayP[p]);
      if (len < 1e-9) continue;
      ax[dst + x] = axP[p] / len;
      ay[dst + x] = ayP[p] / len;
      cells++;
    }
  }

  return { rev: map.rev, band: B, cols, rows, ax, ay, cells };
}

/**
 * 某世界坐标处的避墙方向（单位向量）。
 *
 * 返回 `null` = 这一格在带外（或墙里）→ 不产生任何力。
 * 不做插值：力是常数、方向是静态几何，最近格足够。
 */
export function avoidAt(field, map, x, y) {
  if (!field) return null;
  const cx = Math.min(field.cols - 1, Math.max(0, map.cellXOf(x)));
  const cy = Math.min(field.rows - 1, Math.max(0, map.cellYOf(y)));
  const i = cy * field.cols + cx;
  const ax = field.ax[i], ay = field.ay[i];
  if (ax === 0 && ay === 0) return null;
  return { x: ax, y: ay };
}
