/**
 * 武器与护盾特效的绘制
 * 只依赖 canvas 2D context 和 fx 数组，不依赖任何游戏状态。
 *
 * fx 里每个元素至少包含：type / life / max / hue
 * 有 delay 的元素在倒计时结束前不画（用于命中火花错峰）。
 */
export function drawFx(ctx, fx) {
  for (const e of fx) {
    if (e.delay > 0) continue;                          // 还没轮到它
    const t = Math.max(0, e.life / e.max);              // 1 → 0
    const hue = e.hue === undefined ? 200 : e.hue;      // 统一用所属小队的色相

    if (e.type === "beam") {
      // 瞬时线段：激光与贯穿射线共用（贯穿射线只是略粗）
      const ws = e.w || 1;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";

      // 外发光（很薄，压暗）
      ctx.strokeStyle = "hsla(" + hue + ",72%,52%," + (0.20 * t) + ")";
      ctx.lineWidth = 2.4 * ws;
      ctx.beginPath(); ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); ctx.stroke();

      // 芯（同色系高光，不用纯白）
      ctx.strokeStyle = "hsla(" + hue + ",82%,74%," + (0.58 * t) + ")";
      ctx.lineWidth = 0.9 * ws;
      ctx.beginPath(); ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); ctx.stroke();

      // 枪口闪光（小）
      ctx.beginPath();
      ctx.arc(e.x1, e.y1, (1.1 + 1.8 * t) * ws, 0, Math.PI * 2);
      ctx.fillStyle = "hsla(" + hue + ",82%,66%," + (0.45 * t) + ")";
      ctx.fill();

      // 命中点闪光（小）
      ctx.beginPath();
      ctx.arc(e.x2, e.y2, (1.6 + 2.4 * t) * ws, 0, Math.PI * 2);
      ctx.fillStyle = "hsla(" + hue + ",55%,86%," + (0.65 * t) + ")";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(e.x2, e.y2, (3.4 + 3.6 * t) * ws, 0, Math.PI * 2);
      ctx.strokeStyle = "hsla(" + hue + ",78%,60%," + (0.28 * t) + ")";
      ctx.lineWidth = 0.9;
      ctx.stroke();
      ctx.restore();

    } else if (e.type === "rayshot") {
      // 贯穿射线：① 先亮瞄准线 ② 再射出带拖尾的小方块
      const el = e.max - e.life;
      const aim = e.aim, fly = e.fly;
      const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const prog = el <= aim ? 0 : Math.min(1, (el - aim) / fly);
      // 瞄准线：瞄准阶段满亮，方块飞出后逐渐淡去
      const lineT = el <= aim
        ? 1
        : Math.max(0.12, 1 - ((el - aim) / Math.max(0.001, e.max - aim)) * 1.15);

      ctx.save();
      ctx.globalCompositeOperation = "lighter";

      // ① 瞄准线（压暗，只交代方向，不抢戏）
      ctx.strokeStyle = "hsla(" + hue + ",70%,55%," + (0.15 * lineT) + ")";
      ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); ctx.stroke();
      ctx.strokeStyle = "hsla(" + hue + ",75%,80%," + (0.26 * lineT) + ")";
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); ctx.stroke();
      ctx.restore();

      // ② 拖尾小方块：飞到 80% 之后开始变淡，到尽头完全消失
      if (prog > 0) {
        const fade = prog <= 0.8 ? 1 : Math.max(0, 1 - (prog - 0.8) / 0.2);
        const hx = e.x1 + dx * prog;
        const hy = e.y1 + dy * prog;
        const trav = len * prog;
        const trailLen = Math.min(80, trav);
        const seed = e.seed || 0;

        if (fade > 0.01) {
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          for (let k = 14; k >= 1; k--) {
            const f = k / 14;                       // 0 靠近方块 → 1 尾端
            const d = f * trailLen;
            const wob = (Math.sin(d * 0.30 + seed) * 1.6 +
                         Math.sin(d * 0.12 + seed * 2.3) * 1.0) * f;
            ctx.beginPath();
            ctx.arc(hx - ux * d - uy * wob, hy - uy * d + ux * wob,
                    2.9 * (1 - f) + 0.5, 0, Math.PI * 2);
            ctx.fillStyle = "hsla(" + hue + ",78%,62%," + (0.34 * (1 - f) * fade) + ")";
            ctx.fill();
          }
          ctx.restore();

          ctx.save();
          ctx.translate(hx, hy);
          ctx.rotate(Math.atan2(uy, ux));
          ctx.fillStyle = "hsla(" + hue + ",85%,84%," + (0.95 * fade) + ")";
          ctx.fillRect(-3.2, -2.0, 6.4, 4.0);
          ctx.fillStyle = "hsla(" + hue + ",35%,98%," + (0.95 * fade) + ")";
          ctx.fillRect(0.6, -1.0, 1.8, 2.0);       // 前端高光，指明朝向
          ctx.restore();
        }
      }

    } else if (e.type === "impact") {
      // 命中火花：一列敌人同时亮起来，表达"被打穿了"
      const p = 1 - t;                                // 0 → 1
      const r = 3 + 13 * p;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      // 十字
      ctx.strokeStyle = "hsla(" + hue + ",45%,95%," + (0.95 * t) + ")";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(e.x - r, e.y); ctx.lineTo(e.x + r, e.y);
      ctx.moveTo(e.x, e.y - r); ctx.lineTo(e.x, e.y + r);
      ctx.stroke();
      // 斜十字（更"炸"）
      ctx.strokeStyle = "hsla(" + hue + ",60%,88%," + (0.5 * t) + ")";
      ctx.lineWidth = 0.9;
      const q = r * 0.6;
      ctx.beginPath();
      ctx.moveTo(e.x - q, e.y - q); ctx.lineTo(e.x + q, e.y + q);
      ctx.moveTo(e.x - q, e.y + q); ctx.lineTo(e.x + q, e.y - q);
      ctx.stroke();
      // 内核
      ctx.beginPath();
      ctx.arc(e.x, e.y, 2.2 + 3.2 * t, 0, Math.PI * 2);
      ctx.fillStyle = "hsla(" + hue + ",40%,96%," + (0.8 * t) + ")";
      ctx.fill();
      // 外扩小环
      ctx.beginPath();
      ctx.arc(e.x, e.y, 4 + 10 * p, 0, Math.PI * 2);
      ctx.strokeStyle = "hsla(" + hue + ",80%,64%," + (0.45 * t) + ")";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();

    } else if (e.type === "shieldlink") {
      // 充能器 → 目标盾环 的一条青色弧线
      const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      // 起点在充能器边缘，终点落在盾环上（不是单位本体）
      const sx = e.x1 + ux * 5, sy = e.y1 + uy * 5;
      const ex = e.x2 - ux * (e.rEnd || 8.6), ey = e.y2 - uy * (e.rEnd || 8.6);
      // 控制点：中点沿"朝上"的法线偏移，形成弧线
      let nx2 = -uy, ny2 = ux;
      if (ny2 > 0) { nx2 = -nx2; ny2 = -ny2; }
      const bend = Math.min(36, len * 0.22);
      const cx2 = (sx + ex) / 2 + nx2 * bend;
      const cy2 = (sy + ey) / 2 + ny2 * bend;

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "butt";

      // 流动虚线：偏移随时间递减，虚线朝目标方向跑
      const el2 = e.max - e.life;
      ctx.setLineDash([6, 8]);
      ctx.lineDashOffset = -(el2 * 180);

      // 外发光（虚线）
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(cx2, cy2, ex, ey);
      ctx.strokeStyle = "hsla(200,95%,70%," + (0.18 * t) + ")";
      ctx.lineWidth = 3.6;
      ctx.stroke();

      // 芯（虚线，流动）
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(cx2, cy2, ex, ey);
      ctx.strokeStyle = "hsla(195,100%,84%," + (0.65 * t) + ")";
      ctx.lineWidth = 1.1;
      ctx.stroke();

      ctx.setLineDash([]);

      // 落在盾环上的亮点
      ctx.beginPath();
      ctx.arc(ex, ey, 2.0, 0, Math.PI * 2);
      ctx.fillStyle = "hsla(195,100%,90%," + (0.7 * t) + ")";
      ctx.fill();
      ctx.restore();

    } else if (e.type === "shieldup") {
      // 护盾成型：外环向内收拢，最后与护盾环重合（青色）
      const p = 1 - t;                                   // 0 → 1
      const r = e.r0 + (e.r1 - e.r0) * p;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";

      // 主环
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = "hsla(200,95%,74%," + (0.45 * t) + ")";
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.restore();

    } else if (e.type === "muzzle") {
      // 鱼雷发射闪光（刻意很小，避免齐射时糊成一片）
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.beginPath();
      ctx.arc(e.x, e.y, 1.6 + 2.4 * t, 0, Math.PI * 2);
      ctx.fillStyle = "hsla(" + hue + ",80%,64%," + (0.35 * t) + ")";
      ctx.fill();
      ctx.restore();

    } else if (e.type === "blast") {
      // 鱼雷爆炸：起爆闪光（短）+ 外扩冲击环（长）
      const k = 1 - t;                                // 0 → 1
      const r = e.r * (0.32 + 0.68 * k);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";

      // 冲击环
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = "hsla(" + hue + ",75%,58%," + (0.55 * t) + ")";
      ctx.lineWidth = 1.6;
      ctx.stroke();

      // 起爆闪光：只在生命周期前 40% 亮起
      const flash = Math.max(0, (t - 0.6) / 0.4);
      if (flash > 0) {
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = "hsla(" + hue + ",80%,58%," + (0.26 * flash) + ")";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r * 0.19, 0, Math.PI * 2);
        ctx.fillStyle = "hsla(" + hue + ",45%,92%," + (0.55 * flash) + ")";
        ctx.fill();
      }
      ctx.restore();
    }
  }
}
