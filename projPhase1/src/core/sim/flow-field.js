/**
 * 流场寻路（每队一张，按目标格共享缓存）
 * -----------------------------------------------------------------
 * 解决的问题：命令力现在是"直线指向信标"，遇到墙只会撞上去然后沿墙滑，
 * 凹角里直接卡住。流场把"到信标的代价"铺满整张地图，每个格子记一个方向，
 * 船只要读自己脚下那格的方向就能绕开障碍。
 *
 * 做法（和沙盒 `computeFlowField` 一致）：
 *   1. 从目标格做 8 邻域 Dijkstra（直边代价 1，斜边 √2），得到每个可走格到目标的代价
 *   2. 再扫一遍全图：每格选一个"代价下降最多"的邻居，把方向存成单位向量
 *
 * 三条硬约定：
 *   1. **确定性**：不按耗时决定做多少活（见 core 的 stepFlowQueue），也不许用随机
 *   2. **不能斜穿墙角**：斜着走时两个正交邻格都必须是空地，否则贴角会撞墙
 *   3. **一张场只属于一个目标格**：同目标的多支队伍共享（FlowCache）
 *
 * 实测代价（250×150 = 37 500 格，2000×1200 @ 8px 的默认地图）：
 *   中位 **6.6 ms** / 张。所以 core 里 `FLOW_PER_FRAME = 1`（一帧一张）。
 *   两个把耗时从 15 ms 压到 6.6 ms 的关键点，别改回去：
 *     · cost 必须是 **Float64**（Float32 的舍入会让 `nodeCost > cost[i]` 误判，
 *       节点永久不出队，空图上可达率都只有 40%）
 *     · 内层循环**不许调 map.isWall()**，用带一圈实心边的 `solid` 数组；
 *       也不许在里面做除法/开方（tie-break 有除法的话会直接慢一倍）
 *
 * 设计见 design/261114_1鸟群算法迁移/迁移设计.md §3.4。
 */

const SQRT2 = Math.SQRT2;

/**
 * 净空惩罚带宽度（**格**）。离墙 `B` 格以内加价，`B` 格外不加价。
 *
 * 以"格"为单位是刻意的：格长就是地图比例尺，整张图放大时边距也一起放大；
 * 而且**与单位半径无关** —— 流场服务的是整支小队（集群移动），
 * 不是单船的碰撞保证。设计见 design/261115_2流场通行成本/技术设计-流场通行成本.md。
 *
 * 6 格是 2026-11-15 定的：3 格只够把"长贴墙段"推出 1 格，看不出效果；6 格才会真正走到走廊中间。
 */
export const CLEARANCE_BAND_CELLS = 10;

/** 净空惩罚力度：贴墙格的单步代价最多比开阔格贵 `λ` 倍（0.4 = 贵 40%）。 */
export const CLEARANCE_LAMBDA = 1;

/** 8 邻域：[dx, dy, 代价]，前 4 个是直边，后 4 个是斜边 */
const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2]
];

/** 斜着走时，两个正交邻格都得是空地 */
export function canStep(map, cx, cy, dir) {
  const nx = cx + dir[0];
  const ny = cy + dir[1];
  if (nx < 0 || ny < 0 || nx >= map.cols || ny >= map.rows) return false;
  if (map.isWall(nx, ny)) return false;
  if (dir[0] !== 0 && dir[1] !== 0) {
    if (map.isWall(cx + dir[0], cy)) return false;
    if (map.isWall(cx, cy + dir[1])) return false;
  }
  return true;
}

/** 世界坐标 → 一维格子下标（超出地图会被夹进边界内） */
export function cellIndexAt(map, x, y) {
  const cx = Math.min(map.cols - 1, Math.max(0, map.cellXOf(x)));
  const cy = Math.min(map.rows - 1, Math.max(0, map.cellYOf(y)));
  return cy * map.cols + cx;
}

/**
 * 目标落在哪一格（墙里就挪到最近空地）。
 * core 用它算缓存 key，`buildFlowField` 内部也用它，两边口径必须一致，
 * 否则"两个不同的 key 指向同一张场"会白算一遍。
 */
