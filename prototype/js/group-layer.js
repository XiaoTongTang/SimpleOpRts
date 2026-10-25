/**
 * L1 群体层（软化 Couzin 力场）
 * ---------------------------------------------------------------
 * 职责：把若干"力"合成为加速度，再积分出速度和位置。
 *   分离 / 对齐 / 凝聚 / 威胁 / 寻敌 / 命令 / 边界
 *
 * 不做：小队编成、目标选择、渲染、输入 —— 全部由上层负责。
 *
 * 数据契约（本层只读）：
 *   unit  { x, y, vx, vy, squad, alpha, cAll }
 *   squad { p:{wSep,wAli,wCoh,omega,wCmd,wThreat,wSeek,r4,r5,rRep,rOri,rAtt},
 *           faction, loose, target, goal, cx, cy, cn }
 *   globals { drag, stallSpeed, stallAccel, arriveR }
 */

export const SPD = 96;         // 巡航速度 px/s
export const MAX_ACCEL = 430;  // 加速度上限

// ---------------------------------------------------------------
// 核函数：把 Couzin 的硬边界"软化"成权重曲线
// ---------------------------------------------------------------
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

export function smoothstep(a, b, x) {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
}

/** 分离：靠近才强，d→0 时最大 */
export function sepW(d, r) {
  if (d >= r) return 0;
  const t = 1 - d / r;
  return t * t;
}

/** 对齐：在排斥区外快速抬升，中距平台 */
export function aliW(d, r0) {
  return smoothstep(r0 * 0.75, r0, d);
}

/** 凝聚：在 (r2, r3) 上的钟形窗，两端为 0 */
export function cohW(d, r0, r1) {
  if (d <= r0 || d >= r1) return 0;
  const mid = (r0 + r1) * 0.5;
  return d < mid ? smoothstep(r0, mid, d) : 1 - smoothstep(mid, r1, d);
}

