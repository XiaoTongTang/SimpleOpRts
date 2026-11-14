/**
 * 墙体硬碰撞
 * -----------------------------------------------------------------
 * 只回答一个问题：**这个圆现在压进了哪些墙、要往哪推、推多远。**
 *
 * 做法：圆 × 倒角多边形 → 每条边做一次"点到线段"投影 → 取最近的那条边作为接触，
 * 沿法线把圆推到刚好相切，然后**只去掉法向速度**（切向保留，于是会沿墙滑）。
 *
 * 三条约定：
 *   1. 越界一律算墙（`map.isWall` 处理），所以"图外"和"墙里"走同一条路径
 *   2. **搜格窗口必须由半径推出来** —— 写死 3×3 会让大圆压进墙里再被弹出（历史 bug）
 *   3. 坐标积分在这里做（`moveUnitWithWalls`），速度积分在 force-model 里
 *
 * 设计见 design/261114_1鸟群算法迁移/迁移设计.md §3.6。
 */

import { getChamferedCellPolygon } from "./wall-geometry.js";

/** 子步进：单步位移不超过格长的这个比例，保证不会一帧穿墙 */
const SUBSTEP_CELL_RATIO = 0.45;
const MAX_SUBSTEPS = 48;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 圆与一个倒角墙格的接触。
 * @returns {null | {normalX, normalY, closestX, closestY, distance, depth}}
 *          normal 指向**把圆推开**的方向
 */
export function getCellContact(map, cx, cy, x, y, radius) {
  const points = getChamferedCellPolygon(map, cx, cy);
  if (!points) return null;

  let inside = true;
  let bestD2 = Infinity;
  let bestX = 0, bestY = 0, bestNx = 0, bestNy = 0;

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];

    // 多边形按顺时针给，叉积为负说明点在所有边的同侧之外
    const cross = ex * (y - a[1]) - ey * (x - a[0]);
    if (cross < -1e-7) inside = false;

    const e2 = ex * ex + ey * ey;
    if (e2 <= 1e-12) continue;                  // 退化边（倒角后可能出现的重合点）

    const proj = clamp(((x - a[0]) * ex + (y - a[1]) * ey) / e2, 0, 1);
    const px = a[0] + ex * proj;
    const py = a[1] + ey * proj;
    const dx = x - px, dy = y - py;
    const d2 = dx * dx + dy * dy;

    if (d2 < bestD2) {
      const len = Math.sqrt(e2);
      bestD2 = d2;
      bestX = px; bestY = py;
      bestNx = ey / len;                        // 边的左法线（指向圆外）
      bestNy = -ex / len;
    }
  }

  if (bestD2 === Infinity) return null;         // 整个多边形退化
  const distance = Math.sqrt(bestD2);

  if (inside) {
    if (distance > 1e-9) {
      return {
        normalX: (bestX - x) / distance,
        normalY: (bestY - y) / distance,
        closestX: bestX, closestY: bestY,
        distance,
        depth: radius + distance                // 圆心在墙里：要推出去 radius + 到边距离
      };
    }
    return { normalX: bestNx, normalY: bestNy, closestX: bestX, closestY: bestY, distance: 0, depth: radius };
  }

  if (distance >= radius) return null;          // 没碰到

  if (distance > 1e-9) {
    return {
      normalX: (x - bestX) / distance,
      normalY: (y - bestY) / distance,
      closestX: bestX, closestY: bestY,
      distance,
      depth: radius - distance
    };
  }
  return { normalX: bestNx, normalY: bestNy, closestX: bestX, closestY: bestY, distance: 0, depth: radius };
}

/**
 * 收集一个圆当前的所有墙体接触：世界边框（4 条半平面）+ 附近的墙格。
 */
export function collectCircleWallContacts(map, x, y, radius, out = []) {
  out.length = 0;

  const W = map.width, H = map.height;

  // ---- 世界边框 ----
  if (x < radius) {
    out.push({ normalX: 1, normalY: 0, closestX: 0, closestY: y, distance: Math.abs(x), depth: radius - x });
  }
  if (x > W - radius) {
    out.push({ normalX: -1, normalY: 0, closestX: W, closestY: y, distance: Math.abs(x - W), depth: radius - (W - x) });
  }
  if (y < radius) {
    out.push({ normalX: 0, normalY: 1, closestX: x, closestY: 0, distance: Math.abs(y), depth: radius - y });
  }
  if (y > H - radius) {
    out.push({ normalX: 0, normalY: -1, closestX: x, closestY: H, distance: Math.abs(y - H), depth: radius - (H - y) });
  }

  // ---- 附近的墙格 ----
  // 窗口必须按半径扩张：半径 13 的个体能碰到 2 格之外的墙格，
  // 固定 3×3 会漏掉这些接触，于是圆能压进墙里、再被突然冒出来的深接触弹飞。
  const C = map.cellSize;
  const centerX = Math.floor(x / C);
  const centerY = Math.floor(y / C);
  const reach = Math.max(1, Math.ceil(radius / C));

  const minX = Math.max(0, centerX - reach);
  const maxX = Math.min(map.cols - 1, centerX + reach);
  const minY = Math.max(0, centerY - reach);
  const maxY = Math.min(map.rows - 1, centerY + reach);
  const r2 = radius * radius;

  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      if (!map.isWall(cx, cy)) continue;

      // AABB 快速排除（圆心在格内时不排除）
      const left = cx * C, top = cy * C;
      const right = left + C, bottom = top + C;
      const ax = clamp(x, left, right);
      const ay = clamp(y, top, bottom);
      const inAabb = x >= left && x <= right && y >= top && y <= bottom;
      const adx = x - ax, ady = y - ay;
      if (!inAabb && adx * adx + ady * ady > r2) continue;

      const contact = getCellContact(map, cx, cy, x, y, radius);
      if (contact) out.push(contact);
    }
  }

  return out;
}

