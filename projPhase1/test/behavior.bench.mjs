/**
 * 行为基线 / 迁移对照
 *   node test/behavior.bench.mjs
 *
 * 这个脚本**不做断言**，只打印指标。作用是在迁移前后各跑一次，用同一张表对比"变好还是变坏"。
 * 迁移设计里的验收口径都从这里取数：
 *   - 平均速度（阶段 2：45.8 → 40–55）
 *   - 队形紧凑度 k（阶段 2：≤ 0.55）
 *   - 信标到达时间（阶段 2：与基线偏差 ≤ 20%）
 *   - 朝向抖动（阶段 6：二阶差分标准差下降 ≥ 60%）
 *   - 单步耗时、单步 Δv 峰值（阶段 2/3/4 的稳定性）
 *
 * 固定 seed，所以同一次改动前后的数字可比。
 */

import { GameCore } from "../src/core/core.js";

const W = 2000, H = 1200;
const SEED = 7;
const DT = 1 / 60;

// ------------------------------------------------------------------
// 工具
// ------------------------------------------------------------------

const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const median = a => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const std = a => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
};

const pad = (s, n) => String(s).padEnd(n);
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");

/** 整局指纹：和 determinism.smoke 同一口径，方便跨阶段比对 */
function fingerprint(core) {
  let h = 0;
  for (const u of core.units) {
    h += Math.round(u.x * 1000) + Math.round(u.y * 1000) * 3
       + Math.round((u.hp || 0) * 1000) * 7 + Math.round((u.shield || 0) * 1000) * 11;
  }
  return { n: core.units.length, hash: h };
}

/**
 * 队形紧凑度 k = Rg / (d_nn × √N)
 *   Rg    回转半径（相对质心）
 *   d_nn  平均最近邻距离
 * 与 r1/r3/力权重无关，是纯形状指标（见 design/分层架构与每层职责.md）
 */
function compactness(core) {
  const bySquad = new Map();
  for (const u of core.units) {
    if (!bySquad.has(u.squad)) bySquad.set(u.squad, []);
    bySquad.get(u.squad).push(u);
  }
  const ks = [];
  for (const list of bySquad.values()) {
    const n = list.length;
    if (n < 4) continue;
    let cx = 0, cy = 0;
    for (const u of list) { cx += u.x; cy += u.y; }
    cx /= n; cy /= n;

    let rg2 = 0;
    for (const u of list) {
      const dx = u.x - cx, dy = u.y - cy;
      rg2 += dx * dx + dy * dy;
    }
    const Rg = Math.sqrt(rg2 / n);

    let dnn = 0;
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dx = list[i].x - list[j].x, dy = list[i].y - list[j].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < best) best = d2;
      }
      dnn += Math.sqrt(best);
    }
    dnn /= n;
    if (dnn > 1e-6) ks.push(Rg / (dnn * Math.sqrt(n)));
  }
  return median(ks);
}

/**
 * 跑一局，同时收集逐帧指标。
 * @param frames 帧数
 * @param opts   { sampleHeading, onFrame }
 */
