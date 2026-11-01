/**
 * 单位 / 弹丸 的绘制
 * 只依赖 canvas 2D context 和数据，不依赖任何游戏状态。
 */

/** 单位颜色：色相 = 小队，亮度 = 基础亮度 + 服从度 α（lum 可整体提亮/压暗） */
export function unitColor(u, squads) {
  const sq = squads ? squads[u.squad] : null;
  if (!sq) return "hsl(215,18%," + (32 + u.alpha * 28).toFixed(1) + "%)";

  // flatLum 给定时亮度恒等于它，不再受 α 影响
  // （没有玩家指挥的场景里 α 恒为 0，亮度编码失效，索性钉死以便和色块完全一致）
  const light = sq.flatLum != null
    ? sq.flatLum
    : Math.max(8, 32 + u.alpha * 28 + (sq.lum || 0));

  return "hsl(" + sq.hue + "," + sq.sat + "%," + light.toFixed(1) + "%)";
}

/** 画一个单位小箭头（+x 方向为朝向） */
export function drawUnitGlyph(ctx, x, y, angle, scale, color) {
  ctx.save();
  ctx.translate(x, y);
  if (angle) ctx.rotate(angle);
  if (scale !== 1) ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.moveTo(6.4, 0);
  ctx.lineTo(-4.2, 3.6);
  ctx.lineTo(-2.4, 0);
  ctx.lineTo(-4.2, -3.6);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/**
 * 画所有单位：三角本体 + 护盾环 + 充能器标记 + 血条
 * @param ctx     canvas 2D context
 * @param units   单位数组
 * @param squads  小队数组（取 hue / sat），可为 null
 */
export function drawUnits(ctx, units, squads) {
  // 本体
  for (const u of units) {
    if (u.base) continue;              // 基地由调用方单独绘制
    drawUnitGlyph(ctx, u.x, u.y, Math.atan2(u.vy, u.vx), 1, unitColor(u, squads));
  }

  // 护盾环 + 充能器标记 + 血条
  for (const u of units) {
    if (u.base) continue;
    if (u.shield > 0) {
      ctx.beginPath();
      ctx.arc(u.x, u.y, 8.6, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(120,210,255,.8)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    if (u.charger) {
      ctx.beginPath();
      ctx.arc(u.x, u.y + 8.5, 1.9, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,210,110,.95)";
      ctx.fill();
    }
    if (u.hp < u.maxHp) {
      const bw = 13, bh = 2.2;
      const bx2 = u.x - bw / 2, by2 = u.y - 11.5;
      const f = Math.max(0, u.hp / u.maxHp);
      ctx.fillStyle = "rgba(6,10,16,.72)";
      ctx.fillRect(bx2, by2, bw, bh);
      ctx.fillStyle = f > 0.5 ? "#5fd97a" : f > 0.25 ? "#e8c14a" : "#e8564f";
      ctx.fillRect(bx2, by2, bw * f, bh);
    }
  }
}

/**
 * 画飞行中的弹丸。三种拖尾：
 *   style "smoke"  —— 一串软烟团（鱼雷，直飞）
 *   style "line"   —— 一条弯曲的渐变线（导弹，会拐弯；用航迹点画，所以能显示弧线）
 *   style "streak" —— 一小段亮线（链炮，细小的线形射弹）
 */
export function drawProjectiles(ctx, projectiles) {
  for (const p of projectiles) {
    const sp = Math.hypot(p.vx, p.vy) || 1;
    const ux = p.vx / sp, uy = p.vy / sp;
    const hue = p.hue === undefined ? 30 : p.hue;

    if (p.style === "streak") {
      drawStreakTrail(ctx, p, ux, uy, hue);   // 线本身就是弹体，不再画头部方块
      continue;
    }

    if (p.style === "line") drawLineTrail(ctx, p, ux, uy, hue);
    else drawSmokeTrail(ctx, p, ux, uy, hue);

    // 弹体大小跟着 contactR 走：命中半径大的弹，视觉上也该更大
    const s = Math.max(0.8, Math.min(1.6, (p.contactR || 4) / 4));
    drawHead(ctx, p, ux, uy, hue, s);
  }
}

/**
 * 线形射弹：一小段沿航向的高亮线 + 泛白芯。
 * 用 additive 混合，所以在暗背景上是"发光的细线"，不是实体弹丸。
 */
function drawStreakTrail(ctx, p, ux, uy, hue) {
  const LEN = 13;
  const tx = p.x - ux * LEN, ty = p.y - uy * LEN;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";

  // 外发光
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(p.x, p.y);
  ctx.strokeStyle = "hsla(" + hue + ",88%,62%,.18)";
  ctx.lineWidth = 2.6;
  ctx.stroke();

  // 中间的实色（小队色相）
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(p.x, p.y);
  ctx.strokeStyle = "hsla(" + hue + ",85%,76%,.50)";
  ctx.lineWidth = 1.3;
  ctx.stroke();

  // 泛白芯 + 箭头那一点最亮
  ctx.beginPath();
  ctx.moveTo(p.x - ux * LEN * 0.55, p.y - uy * LEN * 0.55);
  ctx.lineTo(p.x, p.y);
  ctx.strokeStyle = "hsla(" + hue + ",35%,97%,.58)";
  ctx.lineWidth = 0.7;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(p.x, p.y, 1.0, 0, Math.PI * 2);
  ctx.fillStyle = "hsla(" + hue + ",25%,99%,.56)";
  ctx.fill();

  ctx.restore();
}

/** 烟团拖尾：一串逐渐变小变淡、并带双频摆动的软团 */
function drawSmokeTrail(ctx, p, ux, uy, hue) {
  const perpX = -uy, perpY = ux;        // 垂直于航向，用来让烟迹有扰动
  const seed = p.seed || 0;
  const TRAIL = 32;

  ctx.save();
  for (let k = 9; k >= 1; k--) {
    const f = k / 9;                                   // 0 靠近弹体 → 1 尾端
    const d = f * TRAIL;
    const wob = (Math.sin(d * 0.34 + seed) * 1.6 +
                 Math.sin(d * 0.13 + seed * 2.7) * 1.1) * f;
    const px2 = p.x - ux * d + perpX * wob;
    const py2 = p.y - uy * d + perpY * wob;
    const rr = 2.8 * (1 - f) + 0.5;
    ctx.beginPath();
    ctx.arc(px2, py2, rr, 0, Math.PI * 2);
    ctx.fillStyle = "hsla(" + hue + ",72%,65%," + (0.38 * (1 - f)) + ")";
    ctx.fill();
  }
  ctx.restore();
}

/**
 * 线状拖尾：直接连 p.path 里的航迹点。
 * 因为用的是历史位置而不是"速度反方向"，所以导弹拐弯时拖尾会跟着弯。
 */
function drawLineTrail(ctx, p, ux, uy, hue) {
  const path = p.path;
  const n = path ? (path.length / 2) | 0 : 0;

  if (n >= 2) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // 主体：从尾（细、淡）到头（粗、亮）
    for (let k = 0; k + 3 < path.length; k += 2) {
      const f = (k / 2) / (n - 1);
      ctx.beginPath();
      ctx.moveTo(path[k], path[k + 1]);
      ctx.lineTo(path[k + 2], path[k + 3]);
      ctx.lineWidth = 0.5 + f * 1.4;
      ctx.strokeStyle = "hsla(" + hue + ",88%," + (56 + f * 18).toFixed(0) +
                        "%," + (0.03 + f * 0.28).toFixed(3) + ")";
      ctx.stroke();
    }

    // 亮芯：只画最近 1/3，制造"灼热"感
    const tailCount = Math.floor(n / 3) * 2;
    const from = Math.max(0, path.length - tailCount - 2);
    if (from + 3 < path.length) {
      ctx.beginPath();
      ctx.moveTo(path[from], path[from + 1]);
      for (let k = from + 2; k + 1 < path.length; k += 2) {
        ctx.lineTo(path[k], path[k + 1]);
      }
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = "hsla(" + hue + ",55%,93%,.40)";
      ctx.stroke();
    }

    ctx.restore();
  }

  // 头部微光
  ctx.save();
  const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 6);
  g.addColorStop(0, "hsla(" + hue + ",90%,82%,.26)");
  g.addColorStop(1, "hsla(" + hue + ",90%,60%,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 弹体：实心长方块 + 前端高光。s = 视觉缩放（由 contactR 决定） */
function drawHead(ctx, p, ux, uy, hue, s) {
  const k = s || 1;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(Math.atan2(uy, ux));
  ctx.fillStyle = "hsl(" + hue + ",84%,80%)";
  ctx.fillRect(-1.9 * k, -1.15 * k, 3.8 * k, 2.3 * k);
  ctx.fillStyle = "hsla(" + hue + ",40%,96%,.92)";
  ctx.fillRect(0.5 * k, -0.7 * k, 1.3 * k, 1.4 * k);   // 前端一点点高光，指明朝向
  ctx.restore();
}
