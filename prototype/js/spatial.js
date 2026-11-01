/**
 * 空间索引层（均匀网格）
 * -----------------------------------------------------------------
 * 职责：只回答「这个形状附近有哪些单位」。
 *       不知道阵营、不知道伤害、不知道编队 —— 它只做索引，不做决策。
 *
 * 设计见 design/261101_1武器系统改造/05-空间索引层.md
 *
 * 范围（D10）：只服务武器系统。群体层（L1）不接入。
 *
 * 三条铁律：
 *   1. 格子里只存**下标**，位置永远只有一份（在 units[i] 上）
 *   2. 返回的是**候选集**（宽相位），精确判定由调用方做（窄相位）
 *   3. 桶数组复用，clear() 只清 length，不重新分配
 *
 * 用平铺数组而不是哈希表：战场是固定矩形，格子下标直接算，比字符串键快一个数量级。
 */

export const CELL = 64;

/** 单位半径的预留量：将来加了 u.hitR 之后仍然不漏格。
 *  多查一点是无害的 —— 窄相位会再精确过滤一遍。 */
export const UNIT_PAD = 8;

/** 单位受击半径的默认值（渲染箭头的等效半径约 4.5）。
 *  真正的值由 initCombat 从 sq.p.hitR 写入，这里只是兜底。 */
export const DEFAULT_HIT_R = 4.5;

export class Grid {
  /**
   * @param w 战场宽（px）
   * @param h 战场高（px）
   * @param cell 格长（px）
   */
  constructor(w, h, cell = CELL) {
    this.cell = cell;
    this.cols = Math.max(1, Math.ceil(w / cell));
    this.rows = Math.max(1, Math.ceil(h / cell));
    this.n = this.cols * this.rows;

    this.buckets = new Array(this.n);
    for (let i = 0; i < this.n; i++) this.buckets[i] = [];

    // querySegment 沿线段多次采样，同一格会被采到多次 —— 用时间戳去重，零分配
    this._stamp = new Int32Array(this.n);
    this._sid = 0;
  }

  /** 窗口尺寸变化时重建（很少发生，无所谓） */
  setSize(w, h) {
    const cols = Math.max(1, Math.ceil(w / this.cell));
    const rows = Math.max(1, Math.ceil(h / this.cell));
    if (cols === this.cols && rows === this.rows) return false;

    this.cols = cols;
    this.rows = rows;
    this.n = cols * rows;
    this.buckets = new Array(this.n);
    for (let i = 0; i < this.n; i++) this.buckets[i] = [];
    this._stamp = new Int32Array(this.n);
    this._sid = 0;
    return true;
  }

  /** 只清长度，不 new 数组 —— 否则每帧产生上百个短命数组，GC 抖动 */
  clear() {
    for (let i = 0; i < this.n; i++) this.buckets[i].length = 0;
  }

  /** 每个单位只放进**一个**格子（按自身位置算）→ 查询天然无重复 */
  insert(i, u) {
    const c = this.cell;
    let gx = (u.x / c) | 0;
    let gy = (u.y / c) | 0;
    if (gx < 0) gx = 0; else if (gx >= this.cols) gx = this.cols - 1;
    if (gy < 0) gy = 0; else if (gy >= this.rows) gy = this.rows - 1;
    this.buckets[gy * this.cols + gx].push(i);
  }

  /**
   * 圆形查询（宽相位）
   * @param out 调用方复用的数组，本函数只 push
   */
  queryCircle(x, y, r, out) {
    const c = this.cell, cs = this.cols, rs = this.rows;
    let x0 = ((x - r) / c) | 0;
    let x1 = ((x + r) / c) | 0;
    let y0 = ((y - r) / c) | 0;
    let y1 = ((y + r) / c) | 0;
    if (x0 < 0) x0 = 0; if (x1 >= cs) x1 = cs - 1;
    if (y0 < 0) y0 = 0; if (y1 >= rs) y1 = rs - 1;

    for (let gy = y0; gy <= y1; gy++) {
      const row = gy * cs;
      for (let gx = x0; gx <= x1; gx++) {
        const b = this.buckets[row + gx];
        for (let k = 0; k < b.length; k++) out.push(b[k]);
      }
    }
    return out;
  }

