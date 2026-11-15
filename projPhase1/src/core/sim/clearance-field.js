/**
 * 净空距离场（到最近墙的距离）
 * -----------------------------------------------------------------
 * 纯几何，与命令、队伍、单位半径都无关 —— 一张地图算一次就够。
 *
 * 两个消费者：
 *   1. 流场寻路（`flow-field.js`）：用它给"贴墙的格子"加通行成本
 *   2. 静息避墙场（`avoid-field.js`）：用它确定"离墙 B 格以内"这条带子
 *
 * 做法：两趟 chamfer（正交 +2、对角 +3，单位是**半格**），
 * 结果饱和在 `2B` —— 更远的距离对这两个消费者都没用，省一半内存。
 *
 * 返回**带一圈实心边的布局**（`PW = cols + 2`），调用方可以省掉边界判断：
 *   格 (cx, cy) 在数组里的下标 = (cy + 1) * PW + (cx + 1)
 */

/**
 * 惩罚/避让带宽度（格）。流场与避墙场共用同一个数，避免两套几何。
 *
 * 以"格"为单位是刻意的：格长就是地图比例尺，整张图放大时边距也一起放大；
 * 而且与单位半径无关 —— 两个消费者服务的是整支小队（集群移动），
 * 不是单船的碰撞保证。
 */
export const CLEARANCE_BAND_CELLS = 10;

/**
 * @param {{cols:number, rows:number, walls:Uint8Array}} map
 * @param {number} bandCells 带宽（格），决定饱和值 2×band
 * @returns {{ d: Uint8Array, PW: number, cols: number, rows: number, B2: number }}
 *          `d[i]` 单位是半格：墙 = 0，紧贴墙的空地 ≈ 2，越远越大，最大 `B2 = 2×band`
 */
export function buildClearance(map, bandCells = CLEARANCE_BAND_CELLS) {
  const cols = map.cols, rows = map.rows;
  const band = Math.max(1, Math.round(bandCells));
  const B2 = band * 2;
  const PW = cols + 2;
  const d = new Uint8Array(PW * (rows + 2)).fill(B2);

  // 墙（含外扩的一圈）→ 0；空地先给饱和值
  for (let y = 0; y < rows; y++) {
    const src = y * cols;
    const dst = (y + 1) * PW + 1;
    for (let x = 0; x < cols; x++) {
      if (map.walls[src + x] === 1) d[dst + x] = 0;
    }
  }
  // 外圈实心边（越界即墙）
  for (let x = 0; x < PW; x++) { d[x] = 0; d[(rows + 1) * PW + x] = 0; }
  for (let y = 0; y <= rows + 1; y++) { d[y * PW] = 0; d[y * PW + PW - 1] = 0; }

  const clamp = v => (v < B2 ? v : B2);

  // 前向：上、左、左上、右上
  for (let y = 1; y <= rows; y++) {
    for (let x = 1; x <= cols; x++) {
      const i = y * PW + x;
      if (d[i] === 0) continue;
      let v = d[i];
      v = Math.min(v, d[i - PW] + 2, d[i - 1] + 2,
                      d[i - PW - 1] + 3, d[i - PW + 1] + 3);
      d[i] = clamp(v);
    }
  }
  // 后向：下、右、右下、左下
  for (let y = rows; y >= 1; y--) {
    for (let x = cols; x >= 1; x--) {
      const i = y * PW + x;
      if (d[i] === 0) continue;
      let v = d[i];
      v = Math.min(v, d[i + PW] + 2, d[i + 1] + 2,
                      d[i + PW + 1] + 3, d[i + PW - 1] + 3);
      d[i] = clamp(v);
    }
  }

  return { d, PW, cols, rows, B2 };
}
