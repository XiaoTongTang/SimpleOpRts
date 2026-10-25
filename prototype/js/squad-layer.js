/**
 * L2 小队层
 * ---------------------------------------------------------------
 * 职责：
 *   1. 小队的编成与参数（每队独立的 Couzin 参数）
 *   2. 小队重心、统一寻敌目标
 *   3. 有效兵力的增删
 *
 * 不做：力场计算（那是 L1）、渲染、输入。
 *
 * 层级关系：L3 指挥层 → 【本层】 → L1 群体层
 */

// ---------------------------------------------------------------
// 每队独立的 Couzin 参数定义
// [key, 显示小数位, 默认值]
// ---------------------------------------------------------------
export const P_DEFS = [
  ["wSep", 2, 1.40], ["wAli", 2, 0.85], ["wCoh", 2, 0.75],
  ["omega", 2, 1.10], ["wCmd", 2, 1.20],
  ["wThreat", 2, 1.50], ["wSeek", 2, 1.20],
  ["r4", 0, 90], ["r5", 0, 300],
  ["rRep", 0, 24], ["rOri", 0, 52], ["rAtt", 0, 96],
  ["members", 0, 24]
];

export function makeParams() {
  const p = {};
  for (const [k, , def] of P_DEFS) p[k] = def;
  return p;
}

/** 兜底参数：任何没有归属小队的单位用它 */
export const DEFAULT_P = makeParams();

// ---------------------------------------------------------------
// 全局参数（所有小队共用，不随小队变化）
// ---------------------------------------------------------------
export const GLOBAL_DEFS = [
  ["drag", 2, 0.30],
  ["stallSpeed", 0, 60],
  ["stallAccel", 0, 100],
  ["arriveR", 0, 46]
];

// ---------------------------------------------------------------
// 小队定义：两个阵营 × 4 个正规队 + 双方各 1 个"未编队"
// ---------------------------------------------------------------
export const SQUAD_DEF = [
  { key: "A", faction: 0, hue: 205, sat: 82 },
  { key: "B", faction: 0, hue: 178, sat: 82 },
  { key: "C", faction: 0, hue: 232, sat: 82 },
  { key: "D", faction: 0, hue: 158, sat: 82 },
  { key: "E", faction: 1, hue: 5, sat: 82 },
  { key: "F", faction: 1, hue: 30, sat: 82 },
  { key: "G", faction: 1, hue: 345, sat: 82 },
  { key: "H", faction: 1, hue: 55, sat: 82 },
  // 8 / 9 = 双方各自的"未编队"。行为上仍是完整小队（有阵营、可调参），
  // 区别只有两点：寻敌不走小队统一目标；凝聚力认同阵营内所有单位。
  { key: "散", faction: 0, hue: 210, sat: 26, loose: true },
  { key: "散", faction: 1, hue: 8, sat: 28, loose: true }
];

export const FACTION_COLOR = ["#4fa3e8", "#e8614f"];

export function makeSquads() {
  return SQUAD_DEF.map((d, i) => {
    const p = makeParams();
    if (d.loose) p.members = 6;
    return {
      id: i,
      key: d.key,
      faction: d.faction,
      hue: d.hue,
      sat: d.sat || 82,
      loose: !!d.loose,
      p,
      goal: null,     // 控制点（L3 下达）
      target: null,   // 统一寻敌目标（本层每帧计算）
      cx: 0, cy: 0, cn: 0
    };
  });
}

// ---------------------------------------------------------------
// 重心
// ---------------------------------------------------------------
export function computeCenters(units, squads) {
  for (const s of squads) { s.cn = 0; s.cx = 0; s.cy = 0; }
  for (const u of units) {
    const s = squads[u.squad];
    if (!s) continue;
    s.cn++; s.cx += u.x; s.cy += u.y;
  }
  for (const s of squads) {
    if (s.cn) { s.cx /= s.cn; s.cy /= s.cn; }
  }
}

// ---------------------------------------------------------------
// 统一寻敌目标
// 正规小队：对"小队重心 r₅ 内"的敌人做 1/d² 加权重心，全队共享。
// 未编队：不计算，保持 L1 逐单位的局部寻敌。
// ---------------------------------------------------------------
export function computeSquadTargets(units, squads) {
  for (const sq of squads) {
    sq.target = null;
    if (sq.loose || sq.cn === 0) continue;
    const r5 = sq.p.r5;
    const r52 = r5 * r5;
    let tx = 0, ty = 0, tw = 0;
    for (const e of units) {
      const esq = squads[e.squad];
      if (!esq || esq.faction === sq.faction) continue;
      const dx = e.x - sq.cx, dy = e.y - sq.cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r52) continue;
      const d = Math.sqrt(d2);
      const w = 1 / ((d + 30) * (d + 30));
      tx += e.x * w; ty += e.y * w; tw += w;
    }
    if (tw > 0) sq.target = { x: tx / tw, y: ty / tw };
  }
}

// ---------------------------------------------------------------
// 兵力增删
// ---------------------------------------------------------------
export function countMembers(units, id) {
  let n = 0;
  for (const u of units) if (u.squad === id) n++;
  return n;
}

/**
 * 把某小队的兵力调整到 target（就地增删，不重建全场）
 * 新增单位落在该队重心附近；删除从数组尾部开始。
 */
export function resizeSquad(units, squads, id, target, W, H) {
  const sq = squads[id];
  if (!sq) return;
  target = Math.max(0, Math.floor(target || 0));
  const cur = countMembers(units, id);
  if (target === cur) return;

  if (target > cur) {
    const cx = sq.cn ? sq.cx : W * (sq.faction === 0 ? 0.24 : 0.76);
    const cy = sq.cn ? sq.cy : H * 0.5;
    for (let k = cur; k < target; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 55;
      units.push({
        x: cx + Math.cos(a) * r,
        y: cy + Math.sin(a) * r,
        vx: 0, vy: 0,
        squad: id, alpha: 0, cAll: 0
      });
    }
  } else {
    let drop = cur - target;
    for (let i = units.length - 1; i >= 0 && drop > 0; i--) {
      if (units[i].squad === id) { units.splice(i, 1); drop--; }
    }
  }
  computeCenters(units, squads);
}

// ---------------------------------------------------------------
// 参数复制
//   mode = "faction" → 同阵营 4 队
//   mode = "all"     → 全部小队
// ---------------------------------------------------------------
export function copyParams(squads, srcId, mode) {
  const src = squads[srcId];
  if (!src) return [];
  const hit = mode === "faction"
    ? squads.filter(s => s.faction === src.faction)
    : squads.slice();
  const p = { ...src.p };
  for (const s of hit) s.p = { ...p };
  return hit;
}
