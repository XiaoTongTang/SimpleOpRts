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
 * 纯函数，无状态，可在 Node 里裸跑（见 test/wall.smoke.mjs 的 [1][2]）。
 */

/**
 * 倒角**没有"深度"这个参数**：一格只要触发倒角，就固定切掉一半。
 *
 * 几何写死成一条对角线（格左上角为原点、C = cellSize）：
 *   TL 角保留 (x - left) + (y - top) >= C      —— 切线从 (left, top+C) 连到 (left+C, top)
 * 所以一个暴露角正好掉 **半格面积**，切面长度是 C × √2。
 *
 * 为什么不做参数：倒角只是"把 90° 墙角磨掉"，磨多少不该是可调项；
 * 它以**格**为单位表达，于是整张地图等比放大时，斜面也跟着等比变长（格长 8 → 11.3 px，
 * 格长 24 → 33.9 px）。这与"世界尺寸 = 格数 × 格长"是同一件事，不需要第二个开关。
 *
 * 薄墙被削细是地图设计的事（别画太薄的墙），游戏内不判定墙还剩多少面积。
 * 唯一必须兜住的是**孤立单格**：四个角全是暴露角，切完就没有多边形、没有碰撞，
 * 船能直接穿过去。所以四邻全空时不切（见 getWallChamferMask）。
 */

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
  const t = C;                                  // 固定切一半：切线就是对角线
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
