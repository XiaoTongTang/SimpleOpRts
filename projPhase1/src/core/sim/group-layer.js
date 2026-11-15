/**
 * L1 群体层（质量速度模型）
 * ---------------------------------------------------------------
 * 职责：把若干"力"（px/s²）累加起来，除以质量、乘阻尼、积分出速度与位置。
 *   分离 / 对齐 / 凝聚 / 威胁 / 寻敌 / 命令 / 低速助推 / 边界
 *
 * 与旧版的区别只在**力的语义与积分方式**，判定结构一字未改：
 *   · 分离：全局，不分小队不分阵营
 *   · 对齐 / 凝聚：只对"亲和"邻居（正规小队 = 自己队；散兵 = 同阵营）
 *   · 威胁 / 寻敌：只对敌方
 *   · 三区**互斥**：进了分离区就不对齐、不凝聚（照搬沙盒）
 *
 * 不做：小队编成、目标选择、渲染、输入。
 *
 * 数据契约（本层只读）：
 *   unit  { x, y, vx, vy, squad, hx, hy, radius, mass, alpha, cAll }
 *   squad { p:{sepRadius,alignRadius,cohRadius,sepForce,alignForce,cohForce,
 *              threatForce,seekForce,commandForce,arriveR,smallPushShare,r4,r5},
 *           faction, loose, target, goal, cx, cy, cn }
 *   globals { damping, mass, boostSpeed, boostForce, maxSpeedFactor, softWall? }
 */

import {
  sepWeight, smoothstep, integrateUnit, updateHeading,
  alignForce as computeAlignForce, cohesionForce as computeCohesionForce
} from "./force-model.js";
import { moveUnitWithWalls } from "./wall-collision.js";
import { directionAt } from "./flow-field.js";

/** 参考巡航速度（px/s）。只用于安全阀与参数换算，不再是硬上限。 */
export const SPD = 96;

/**
 * 主步进
 * 返回本帧统计量，供 UI 显示；本层不碰 DOM。
 *
 * @param map 地图（可选）。给了就按墙体硬碰撞推进位置；不给就是裸积分（单测用）。
 */