/** 取最深的那个接触（推得最多） */
export function findDeepestContact(contacts) {
  let deepest = null;
  for (let i = 0; i < contacts.length; i++) {
    if (!deepest || contacts[i].depth > deepest.depth) deepest = contacts[i];
  }
  return deepest;
}

/** 只去掉法向速度，切向保留 —— 于是船会沿墙滑而不是粘住 */
export function removeNormalVelocity(u, nx, ny) {
  const vn = u.vx * nx + u.vy * ny;
  u.vx -= vn * nx;
  u.vy -= vn * ny;
}

/** 这个位置上放一个半径 radius 的圆，会不会压到墙 */
export function isBlockedCircle(map, x, y, radius) {
  const tmp = [];
  collectCircleWallContacts(map, x, y, radius, tmp);
  return tmp.length > 0;
}

const CONTACT_SCRATCH = [];

/**
 * 把已经压进墙里的单位推出来（就地修改 x/y）。
 * @returns {boolean} 是否发生过推出
 */
export function resolveUnitWall(map, u, radius) {
  const contacts = collectCircleWallContacts(map, u.x, u.y, radius, CONTACT_SCRATCH);
  if (contacts.length === 0) return false;

  const deepest = findDeepestContact(contacts);
  if (!deepest) return false;

  u.x += deepest.normalX * deepest.depth;
  u.y += deepest.normalY * deepest.depth;
  removeNormalVelocity(u, deepest.normalX, deepest.normalY);

  // 凹角里可能同时压两面墙：再复查两遍（只推位置，不再改速度）
  for (let pass = 0; pass < 2; pass++) {
    const again = collectCircleWallContacts(map, u.x, u.y, radius, CONTACT_SCRATCH);
    if (again.length === 0) break;
    const c = findDeepestContact(again);
    if (!c) break;
    u.x += c.normalX * c.depth;
    u.y += c.normalY * c.depth;
  }
  return true;
}

/**
 * 按速度推进一个单位，途中处理墙体。
 * 子步进保证单步位移 ≤ 0.45 格，所以不会一帧穿过一堵墙。
 */
export function moveUnitWithWalls(map, u, radius, dt) {
  let remaining = dt;
  let iterations = 0;

  while (remaining > 1e-9 && iterations < MAX_SUBSTEPS) {
    const speed = Math.hypot(u.vx, u.vy);
    const stepDt = speed > 1e-9
      ? Math.min(remaining, (map.cellSize * SUBSTEP_CELL_RATIO) / speed)
      : remaining;

    u.x += u.vx * stepDt;
    u.y += u.vy * stepDt;
    resolveUnitWall(map, u, radius);

    remaining -= stepDt;
    iterations++;
  }
}

/**
 * 在 (x,y) 附近找一个不压墙的落点。
 * @param rand 注入的随机数（保持确定性）
 * @returns {{x, y} | null}
 */
export function findFreeSpawnPoint(map, x, y, spread, radius, rand, attempts = 24) {
  // 偏置：第一发就是原点（大多数情况本来就空）
  if (!isBlockedCircle(map, x, y, radius)) return { x, y };

  for (let i = 0; i < attempts; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * spread;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (px < radius || py < radius || px > map.width - radius || py > map.height - radius) continue;
    if (!isBlockedCircle(map, px, py, radius)) return { x: px, y: py };
  }
  return null;
}

/**
 * 整张图随便找个空地（兜底）。随机采样，不用 BFS —— 兜底路径不该有 O(N) 的开销。
 */
export function findRandomFloorPoint(map, radius, rand, attempts = 64) {
  const C = map.cellSize;
  for (let i = 0; i < attempts; i++) {
    const cx = Math.floor(rand() * map.cols);
    const cy = Math.floor(rand() * map.rows);
    if (map.isWall(cx, cy)) continue;
    const px = (cx + 0.5) * C;
    const py = (cy + 0.5) * C;
    if (px < radius || py < radius || px > map.width - radius || py > map.height - radius) continue;
    if (!isBlockedCircle(map, px, py, radius)) return { x: px, y: py };
  }
  return null;
}