// ---------------------------------------------------------------
// 主步进
// 返回本帧统计量，供 UI 显示；本层不碰 DOM。
// ---------------------------------------------------------------
export function stepUnits(units, squads, G, dt, W, H) {
  const n = units.length;
  let sumAlpha = 0, sumCmd = 0, sumNb = 0, sumSpd = 0, sumCombat = 0;

  for (let i = 0; i < n; i++) {
    const u = units[i];
    const mine = u.squad;
    const sq = squads[mine];
    if (!sq) continue;

    const P = sq.p;
    const myFaction = sq.faction;

    const rRep = P.rRep, rOri = P.rOri, rAtt = P.rAtt;
    const r4 = P.r4, r5 = P.r5;
    const rAtt2 = rAtt * rAtt;
    const R = Math.max(rAtt, r5);   // 感知半径取两者较大
    const R2 = R * R;

    // 累加器
    let sx = 0, sy = 0, sw = 0;             // 分离（已指向反方向）
    let avx = 0, avy = 0, aw = 0;           // 对齐
    let cpx = 0, cpy = 0, cw = 0;           // 凝聚
    let thx = 0, thy = 0, thMax = 0;        // 威胁区
    let skx = 0, sky = 0, skMax = 0;        // 寻敌区
    let cAll = 0;

    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const o = units[j];
      const dx = o.x - u.x, dy = o.y - u.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > R2 || d2 < 1e-9) continue;
      const d = Math.sqrt(d2);

      const oSq = squads[o.squad];
      const oFaction = oSq ? oSq.faction : -1;
      const enemy = (oFaction >= 0 && oFaction !== myFaction);

      // 亲和判定（精确定义）：
      //  · 未编队单位 → 对「同阵营所有单位」计算凝聚与对齐（包括其他散兵）
      //  · 已入队单位 → 仅对「自己小队内」的单位计算凝聚与对齐
      // 障碍物（基地这类静止结构）只参与分离，不算亲和对象，
      // 否则散兵会被吸到基地边缘绕圈。
      const same = sq.loose
        ? (oFaction === myFaction && !o.obstacle)
        : (mine === o.squad);

      // ---- 分离：全局，不分小队、不分阵营 ----
      if (d < rRep) {
        const w = sepW(d, rRep);
        sx -= (dx / d) * w; sy -= (dy / d) * w; sw += w;
      }

      // ---- 战斗参数组：只对敌方生效 ----
      if (enemy) {
        if (d < r4) {
          // 威胁区：d→0 满幅，r4 处归零（与分离力同一个核）
          const t = 1 - d / r4;
          const w = t * t;
          if (w > thMax) thMax = w;
          thx -= (dx / d) * w; thy -= (dy / d) * w;
        } else if (d < r5 && sq.loose) {
          // 局部寻敌：只有「未编队」走这条路径
          const w = smoothstep(r4, r5, d);
          if (w > skMax) skMax = w;
          skx += (dx / d) * w; sky += (dy / d) * w;
        }
        continue;   // 敌方不参与对齐 / 凝聚
      }

      // ---- 友军：只在 r₃ 内统计 ----
      if (d2 > rAtt2) continue;
      cAll++;
      if (!same) continue;

      if (d < rOri) {
        const w = aliW(d, rRep);
        avx += o.vx * w; avy += o.vy * w; aw += w;
      }
      const w2 = cohW(d, rOri, rAtt);
      if (w2 > 0) { cpx += o.x * w2; cpy += o.y * w2; cw += w2; }
    }

    u.cAll = cAll;
    sumNb += cAll;

    // ---- 统一寻敌：正规小队全队朝同一个目标点 ----
    if (!sq.loose && sq.target) {
      const tdx = sq.target.x - u.x, tdy = sq.target.y - u.y;
      const dT = Math.hypot(tdx, tdy) || 1e-6;
      const w = smoothstep(P.r4, P.r5, dT);   // 远处满幅，接近目标时衰减
      if (w > 1e-6) {
        skx = (tdx / dT) * w;
        sky = (tdy / dT) * w;
        skMax = w;
      }
    }

    // ---- 命令通道：只吃本小队的控制点 ----
    let cdx = 0, cdy = 0, cmdMag = 0;
    if (sq.goal) {
      cdx = sq.goal.x - u.x; cdy = sq.goal.y - u.y;
      const distGoal = Math.hypot(cdx, cdy) || 1e-6;
      cdx /= distGoal; cdy /= distGoal;
      cmdMag = P.omega * P.wCmd;
      if (distGoal < G.arriveR) cmdMag *= distGoal / G.arriveR;
    }

    // ---- 加权求和 ----
    let Sx = 0, Sy = 0;   // 社交合力
    let Cx = 0, Cy = 0;   // 命令力
    let Bx = 0, By = 0;   // 战斗合力

    if (sw > 1e-6) {
      const L = Math.hypot(sx, sy) || 1;
      const dvx = (sx / L) * SPD, dvy = (sy / L) * SPD;
      Sx += P.wSep * (dvx - u.vx);
      Sy += P.wSep * (dvy - u.vy);
    }
    if (aw > 1e-6) {
      // 邻居的平均速度（保留幅值）。不能归一化到 SPD——
      // 那样"对齐"会变成永不停机的马达，让无命令的部队永远巡航。
      const dvx = avx / aw, dvy = avy / aw;
      if (dvx * dvx + dvy * dvy > 1) {
        Sx += P.wAli * (dvx - u.vx);
        Sy += P.wAli * (dvy - u.vy);
      }
    }
    if (cw > 1e-6) {
      const tx0 = cpx / cw - u.x, ty0 = cpy / cw - u.y;
      const L = Math.hypot(tx0, ty0);
      if (L > 1e-3) {
        const dvx = (tx0 / L) * SPD, dvy = (ty0 / L) * SPD;
        Sx += P.wCoh * (dvx - u.vx);
        Sy += P.wCoh * (dvy - u.vy);
      }
    }
    if (cmdMag > 1e-6) {
      Cx += cmdMag * (cdx * SPD - u.vx);
      Cy += cmdMag * (cdy * SPD - u.vy);
    }

    // 威胁区：方向取"所有敌人的加权和"，强度取"最近的那个"
    if (thMax > 1e-6) {
      const L = Math.hypot(thx, thy) || 1;
      Bx += P.wThreat * thMax * ((thx / L) * SPD - u.vx);
      By += P.wThreat * thMax * ((thy / L) * SPD - u.vy);
    }
    // 寻敌区：同理
    if (skMax > 1e-6) {
      const L = Math.hypot(skx, sky) || 1;
      Bx += P.wSeek * skMax * ((skx / L) * SPD - u.vx);
      By += P.wSeek * skMax * ((sky / L) * SPD - u.vy);
    }

    let Fx = Sx + Cx + Bx, Fy = Sy + Cy + By;

    // 边界软推（环境力，不计入服从度）
    const BM = 70, BK = 7;
    if (u.x < BM) Fx += (BM - u.x) * BK;
    if (u.x > W - BM) Fx -= (u.x - (W - BM)) * BK;
    if (u.y < BM) Fy += (BM - u.y) * BK;
    if (u.y > H - BM) Fy -= (u.y - (H - BM)) * BK;

    const am = Math.hypot(Fx, Fy);
    if (am > MAX_ACCEL) { Fx = Fx / am * MAX_ACCEL; Fy = Fy / am * MAX_ACCEL; }

    u.vx += Fx * dt;
    u.vy += Fy * dt;

    // 速度阻尼
    if (G.drag > 0) {
      const damp = Math.exp(-G.drag * dt);
      u.vx *= damp; u.vy *= damp;
    }

    const sp = Math.hypot(u.vx, u.vy);
    if (sp > SPD) { u.vx *= SPD / sp; u.vy *= SPD / sp; }
    if (G.stallSpeed > 0 && G.stallAccel > 0 && sp < G.stallSpeed) {
      // 防止完全停滞：沿当前朝向补一点加速度
      const ang0 = Math.atan2(u.vy || 1, u.vx || 0);
      u.vx += Math.cos(ang0) * G.stallAccel * dt;
      u.vy += Math.sin(ang0) * G.stallAccel * dt;
    }

    u.x += u.vx * dt;
    u.y += u.vy * dt;

    // 服从度 = 命令力在净合力中的份额
    const cMag = Math.hypot(Cx, Cy), sMag = Math.hypot(Sx, Sy), bMag = Math.hypot(Bx, By);
    const a = cMag / (cMag + sMag + bMag + 1e-6);
    u.alpha = a;
    sumAlpha += a;
    if (a > 0.5) sumCmd++;
    if (bMag > 1) sumCombat++;

    // 硬边界兜底
    if (u.x < 0) { u.x = 0; u.vx = Math.abs(u.vx); }
    if (u.x > W) { u.x = W; u.vx = -Math.abs(u.vx); }
    if (u.y < 0) { u.y = 0; u.vy = Math.abs(u.vy); }
    if (u.y > H) { u.y = H; u.vy = -Math.abs(u.vy); }

    sumSpd += Math.hypot(u.vx, u.vy);
  }

  return {
    alpha: n ? sumAlpha / n : 0,
    cmd: n ? (sumCmd / n) * 100 : 0,
    nb: n ? sumNb / n : 0,
    spd: n ? sumSpd / n : 0,
    combat: n ? (sumCombat / n) * 100 : 0
  };
}
