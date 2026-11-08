/**
 * 支援系统：护盾充能与维修
 * -----------------------------------------------------------------
 * 设计见 design/261107_2机制改进/支援能力设计.md
 *
 * 一个循环解决两种能力：
 *   找半径内友军 → 按需要程度排序取前 N 个 → 每个每秒 +rate 点某资源 → 不超过上限
 *
 * 三条必须守住的规则：
 *   1. **两遍遍历**：先累加 gain，再统一应用。否则结果依赖 units 数组顺序，
 *      同一局面跑两次血量不同 —— 这是最难复现的一类 bug。
 *   2. **护盾上限每帧从零重算**（base + 本帧收到的最大 grant），不缓存「我被谁照着」。
 *      充能器死了/飞走了，下一帧自动回落，没有残留状态。
 *   3. **dt 封顶**：切标签页回来时一帧可能跑 5 秒，不封顶会瞬间奶满全场。
 *
 * 排序必须带单位索引做最终 tiebreak，否则同血量目标会在帧间来回抢名额，数值抖动。
 */

/** 单帧最大推进步长（秒） */
export const MAX_SUPPORT_DT = 0.05;

/** 同一艘船两次支援特效的最小间隔（秒） */
export const FX_PERIOD = 0.4;

/**
 * @param units   全部单位（会被就地修改 hp / shield）
 * @param squads  小队数组（取 faction 与 p.abilities）
 * @param grid    空间索引（可为 null，退回全量扫描）
 * @param dt      步长（秒）
 * @param fx      特效数组（可为 null）
 */
export function stepSupport(units, squads, grid, dt, fx) {
  if (!(dt > 0)) return;
  if (dt > MAX_SUPPORT_DT) dt = MAX_SUPPORT_DT;

  // ---- ① 清空本帧累加器 ----
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    u.gainHp = 0;
    u.gainShield = 0;
    u.grantMax = 0;
  }

  const cand = [];

  // ---- ② 收集 ----
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.hp <= 0) continue;

    const sq = squads[u.squad];
    const list = sq?.p?.abilities;
    if (!list || list.length === 0) continue;

    u.fxCd = (u.fxCd || 0) - dt;
    const wantFx = !!fx && u.fxCd <= 0;
    let emitted = false;

    for (let ai = 0; ai < list.length; ai++) {
      const a = list[ai];
      if (!(a.radius > 0) || !(a.rate > 0) || !(a.maxTargets > 0)) continue;

      // 宽相位
      cand.length = 0;
      if (grid) {
        grid.queryCircle(u.x, u.y, a.radius, cand);
      } else {
        for (let j = 0; j < units.length; j++) cand.push(j);
      }

      // 窄相位 + 需求过滤
      const r2 = a.radius * a.radius;
      const pick = [];
      for (let k = 0; k < cand.length; k++) {
        const j = cand[k];
        const t = units[j];
        if (t.hp <= 0) continue;
        if (t === u) {
          if (!a.includeSelf) continue;
        }
        if (squads[t.squad]?.faction !== sq.faction) continue;

        const dx = t.x - u.x, dy = t.y - u.y;
        if (dx * dx + dy * dy > r2) continue;

        // 满了的不修，浪费。
        // 护盾的有效上限要把「这一发即将给的上限加成」算进去，
        // 否则本身没护盾容量的船永远进不了候选，充能器就废了。
        if (a.resource === "hull") {
          if (t.hp >= t.maxHp) continue;
        } else {
          if (t.shield >= capFor(t, a)) continue;
        }
        pick.push(j);
      }
      if (pick.length === 0) continue;

      // 排序：先按需要程度，再按距离，最后按索引（保证全序 & 确定性）
      pick.sort((p, q) => {
        const A = units[p], B = units[q];
        const d = needOf(A, a) - needOf(B, a);
        if (d !== 0) return d;
        const d2 = dist2(A, u) - dist2(B, u);
        if (d2 !== 0) return d2;
        return p - q;
      });

      const take = Math.min(a.maxTargets, pick.length);
      const amount = a.rate * dt;

      for (let k = 0; k < take; k++) {
        const t = units[pick[k]];
        if (a.resource === "hull") {
          t.gainHp += amount;
        } else {
          t.gainShield += amount;
          // 上限加成取 max，不叠加：5 台充能器也不会把上限顶到 200
          if (a.grant > t.grantMax) t.grantMax = a.grant;
        }
      }

      // 视觉：每艘支援舰每 FX_PERIOD 最多发一条，只发给第一个目标
      if (wantFx && !emitted) {
        const t = units[pick[0]];
        fx.push({
          type: "supportlink",
          hue: a.resource === "shield" ? 195 : 140,
          x1: u.x, y1: u.y,
          x2: t.x, y2: t.y,
          rEnd: 8.6,
          life: 0.3, max: 0.3
        });
        emitted = true;
      }
    }

    if (emitted) u.fxCd = FX_PERIOD;
  }

  // ---- ③ 应用 ----
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.hp <= 0) continue;

    const base = u.maxShieldBase || 0;
    const cap = base + u.grantMax;
    u.shieldCap = cap;

    if (u.gainShield > 0 && u.shield < cap) {
      u.shield = Math.min(cap, u.shield + u.gainShield);
    }
    if (u.gainHp > 0 && u.hp < u.maxHp) {
      u.hp = Math.min(u.maxHp, u.hp + u.gainHp);
    }
    // 光环离开后回落（立即 clamp）
    if (u.shield > cap) u.shield = cap;
  }
}

/**
 * 需要程度：越小越优先
 *   修血 → 血量百分比
 *   充盾 → 护盾百分比（满盾的已在过滤阶段排除）
 */
function needOf(t, a) {
  if (a.resource === "hull") return t.maxHp > 0 ? t.hp / t.maxHp : 1;
  const cap = capFor(t, a);
  return cap > 0 ? t.shield / cap : 1;
}

/** 目标本帧的护盾有效上限：基础容量 + max(已收到的加成, 本次将给的加成) */
function capFor(t, a) {
  const base = t.maxShieldBase || 0;
  const grant = Math.max(t.grantMax || 0, a.grant || 0);
  return base + grant;
}

function dist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}