  /**
   * 线段查询（宽相位）
   * 沿线段走格子，**不是**取包围盒 —— 长线段只有一维，沿线的格子很少。
   * （包围盒会退化成 (长+2r)² 的大方块，一条 250px 的射线要多查 8 倍格子。）
   *
   * 采样步长取半格，保证不跳格。
   */
  querySegment(x0, y0, x1, y1, r, out) {
    const c = this.cell, cs = this.cols, rs = this.rows;
    const rad = Math.max(0, Math.ceil(r / c));   // 半径占几格
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);

    this._sid++;
    const stamp = this._stamp, sid = this._sid;

    const steps = Math.max(1, Math.ceil(len / (c * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      let gx = ((x0 + dx * t) / c) | 0;
      let gy = ((y0 + dy * t) / c) | 0;
      if (gx < 0) gx = 0; else if (gx >= cs) gx = cs - 1;
      if (gy < 0) gy = 0; else if (gy >= rs) gy = rs - 1;

      for (let oy = -rad; oy <= rad; oy++) {
        const ny = gy + oy;
        if (ny < 0 || ny >= rs) continue;
        const row = ny * cs;
        for (let ox = -rad; ox <= rad; ox++) {
          const nx = gx + ox;
          if (nx < 0 || nx >= cs) continue;
          const idx = row + nx;
          if (stamp[idx] === sid) continue;      // 这一格本轮已经收过
          stamp[idx] = sid;
          const b = this.buckets[idx];
          for (let k = 0; k < b.length; k++) out.push(b[k]);
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------
// 调试开关
// ---------------------------------------------------------------------

/** brute = true 时，所有查询退化成「全部单位」，用于差分测试与性能对比 */
export const SpatialDebug = { brute: false };

/** 统计量，用来验证「候选集确实变小了」 */
export const SpatialStats = {
  queries: 0,
  candidates: 0,     // 宽相位给出的候选数累计
  reset() { this.queries = 0; this.candidates = 0; },
};

// ---------------------------------------------------------------------
// 扫掠圆命中判定（窄相位）
// ---------------------------------------------------------------------

/**
 * 半径 r 的弹丸从 (x0,y0) 走到 (x1,y1)，是否撞上半径 R、圆心 (cx,cy) 的圆。
 *
 * 推导见 design/261101_1武器系统改造/02-命中判定-扫掠圆.md：
 *   把「圆撞圆」化成「点撞大圆」（闵可夫斯基和，半径相加），
 *   于是 |p(t) − c|² = rr² 展开成 a·t² + b·t + cc = 0，套求根公式。
 *
 * 参数故意用**标量**而不是 {x, y} 对象：这个函数将来每帧会被调上千次，
 * 每帧上千个短命对象的代价不值得。
 *
 * @returns {number} 命中时刻 t ∈ [0,1]；未命中返回 -1
 */
export function sweptHit(x0, y0, x1, y1, r, cx, cy, R) {
  const dx = x1 - x0, dy = y1 - y0;
  const fx = x0 - cx,  fy = y0 - cy;
  const rr = R + r;                                 // 闵可夫斯基和

  if (fx * fx + fy * fy <= rr * rr) return 0;       // 帧首已重叠（含贴边）

  const a = dx * dx + dy * dy;                      // |d|²
  if (a < 1e-9) return -1;                          // 静止弹丸撞不到任何东西

  const b   = 2 * (fx * dx + fy * dy);              // 2(f·d)
  const cc  = fx * fx + fy * fy - rr * rr;          // |f|² − rr²
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return -1;                          // 直线都无交点，线段更不会有

  const t = (-b - Math.sqrt(disc)) / (2 * a);       // 取左根 = 进入时刻
  return (t >= 0 && t <= 1) ? t : -1;
}
