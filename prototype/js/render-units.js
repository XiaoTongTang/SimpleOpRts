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

/** 画飞行中的鱼雷（带尾烟） */
export function drawProjectiles(ctx, projectiles) {
  for (const p of projectiles) {
    const sp = Math.hypot(p.vx, p.vy) || 1;
    const ux = p.vx / sp, uy = p.vy / sp;
    const perpX = -uy, perpY = ux;        // 垂直于航向，用来让烟迹有扰动
    const seed = p.seed || 0;
    const hue = p.hue === undefined ? 30 : p.hue;
    const TRAIL = 32;

    ctx.save();

    // 尾烟：一串逐渐变小变淡、并带双频摆动的软团
    // （单一正弦会显得规律，叠两个不同频率才像飘散的烟）
    for (let k = 9; k >= 1; k--) {
      const f = k / 9;                                   // 0 靠近弹体 → 1 尾端
      const d = f * TRAIL;
      const wob = (Math.sin(d * 0.34 + seed) * 1.6 +
                   Math.sin(d * 0.13 + seed * 2.7) * 1.1) * f;
      const px2 = p.x - ux * d + perpX * wob;
      const py2 = p.y - uy * d + perpY * wob;
      const rr = 2.6 * (1 - f) + 0.45;
      ctx.beginPath();
      ctx.arc(px2, py2, rr, 0, Math.PI * 2);
      ctx.fillStyle = "hsla(" + hue + ",70%,58%," + (0.30 * (1 - f)) + ")";
      ctx.fill();
    }

    // 弹体：很小的实心长方块（普通混合，不发白）
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.atan2(uy, ux));
    ctx.fillStyle = "hsl(" + hue + ",82%,74%)";
    ctx.fillRect(-1.9, -1.15, 3.8, 2.3);
    ctx.fillStyle = "hsla(" + hue + ",40%,94%,.9)";
    ctx.fillRect(0.5, -0.7, 1.3, 1.4);    // 前端一点点高光，指明朝向
    ctx.restore();
  }
}