function run(core, frames, opts = {}) {
  const prevV = new Map();          // unit -> [vx, vy]
  const dvAll = [];
  const dvNearWall = [];
  const headingJitter = [];

  // 朝向二阶差分：需要前两帧的展开角
  const angHist = new Map();        // unit -> [a_{n-2}, a_{n-1}]
  let unwrapped = new Map();        // unit -> 累计展开角

  for (let f = 0; f < frames; f++) {
    for (const u of core.units) {
      const p = prevV.get(u);
      if (p) {
        const dv = Math.hypot(u.vx - p[0], u.vy - p[1]);
        dvAll.push(dv);
        const nearWall = u.x < 80 || u.x > W - 80 || u.y < 80 || u.y > H - 80;
        if (nearWall) dvNearWall.push(dv);
      }
      prevV.set(u, [u.vx, u.vy]);

      if (opts.sampleHeading !== false) {
        const sp = Math.hypot(u.vx, u.vy);
        if (sp > 5) {
          const a = Math.atan2(u.vy, u.vx);
          const prevUn = unwrapped.get(u);
          if (prevUn === undefined) {
            unwrapped.set(u, a);
          } else {
            let d = a - (prevUn % (Math.PI * 2));
            if (d > Math.PI) d -= Math.PI * 2;
            if (d < -Math.PI) d += Math.PI * 2;
            const un = prevUn + d;
            unwrapped.set(u, un);
            const h = angHist.get(u);
            if (h) headingJitter.push(Math.abs(un - 2 * h[1] + h[0]));
            angHist.set(u, [h ? h[1] : un, un]);
          }
        }
      }
    }
    core.step(DT);
    if (opts.onFrame) opts.onFrame(f);
  }

  // 存活的单位才计入(死掉的船会污染 prevV，但它已经不在 units 里了)
  return {
    dvMax: dvAll.length ? Math.max(...dvAll) : 0,
    dvP999: percentile(dvAll, 0.999),
    dvNearMax: dvNearWall.length ? Math.max(...dvNearWall) : 0,
    jitterStd: std(headingJitter),
    angHist,
  };
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

// ------------------------------------------------------------------
// 各项测量
// ------------------------------------------------------------------

function measureSteady() {
  const core = new GameCore({ width: W, height: H, seed: SEED });
  core.step(DT);                                   // 预热

  const t0 = performance.now();
  const r = run(core, 600);
  const ms = (performance.now() - t0) / 600;

  let spd = 0;
  for (const u of core.units) spd += Math.hypot(u.vx, u.vy);
  spd /= core.units.length || 1;

  return {
    units: core.units.length,
    msPerStep: ms,
    avgSpeed: spd,
    k: compactness(core),
    ...fingerprint(core),
    dvMax: r.dvMax,
    dvP999: r.dvP999,
    dvNearMax: r.dvNearMax,
    jitterStd: r.jitterStd,
  };
}

/** 命令信标：把 0 号小队派到一个 600 px 外的点，量到达时间 */
function measureArrive() {
  const core = new GameCore({ width: W, height: H, seed: SEED });
  for (let i = 0; i < 60; i++) core.step(DT);      // 先让它稳定

  const sx = core.squads[0].cx, sy = core.squads[0].cy;   // 起点要先存下来（sq 是活引用）
  const gx = Math.min(W - 200, sx + 620);
  const gy = Math.max(200, sy - 380);
  core.command({ type: "setGoal", squadId: 0, x: gx, y: gy });

  let sec = -1;
  for (let f = 0; f < 60 * 25; f++) {
    core.step(DT);
    const d = Math.hypot(core.squads[0].cx - gx, core.squads[0].cy - gy);
    if (d < 60) { sec = (f + 1) * DT; break; }
  }
  return { dist: Math.hypot(gx - sx, gy - sy), sec };
}

/** 挤压测试：把一侧的反方单位全塞进角落，看单步 Δv 峰值 */
function measureCorner() {
  const core = new GameCore({ width: W, height: H, seed: SEED });
  // 所有红方单位集中到右下角
  for (const u of core.units) {
    const sq = core.squads[u.squad];
    if (!sq || sq.faction !== 1) continue;
    u.x = W - 120 + (Math.random() - 0.5) * 40;
    u.y = H - 120 + (Math.random() - 0.5) * 40;
  }
  const r = run(core, 600, { sampleHeading: false });
  return { dvMax: r.dvMax, dvP999: r.dvP999 };
}

// ------------------------------------------------------------------
// 输出
// ------------------------------------------------------------------

console.log("\n══════ 行为基线 / 迁移对照 ══════");
console.log(`世界 ${W}×${H}　seed ${SEED}　dt ${DT.toFixed(4)}`);

const s = measureSteady();
console.log("\n[稳态 600 帧]");
console.log(`  ${pad("单位数", 16)} ${s.units}`);
console.log(`  ${pad("单步耗时", 16)} ${num(s.msPerStep, 3)} ms`);
console.log(`  ${pad("平均速度", 16)} ${num(s.avgSpeed, 1)} px/s`);
console.log(`  ${pad("队形紧凑度 k", 16)} ${num(s.k, 3)}   (只记录，不判定)`);
console.log(`  ${pad("朝向抖动 σ", 16)} ${num(s.jitterStd, 5)} rad`);
console.log(`  ${pad("单步 Δv 峰值", 16)} ${num(s.dvMax, 1)} px/s`);
console.log(`  ${pad("单步 Δv p99.9", 16)} ${num(s.dvP999, 1)} px/s`);
console.log(`  ${pad("贴边 Δv 峰值", 16)} ${num(s.dvNearMax, 1)} px/s`);
console.log(`  ${pad("指纹", 16)} n=${s.n} hash=${s.hash}`);

const a = measureArrive();
console.log("\n[命令信标 0 号小队]");
console.log(`  ${pad("直线距离", 16)} ${num(a.dist, 0)} px`);
console.log(`  ${pad("到达(<60px)", 16)} ${a.sec < 0 ? "超时(25s)" : num(a.sec, 2) + " s"}`);

const c = measureCorner();
console.log("\n[挤压：红方全部塞进右下角 600 帧]");
console.log(`  ${pad("单步 Δv 峰值", 16)} ${num(c.dvMax, 1)} px/s`);
console.log(`  ${pad("单步 Δv p99.9", 16)} ${num(c.dvP999, 1)} px/s`);
console.log("");
