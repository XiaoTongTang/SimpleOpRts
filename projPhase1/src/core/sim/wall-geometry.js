/**
 * 墙体几何（地图平滑 / 格角倒角）
 * -----------------------------------------------------------------
 * 墙由方格拼成，凸角是 90°。船贴着墙角滑过去会先撞上这个台阶再被推开（"顿一下"），
 * 视觉上也只是像素方块的边缘。**把每个"暴露在外"的方格角切掉一个 45° 等腰三角形**，
 * 墙角从 90° 变成 135° 斜面，等效于用多边形近似圆角。
 *
 * 本文件是**唯一几何来源**：碰撞（wall-collision.js）与渲染（render-pixi.js）都调它。
 * 两边各画各的是最容易出的错 —— 玩家会看到"船离墙角还有半个格就被弹开"。
 *
 * 纯函数，无状态，可在 Node 里裸跑（见 test/chamfer.smoke.mjs）。
 */

/**
 * 切进深度，单位是"格长的倍数"。
 *
 * 1.0 = 沙盒原样：从格的一个角切到对角，一个暴露角切掉**半格面积**。
 *       厚墙没问题，但薄墙会碎：2×2 方块变菱形、1 格厚墙的端头塌成三角、
 *       孤立单格四角全切后塌成一点（碰撞直接失效）。
 * 0.5 = 本项目的取值：只切半格，一个暴露角切掉 12.5% 面积。
 *       墙角仍然是 45° 斜面（8 px 格上是 4 px 倒角），但不会把方块啃成菱形。
 */
export const CHAMFER_DEPTH_CELLS = 0.5;

/** 四个角的位掩码 */
export const CORNER_TL = 1;
export const CORNER_TR = 2;
export const CORNER_BR = 4;
export const CORNER_BL = 8;

/**
 * 哪些角"暴露在外"：只有该角的两条**正交**邻格都是空地才算。
 * 只看正交、不看对角是刻意的近似 —— 对角是墙时那里是凹口，切了会把凹口填平。
 */
export function getWallChamferMask(map, cx, cy) {
  const L = map.isWall(cx - 1, cy);
  const R = map.isWall(cx + 1, cy);
  const T = map.isWall(cx, cy - 1);
  const B = map.isWall(cx, cy + 1);

  // 孤立柱：四邻全空。四个角都"暴露"，全切就没东西了 —— 保持完整方块。
  if (!L && !R && !T && !B) return 0;

  let m = 0;
  if (!L && !T) m |= CORNER_TL;
  if (!R && !T) m |= CORNER_TR;
  if (!R && !B) m |= CORNER_BR;
  if (!L && !B) m |= CORNER_BL;
  return m;
}

/**
 * 用一条半平面裁多边形（Sutherland–Hodgman），保留 valueAt >= 0 的部分。
 * @param points [[x,y], ...]
 * @param valueAt (x,y) => number
 */
export function clipPolygonHalfPlane(points, valueAt) {
  if (points.length === 0) return points;
  const out = [];

  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    const next = points[(i + 1) % points.length];
    const cv = valueAt(cur[0], cur[1]);
    const nv = valueAt(next[0], next[1]);
    const cIn = cv >= 0;
    const nIn = nv >= 0;

    if (cIn) out.push([cur[0], cur[1]]);

    if (cIn !== nIn) {
      const den = cv - nv;
      if (Math.abs(den) > 1e-12) {
        const t = cv / den;
        out.push([cur[0] + (next[0] - cur[0]) * t, cur[1] + (next[1] - cur[1]) * t]);
      }
    }
  }
  return out;
}

/**
 * 一个墙格的碰撞多边形（倒角后）。
 * @returns [[x,y], ...] 世界坐标；不是墙、或退化到 < 3 顶点时返回 null
 */
export function getChamferedCellPolygon(map, cx, cy) {
  if (!map.isWall(cx, cy)) return null;

  const C = map.cellSize;
  const t = C * CHAMFER_DEPTH_CELLS;
  const left = cx * C, top = cy * C;
  const right = left + C, bottom = top + C;

  let pts = [[left, top], [right, top], [right, bottom], [left, bottom]];
  const mask = getWallChamferMask(map, cx, cy);
  if (mask === 0) return pts;

  // 每个角：保留"离该角至少 t 的切比雪夫距离"那一侧
  if (mask & CORNER_TL) {
    pts = clipPolygonHalfPlane(pts, (x, y) => (x - left) + (y - top) - t);
  }
  if (mask & CORNER_TR) {
    pts = clipPolygonHalfPlane(pts, (x, y) => (right - x) + (y - top) - t);
  }
  if (mask & CORNER_BR) {
    pts = clipPolygonHalfPlane(pts, (x, y) => (right - x) + (bottom - y) - t);
  }
  if (mask & CORNER_BL) {
    pts = clipPolygonHalfPlane(pts, (x, y) => (x - left) + (bottom - y) - t);
  }

  return pts.length >= 3 ? pts : null;
}

/** 多边形面积（正数）。测试与调试用。 */
export function polygonArea(pts) {
  if (!pts || pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}
