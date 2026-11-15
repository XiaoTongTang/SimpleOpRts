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

import { rand } from "./rng.js";
import { FORMATIONS } from "../data/formation-templates.js";

// ---------------------------------------------------------------
// 每队独立的 Couzin 参数定义（质量速度模型）
// [key, 显示小数位, 默认值]
//
// 与旧表的对应（换算见 design/261114_1鸟群算法迁移/迁移设计.md §3.1.2）：
//   wSep    → sepForce    = wSep    × SPD
//   wAli    → alignForce  = wAli    × SPD
//   wCoh    → cohForce    = wCoh    × SPD
//   wThreat → threatForce = wThreat × SPD
//   wSeek   → seekForce   = wSeek   × SPD
//   omega × wCmd → commandForce
//   rRep    → sepRadius    （**语义变了**：旧的是圆心距，新的是表面间隙）
//   rOri    → alignRadius  （判据没变，直接沿用）
//   rAtt    → cohRadius    （同上）
//   G.arriveR   → arriveR         （全局下沉到小队：战术参数）
//   沙盒全局     → smallPushShare （全局下沉到小队：谁围绕谁，是编队战术）
//
// ⚠ 阶段 2 的 sepRadius 仍然按**圆心距**填（= 旧 rRep），因为这一步只换力模型，
//   单位半径还没进分离判据。阶段 3 会把它改成 `rRep − 2 × r_ref`，并让 u.radius 进入 gap。
// ---------------------------------------------------------------
// ⚠ 移动参数**直接从 form.default 派生**，不再抄一份数字。
//   为什么：散兵池建队时 `form === null`（见 state.js createBuild），spawnAll 里
//   `if (b.form) applyFormation(...)` 不会执行，于是它**只用这份默认值**。
//   两边一旦各写一份就会漂——曾经出现过散兵 commandForce=127 而编队队 51，
//   同一条命令散兵跑 159 px/s、编队队 64 px/s，差 2.5 倍。
const DP = FORMATIONS["form.default"].p;