export function targetCellOf(map, x, y) {
  const cx = Math.min(map.cols - 1, Math.max(0, Math.floor(x / map.cellSize)));
  const cy = Math.min(map.rows - 1, Math.max(0, Math.floor(y / map.cellSize)));
  if (!map.isWall(cx, cy)) return { cellX: cx, cellY: cy };
  return map.nearestFloor(cx, cy);
}

/**
 * 建一张流场。
 *
 * @param {object} map  MapGrid
 * @param {number} targetX 目标世界坐标
 * @param {number} targetY
 * @param {object} [opts] 净空加权（默认取模块常量，测试可以覆盖）
 * @param {number} [opts.band]   惩罚带宽度（格），0 = 关闭
 * @param {number} [opts.lambda] 最大加权幅度，0 = 关闭（等价于改动前的纯几何流场）
 * @returns {null | {
 *   ready: true, cellSize: number, cols: number, rows: number,
 *   targetCellX: number, targetCellY: number, reachable: number,
 *   band: number, lambda: number,
 *   cost: Float64Array, dirX: Float32Array, dirY: Float32Array
 * }} 目标落在墙里且附近没有空地时返回 null
 */
export function buildFlowField(map, targetX, targetY, opts = {}) {
  const cols = map.cols, rows = map.rows, n = cols * rows;
  const cs = map.cellSize;

  // 目标点在墙里：挪到最近空地（地图上画了一堵墙也不能让信标失效）
  const cell = targetCellOf(map, targetX, targetY);
  if (!cell) return null;
  const tcx = cell.cellX;
  const tcy = cell.cellY;

  // 净空加权参数。band 以"格"计，与单位半径无关。
  const band = Math.max(0, Math.round(Number(opts.band ?? CLEARANCE_BAND_CELLS)));
  const lambda = Math.max(0, Number(opts.lambda ?? CLEARANCE_LAMBDA));
  const B2 = band * 2;                                  // 半格单位（chamfer 的尺度）
  // 每步代价 = len · (1 + (penA + penB) · K)，pen ∈ [0, B2] → 系数 ∈ [1, 1+λ]
  const K = band > 0 ? lambda / (2 * B2) : 0;
  const weighted = K > 0;

  // cost 必须是 Float64：堆里存的是 double，若用 Float32 存，像 √2 这种代价会被舍入，
  // `nodeCost > cost[index]` 判出"这个节点已经过时了"，于是它再也不会被 settle，
  // 后面所有依赖它的格子都变成不可达（空图上都能只有 40% 可达）。
  const cost = new Float64Array(n).fill(Infinity);
  const settled = new Uint8Array(n);
  const dirX = new Float32Array(n);
  const dirY = new Float32Array(n);

  // ---- 实心性查表（带 1 圈实心边）----
  // 内层循环每格要查 16 次"这格是不是墙"。走 map.isWall() 是方法调用 + 4 次边界比较，
  // 120 万次下来要 6 ms。这里把地图**外扩一圈实心边**，之后只需一次数组读，也没有边界判断。
  const PW = cols + 2;
  const solid = new Uint8Array(PW * (rows + 2)).fill(1);
  for (let y = 0; y < rows; y++) {
    const src = y * cols;
    const dst = (y + 1) * PW + 1;
    for (let x = 0; x < cols; x++) {
      if (map.walls[src + x] === 0) solid[dst + x] = 0;
    }
  }

  // ---- 净空距离变换（两趟 chamfer，单位"半格"，饱和在 2B）----
  //
  // 为什么要饱和：只有当这一格离墙不到 B 格时才需要加价，更远的格一律不加。
  // 距离只增不减地向外传播，所以"取 min 之后再夹到 2B"不会破坏后续传播：
  // 已经饱和的格再 +2 还是会被夹回 2B。
  //
  // 用**带边**的数组下标（和 solid 同一套），Dijkstra 里已经算好了 pp，直接查表，零额外索引运算。
  let clear = null;
  if (weighted) {
    clear = new Uint8Array(PW * (rows + 2)).fill(B2);
    for (let i = 0; i < solid.length; i++) if (solid[i]) clear[i] = 0;
    const clampB2 = v => (v < B2 ? v : B2);

    // 前向：上、左、左上、右上
    for (let y = 1; y <= rows; y++) {
      for (let x = 1; x <= cols; x++) {
        const i = y * PW + x;
        if (clear[i] === 0) continue;
        let v = clear[i];
        v = clampB2(Math.min(v, clear[i - PW] + 2, clear[i - 1] + 2,
                               clear[i - PW - 1] + 3, clear[i - PW + 1] + 3));
        clear[i] = v;
      }
    }
    // 后向：下、右、右下、左下
    for (let y = rows; y >= 1; y--) {
      for (let x = cols; x >= 1; x--) {
        const i = y * PW + x;
        if (clear[i] === 0) continue;
        let v = clear[i];
        v = clampB2(Math.min(v, clear[i + PW] + 2, clear[i + 1] + 2,
                               clear[i + PW + 1] + 3, clear[i + PW - 1] + 3));
        clear[i] = v;
      }
    }
  }

  const targetIndex = tcy * cols + tcx;
  cost[targetIndex] = 0;

  // ---- 二叉堆（数组实现，零分配复用）----
  const heapIdx = [];
  const heapCost = [];

  const push = (index, c) => {
    let pos = heapIdx.length;
    heapIdx.push(index);
    heapCost.push(c);
    while (pos > 0) {
      const parent = (pos - 1) >> 1;
      if (heapCost[parent] <= c) break;
      heapIdx[pos] = heapIdx[parent];
      heapCost[pos] = heapCost[parent];
      pos = parent;
    }
    heapIdx[pos] = index;
    heapCost[pos] = c;
  };

  const pop = () => {
    const root = heapIdx[0];
    const lastIdx = heapIdx.pop();
    const lastCost = heapCost.pop();
    if (heapIdx.length > 0) {
      let pos = 0;
      const size = heapIdx.length;
      for (;;) {
        let child = pos * 2 + 1;
        if (child >= size) break;
        if (child + 1 < size && heapCost[child + 1] < heapCost[child]) child++;
        if (heapCost[child] >= lastCost) break;
        heapIdx[pos] = heapIdx[child];
        heapCost[pos] = heapCost[child];
        pos = child;
      }
      heapIdx[pos] = lastIdx;
      heapCost[pos] = lastCost;
    }
    return root;
  };

  // ---- Dijkstra ----
  push(targetIndex, 0);
  let reachable = 0;

  while (heapIdx.length > 0) {
    const nodeCost = heapCost[0];
    const index = pop();
    if (nodeCost > cost[index]) continue;
    if (settled[index]) continue;
    settled[index] = 1;
    reachable++;

    const cx = index % cols;
    const cy = (index / cols) | 0;
    const p = (cy + 1) * PW + (cx + 1);
    // 本格自己的惩罚项（循环外算一次，8 个邻居复用）
    const penA = weighted ? (B2 - clear[p]) : 0;

    for (let d = 0; d < 8; d++) {
      const dir = DIRS[d];
      const dx = dir[0], dy = dir[1];
      const pp = p + dy * PW + dx;
      if (solid[pp]) continue;                                   // 目标格是墙
      if (dx !== 0 && dy !== 0 && (solid[p + dx] || solid[p + dy * PW])) continue;  // 斜穿墙角
      const ni = index + dy * cols + dx;
      // 净空加权：贴墙的格贵一点（clear 越接近 0，pen 越接近 B2）。
      // 不加权时 K = 0，这一行退化成原来的 `nodeCost + dir[2]`，一个字节都不差。
      const next = weighted
        ? nodeCost + dir[2] * (1 + (penA + (B2 - clear[pp])) * K)
        : nodeCost + dir[2];
      if (next < cost[ni]) {
        cost[ni] = next;
        push(ni, next);
      }
    }
  }

  // ---- 方向回填 ----
  // 内层循环里**不许出现除法与开方**：37 500 格 × 8 候选 = 30 万次，
  // 一个 Math.hypot 就能把建场从 3 ms 拉到 15 ms。所有不变式都在循环外算好。
  const INV_DIR_LEN = DIRS.map(d => 1 / (d[0] !== 0 && d[1] !== 0 ? SQRT2 : 1));

  for (let index = 0; index < n; index++) {
    if (index === targetIndex) continue;
    if (!Number.isFinite(cost[index])) continue;      // 不可达（被墙隔开）

    const cx = index % cols;
    const cy = (index / cols) | 0;
    const p = (cy + 1) * PW + (cx + 1);

    // 到目标的 bearing：只用来在"代价相等"时挑一个更好看的方向。
    // 8 邻域里 (18,13) 这种增量，"正东"和"东北"的代价是**完全相等**的，
    // 不特判就会一路先往正东再拐弯（看着像突然折一下）。
    const tdx = tcx - cx, tdy = tcy - cy;
    const tl = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
    const TIE = 1e-4;

    let best = Infinity, bdx = 0, bdy = 0;

    for (let d = 0; d < 8; d++) {
      const dir = DIRS[d];
      const dx = dir[0], dy = dir[1];
      const pp = p + dy * PW + dx;
      if (solid[pp]) continue;
      if (dx !== 0 && dy !== 0 && (solid[p + dx] || solid[p + dy * PW])) continue;
      const ni = index + dy * cols + dx;
      const dot = dx * tdx + dy * tdy;
      const score = (cost[ni] + dir[2]) * tl - dot * INV_DIR_LEN[d] * TIE;

      if (score < best) {
        best = score;
        bdx = dx;
        bdy = dy;
      }
    }

    if (bdx !== 0 || bdy !== 0) {
      const inv = INV_DIR_LEN[bdx !== 0 && bdy !== 0 ? 4 : 0];
      dirX[index] = bdx * inv;
      dirY[index] = bdy * inv;
    }
  }

  return {
    ready: true,
    cellSize: cs,
    cols, rows,
    targetCellX: tcx,
    targetCellY: tcy,
    reachable,
    band,
    lambda,
    cost,
    dirX,
    dirY
  };
}