export function stepUnits(units, squads, G, dt, W, H, map = null) {
  const n = units.length;
  let sumAlpha = 0, sumCmd = 0, sumNb = 0, sumSpd = 0, sumCombat = 0;

  // 分离判据改成表面间隙后，两个大个体的触发圆心距会超过 sepRadius，
  // 所以剪枝上限必须把"最肥的那个"的半径算进去。每帧一次。
  let maxRadius = 0;
  for (let i = 0; i < n; i++) {
    const r = units[i].radius;
    if (r > maxRadius) maxRadius = r;
  }

  for (let i = 0; i < n; i++) {
    const u = units[i];
    const mine = u.squad;
    const sq = squads[mine];
    if (!sq) continue;

    const P = sq.p;
    const myFaction = sq.faction;

    // 朝向必须存在才能算对齐与助推
    if (u.hx === undefined) updateHeading(u);

    const sepRadius = P.sepRadius;
    const alignRadius = P.alignRadius;
    const cohRadius = P.cohRadius;
    const r4 = P.r4;
    const r5 = P.r5;
    const cohR2 = cohRadius * cohRadius;

    const reach = Math.max(sepRadius + 2 * maxRadius, alignRadius, cohRadius);
    const reach2 = reach * reach;

    const smallPush = P.smallPushShare >= 100 ? 1
      : (P.smallPushShare <= 0 ? 0 : P.smallPushShare / 100);

    // 累加器
    let sepX = 0, sepY = 0, sepCount = 0;         // 分离（已指向反方向）
    let aliX = 0, aliY = 0, aliCount = 0;         // 对齐（邻居朝向单位向量之和）
    let cohX = 0, cohY = 0, cohCount = 0;         // 凝聚（指向质心的位移和）
    let thX = 0, thY = 0, thMax = 0;              // 威胁区
    let skX = 0, skY = 0, skMax = 0;              // 寻敌区
    let cAll = 0;

    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const o = units[j];
      const dx = o.x - u.x, dy = o.y - u.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > reach2 || d2 < 1e-12) continue;
      const d = Math.sqrt(d2);

      const oSq = squads[o.squad];
      const oFaction = oSq ? oSq.faction : -1;
      const enemy = (oFaction >= 0 && oFaction !== myFaction);

      // 亲和判定：
      //  · 未编队单位 → 对「同阵营所有单位」算凝聚与对齐（包括其他散兵）
      //  · 已入队单位 → 仅对「自己小队内」的单位
      const same = sq.loose
        ? (oFaction === myFaction && !o.obstacle)
        : (mine === o.squad);

      // 分离判据：表面间隙，不是圆心距
      const gap = d - ((u.radius || 0) + (o.radius || 0));
      const inSepZone = gap <= sepRadius;

      // ---- 分离：**全局**，不分小队、不分阵营（所以必须排在敌我分支之前）----
      if (inSepZone) {
        let w = sepWeight(gap, sepRadius);
        // 比自己小的邻居只能推得动自己的一部分（"是大船围绕小船还是反过来"）
        if ((o.radius || 0) < (u.radius || 0)) w *= smallPush;
        if (w > 0) {
          sepX -= (dx / d) * w;
          sepY -= (dy / d) * w;
          sepCount++;
        }
      }

      if (oFaction === myFaction && d2 <= cohR2) cAll++;

      // ---- 战斗参数组：只对敌方 ----
      if (enemy) {
        if (d < r4) {
          // 威胁区：d→0 满幅，r4 处归零
          const t = 1 - d / r4;
          const w = t * t;
          if (w > thMax) thMax = w;
          thX -= (dx / d) * w;
          thY -= (dy / d) * w;
        } else if (d < r5 && sq.loose) {
          // 局部寻敌：只有「未编队」走这条路径
          const w = smoothstep(r4, r5, d);
          if (w > skMax) skMax = w;
          skX += (dx / d) * w;
          skY += (dy / d) * w;
        }
        continue;   // 敌方不进社交区（对齐 / 凝聚）
      }

      // ---- 对齐 / 凝聚：三区互斥，且在分离区里一律不参与 ----
      if (inSepZone) {
        // 已贡献分离力，这一对不再贡献对齐与凝聚
      } else if (same && d <= alignRadius) {
        aliX += o.hx || 0;
        aliY += o.hy || 0;
        aliCount++;
      } else if (same && d <= cohRadius) {
        cohX += dx;
        cohY += dy;
        cohCount++;
      }
    }

    u.cAll = cAll;
    sumNb += cAll;

    // ---- 统一寻敌：正规小队全队朝同一个目标点 ----
    if (!sq.loose && sq.target) {
      const tdx = sq.target.x - u.x, tdy = sq.target.y - u.y;
      const dT = Math.hypot(tdx, tdy) || 1e-6;
      const w = smoothstep(r4, r5, dT);   // 远处满幅，接近目标时衰减
      if (w > 1e-6) {
        skX = (tdx / dT) * w;
        skY = (tdy / dT) * w;
        skMax = w;
      }
    }

    // ---- 命令通道：只吃本小队的命令点 ----
    // 方向优先读本队流场（双线性插值，能绕障且没有阶梯），
    // 没有场（还没算好 / 没有地图 / 该处不可达）就退回直线。
    let cmdX = 0, cmdY = 0, cmdPull = 0;
    if (sq.goal) {
      let dx = 0, dy = 0;

      const flowDir = map ? directionAt(sq.flow, map, u.x, u.y) : null;
      if (flowDir) {
        dx = flowDir.x;
        dy = flowDir.y;
      } else {
        const gdx = sq.goal.x - u.x;
        const gdy = sq.goal.y - u.y;
        const L = Math.hypot(gdx, gdy) || 1e-6;
        dx = gdx / L;
        dy = gdy / L;
      }

      cmdX = dx;
      cmdY = dy;
      const distGoal = Math.hypot(sq.goal.x - u.x, sq.goal.y - u.y) || 1e-6;
      const arriveR = P.arriveR > 0 ? P.arriveR : 1;
      cmdPull = distGoal < arriveR ? distGoal / arriveR : 1;
    }

    // ---- 合成（全部是 px/s²）----
    // 分成四组累加，组内先做矢量和，再做组间相加：
    //   社交 / 战斗 / 命令 参与「服从度」统计；环境力（边界）不参与。
    let sx = 0, sy = 0;   // 社交合力
    let bx = 0, by = 0;   // 战斗合力
    let cx = 0, cy = 0;   // 命令力
    let wx = 0, wy = 0;   // 环境力

    if (sepCount > 0 && P.sepForce > 0) {
      sx += P.sepForce * sepX;
      sy += P.sepForce * sepY;
    }

    if (aliCount > 0 && P.alignForce > 0) {
      const af = computeAlignForce(aliX, aliY, u, P.alignForce);
      if (af) { sx += af[0]; sy += af[1]; }
    }

    if (cohCount > 0 && P.cohForce > 0) {
      const cf = computeCohesionForce(cohX, cohY, P.cohForce);
      if (cf) { sx += cf[0]; sy += cf[1]; }
    }

    // 威胁 / 寻敌：方向归一、强度取"最近的那个"
    if (thMax > 1e-6) {
      const L = Math.hypot(thX, thY) || 1;
      bx += P.threatForce * thMax * (thX / L);
      by += P.threatForce * thMax * (thY / L);
    }
    if (skMax > 1e-6) {
      const L = Math.hypot(skX, skY) || 1;
      bx += P.seekForce * skMax * (skX / L);
      by += P.seekForce * skMax * (skY / L);
    }

    // 命令力：方向指向本队命令点（阶段 5 之后改为读流场）
    if (cmdPull > 0 && P.commandForce > 0) {
      cx += P.commandForce * cmdPull * cmdX;
      cy += P.commandForce * cmdPull * cmdY;
    }

    // 低速助推：沿当前朝向补一把，防止完全停滞。
    //
    // 【设计，不是缺陷，请勿"修复"】
    // 这条力**无条件生效**（只要速度低于 boostSpeed），所以没有命令信标时，
    // 每艘船都会沿各自朝向维持 ~boostForce/damping 的巡航速度 —— 这就是
    // 「无命令时集群自己随机游走」的行为来源。副作用是队伍会慢慢散开，
    // 那是刻意的：部队闲着不该钉死在原地。**不要加"有命令才助推"之类的门。**
    const speed = Math.hypot(u.vx, u.vy);
    if (G.boostSpeed > 0 && speed < G.boostSpeed) {
      wx += G.boostForce * u.hx;
      wy += G.boostForce * u.hy;
    }

    // 边界：有地图时由 collectCircleWallContacts 的世界边框半平面处理；
    //       没有地图（单测）时不做任何边界处理，交给调用方。
    integrateUnit(u, sx + bx + cx + wx, sy + by + cy + wy, G, dt, SPD);

    const radius = u.radius || 0;
    if (map) {
      moveUnitWithWalls(map, u, radius, dt);
    } else {
      u.x += u.vx * dt;
      u.y += u.vy * dt;
    }
    updateHeading(u);

    // 服从度 = 命令力在合力里的份额（组内先矢量和，与旧模型同口径）
    const cMag = Math.hypot(cx, cy);
    const sMag = Math.hypot(sx, sy);
    const bMag = Math.hypot(bx, by);
    const a = cMag / (cMag + sMag + bMag + 1e-6);
    u.alpha = a;
    sumAlpha += a;
    if (a > 0.5) sumCmd++;
    if (bMag > 1) sumCombat++;

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