export const P_DEFS = [
  // —— 移动 / 阵型（只被 group-layer 读取）——
  ["sepForce", 0, DP.sepForce], ["alignForce", 0, DP.alignForce], ["cohForce", 0, DP.cohForce],
  ["threatForce", 0, DP.threatForce], ["seekForce", 0, DP.seekForce], ["commandForce", 0, DP.commandForce],
  ["sepRadius", 0, DP.sepRadius], ["alignRadius", 0, DP.alignRadius], ["cohRadius", 0, DP.cohRadius],
  ["r4", 0, DP.r4], ["r5", 0, DP.r5],
  ["arriveR", 0, DP.arriveR],
  ["smallPushShare", 0, DP.smallPushShare],
  ["members", 0, 24],
  // —— 战斗（只被 defense-system 读取，与移动完全解耦）——
  // 护盾充能/维修不在参数表里：那是 support-system 读的 abilities，来自装配
  ["hp", 0, 100], ["regen", 2, 2.00],
  ["maxShield", 0, 0], ["shieldRegen", 2, 0.0]
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
//
// 实际生效值在 core.js 的 this.G；这里放的是**定义 + 元数据**：
// 阵型编辑界面的「全局参数」卡片、以及 setGlobalParams 的夹值都读它。
// ---------------------------------------------------------------
export const GLOBAL_PARAM_DEFS = [
  { k: "damping", name: "粘性阻尼 λ", min: 0, max: 6, step: 0.05, dec: 2,
    desc: "速度的自然衰减率（1/s）。越大停得越快、抖动衰减越快，但转向也越「黏」" },
  { k: "mass", name: "全局质量", min: 0.2, max: 5, step: 0.1, dec: 1,
    desc: "加速度 = 力 / (单位质量 × 它)。调大等于所有力一起变弱" },
  { k: "boostSpeed", name: "助推阈值", min: 0, max: 200, step: 5, dec: 0,
    desc: "速度低于这个值就沿当前朝向补推力，是「无命令时集群自己游走」的来源" },
  { k: "boostForce", name: "助推力", min: 0, max: 400, step: 10, dec: 0,
    desc: "低速助推的力度（px/s²）。0 = 关掉游走，舰队会停住" },
  { k: "maxSpeedFactor", name: "限速系数", min: 0.5, max: 3, step: 0.05, dec: 2,
    desc: "速度上限 = 巡航速度 × 它。只是安全阀，正常战斗不该顶到" }
];

export const GLOBAL_PARAM_KEYS = GLOBAL_PARAM_DEFS.map(d => d.k);

/** 把全局参数夹进合法区间并按元数据取整 */
export function clampGlobalParam(key, value) {
  const def = GLOBAL_PARAM_DEFS.find(d => d.k === key);
  const v = Number(value);
  if (!def) return Number.isFinite(v) ? v : 0;
  if (!Number.isFinite(v)) return def.min;
  return Number(Math.min(def.max, Math.max(def.min, v)).toFixed(def.dec));
}

// ---------------------------------------------------------------
// 小队定义：两个阵营 × 4 个正规队 + 双方各 1 个"未编队"
//
// 小队**不再有自己的颜色**：战场上只有阵营色，所有单位按阵营着色。
// 配色常量放在这里是因为 sim 层不依赖渲染层，渲染层反过来可以读它。
// ---------------------------------------------------------------
export const FACTION_HUE = [205, 6];                               // HSL 色相
export const FACTION_COLOR = ["#4fa3e8", "#e8614f"];               // UI / 贴图着色

export const SQUAD_DEF = [
  { key: "A", faction: 0 },
  { key: "B", faction: 0 },
  { key: "C", faction: 0 },
  { key: "D", faction: 0 },
  { key: "E", faction: 1 },
  { key: "F", faction: 1 },
  { key: "G", faction: 1 },
  { key: "H", faction: 1 },
  // 8 / 9 = 双方各自的"未编队"。行为上仍是完整小队（有阵营、可调参），
  // 区别只有两点：寻敌不走小队统一目标；凝聚力认同阵营内所有单位。
  { key: "散", faction: 0, loose: true },
  { key: "散", faction: 1, loose: true }
];

/**
 * 按模板造一个小队（不加入数组）
 * @param def  { key?, hue?, sat?, loose?, weapon?, p?: {...} }  只写要覆盖的参数
 * @param id   小队 id（必须等于它在 squads 数组里的下标）
 * @param faction 0 / 1
 */
export function makeSquad(def, id, faction) {
  const p = makeParams();
  if (def.p) Object.assign(p, def.p);
  p.weapon = def.weapon || "laser";
  return {
    id,
    key: def.key || def.name || ("T" + id),
    faction: def.faction !== undefined ? def.faction : faction,
    loose: !!def.loose,
    p,
    goal: null, target: null,
    flow: null,          // 命令力的流场（每队一张，按目标格共享缓存，见 sim/flow-field.js）
    cx: 0, cy: 0, cn: 0
  };
}

/** 追加一个小队，返回它的 id */
export function addSquad(squads, def, faction) {
  const id = squads.length;
  squads.push(makeSquad(def, id, faction));
  return id;
}

export function makeSquads() {
  return SQUAD_DEF.map((d, i) => {
    const sq = makeSquad(d, i, d.faction);
    if (d.loose) { sq.p.members = 6; }
    return sq;
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
 *
 * @param initFn 可选，(unit) => void。所有新单位 push 完之后统一调用，
 *               用来给它们装上所属方案的战斗属性（保持随机数的消耗顺序不变）。
 */
export function resizeSquad(units, squads, id, target, W, H, initFn = null) {
  const sq = squads[id];
  if (!sq) return;
  target = Math.max(0, Math.floor(target || 0));
  const cur = countMembers(units, id);
  if (target === cur) return;

  if (target > cur) {
    const cx = sq.cn ? sq.cx : W * (sq.faction === 0 ? 0.24 : 0.76);
    const cy = sq.cn ? sq.cy : H * 0.5;
    const fresh = [];
    for (let k = cur; k < target; k++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * 55;
      const u = {
        x: cx + Math.cos(a) * r,
        y: cy + Math.sin(a) * r,
        vx: 0, vy: 0,
        squad: id, alpha: 0, cAll: 0
      };
      units.push(u);
      fresh.push(u);
    }
    if (initFn) for (const u of fresh) initFn(u);
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