/**
 * 读某世界坐标处的流场方向（**双线性插值**）。
 *
 * 为什么要插值：8 邻域的方向只有 8 个取值，格子边界上会跳 22.5°，
 * 船走起来是"阶梯"。插值之后方向随位置连续变化，阶梯就没了。
 *
 * 插值不到的（邻居不可达 / 没有方向）直接忽略；剩下的重新归一化。
 * 全部为零时返回 null，调用方退回直线。
 */
export function directionAt(flow, map, x, y) {
  if (!flow || !flow.ready) return null;

  const cs = flow.cellSize;
  const cols = flow.cols, rows = flow.rows;

  // 以"格中心"为采样点：格 (i) 的中心在 (i+0.5)*cs
  const gx = x / cs - 0.5;
  const gy = y / cs - 0.5;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const tx = gx - x0, ty = gy - y0;

  let ax = 0, ay = 0;

  for (let dy = 0; dy <= 1; dy++) {
    const cy = y0 + dy;
    if (cy < 0 || cy >= rows) continue;
    const wy = dy === 0 ? 1 - ty : ty;
    if (wy <= 0) continue;

    for (let dx = 0; dx <= 1; dx++) {
      const cx = x0 + dx;
      if (cx < 0 || cx >= cols) continue;
      const wx = dx === 0 ? 1 - tx : tx;
      if (wx <= 0) continue;

      const i = cy * cols + cx;
      const w = wx * wy;
      ax += flow.dirX[i] * w;
      ay += flow.dirY[i] * w;
    }
  }

  const len = Math.hypot(ax, ay);
  if (len < 1e-6) {
    // 四个角都没方向（例如贴着不可达区）：退回脚下那一格
    const i = cellIndexAt(map, x, y);
    const dx = flow.dirX[i], dy = flow.dirY[i];
    if (dx === 0 && dy === 0) return null;
    return { x: dx, y: dy };
  }
  return { x: ax / len, y: ay / len };
}

/**
 * 流场缓存：**按目标格**共享，不按小队。
 *
 * 8 支队伍同时被选中下一个信标时，目标格往往是同一个 —— 于是只算一张场。
 * key 里带 `map.rev`，换图之后旧场自然失效。
 */
export class FlowCache {
  constructor(max = 8) {
    this.max = max;
    this.map = new Map();       // key → field（Map 保持插入顺序，拿来当 LRU）
  }

  static keyOf(map, cellX, cellY) {
    return `${map.rev}:${cellX}:${cellY}`;
  }

  get(key) {
    const f = this.map.get(key);
    if (!f) return null;
    // 命中就提到最近使用
    this.map.delete(key);
    this.map.set(key, f);
    return f;
  }

  set(key, field) {
    this.map.delete(key);
    this.map.set(key, field);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return field;
  }

  has(key) { return this.map.has(key); }
  get size() { return this.map.size; }
  clear() { this.map.clear(); }
}
