/**
 * 落球机（高尔顿板）
 * ---------------------------------------------------------------
 * 双方**共用同一套钢柱与落球区**：顶部有两个发球口，一个投蓝球一个投红球，
 * 球在钢柱间弹跳下落，落进底部某个槽就产出一个事件（哪个槽 + 哪个阵营）。
 *
 * 纯几何 + 简单物理，不依赖任何游戏状态。
 */

const BALL_R = 5;
// 钢柱半径要足够大：交错排列后相邻柱心的水平间距是 colGap/2，
// 必须满足 colGap/2 - 2*PEG_R < 球直径，球才不可能空过任何一行。
const PEG_R = 8;

/** 两个阵营的球色（发球口、球体、外发光都用它） */
export const FACTION_BALL = [
  { core: "rgba(150,215,255,.98)", halo: "rgba(90,170,255,.22)", fps: "rgba(150,215,255,.9)" },
  { core: "rgba(255,160,140,.98)", halo: "rgba(255,110,80,.22)", fps: "rgba(255,160,140,.9)" },
];

/**
 * @param opts { x, y, w, h, binCount, factions, dropMin, dropMax }
 *        x/y 是板子在画布上的左上角（画布坐标）
 */
export function createBoard(opts) {
  const { x, y, w, h, binCount } = opts;
  const factions = opts.factions || 1;
  const ss = opts.speedScale === undefined ? 1 : opts.speedScale;

  const top = y + 44;
  const bottom = y + h - 42;
  // 行列数按板子尺寸自适应，保证柱距满足"不可能空过"的条件
  const rows = Math.max(4, Math.round((bottom - top) / 26));
  const cols = Math.max(9, Math.round(w / 42));

  // ---------- 钢柱 ----------
  const pegs = [];
  const rowGap = rows > 1 ? (bottom - top) / (rows - 1) : 0;
  const colGap = w / (cols + 1);
  for (let r = 0; r < rows; r++) {
    const odd = r % 2 === 1;
    const n = odd ? cols - 1 : cols;
    for (let c = 0; c < n; c++) {
      // 不加横向抖动：一抖就可能把间隙抖到能过球
      pegs.push({
        x: x + colGap * (c + 1) + (odd ? colGap * 0.5 : 0),
        y: top + r * rowGap,
        r: PEG_R
      });
    }
  }

  // ---------- 底部槽 ----------
  const bins = [];
  const binW = w / binCount;
  for (let i = 0; i < binCount; i++) {
    bins.push({ x0: x + i * binW, x1: x + (i + 1) * binW, index: i });
  }

  // ---------- 发球口：每个阵营一个，横向满场往复，相位相反 ----------
  const hoppers = [];
  for (let i = 0; i < factions; i++) {
    hoppers.push({
      faction: i,
      phase: i * Math.PI + Math.random() * 0.6,   // 彼此错开半个周期
      x: x + w * 0.5,
      timer: 3.5 + i * 1.4,
      allow: true,
      speedMul: 1,
    });
  }

  return {
    x, y, w, h,
    top, bottom,
    pegs, bins, binW,
    balls: [],
    hoppers,
    dropMin: opts.dropMin || 6.0,
    dropMax: opts.dropMax || 11.0,
    gravity: opts.gravity || 260,
    restitution: 0.55,
    // timeScale < 1 时球的运动整体变慢（重力、位移、反弹一起按比例缩时间，
    // 但发球间隔不受影响 —— 出兵节奏保持原样）
    timeScale: ss,
    dropVx: 26,               // 出球口的初始横速
    jitterVx: 30,             // 钢柱碰撞的随机横摆
    minVyKick: 30,            // 防止卡在柱子上的最小下落速度
    hopperSpeed: opts.hopperSpeed || 0.85,
  };
}

/** 某个横坐标落在哪个槽 */
function binAt(b, bx) {
  for (const bin of b.bins) {
    if (bx >= bin.x0 && bx < bin.x1) return bin.index;
  }
  return bx < b.x ? 0 : b.bins.length - 1;
}

/** 发球口的横向位置 */
function hopperX(b, hp) {
  const amp = Math.max(20, b.w * 0.5 - 46);
  return b.x + b.w * 0.5 + Math.sin(hp.phase) * amp;
}

/**
 * 推进一帧。
 * @param out 落槽事件数组，会 push { bin, faction }
 */
export function stepBoard(b, dt, out) {
  b.anim = (b.anim || 0) + dt;          // 供火焰等特效做闪动

  // ---------- 发球口：各自往复 + 各自计时 ----------
  for (const hp of b.hoppers) {
    hp.phase += dt * b.hopperSpeed;
    hp.x = hopperX(b, hp);

    hp.timer -= dt;
    if (hp.timer <= 0) {
      const base = b.dropMin + Math.random() * (b.dropMax - b.dropMin);
      hp.timer = base * (hp.speedMul || 1);
      if (hp.allow) {
        b.balls.push({
          x: hp.x + (Math.random() - 0.5) * 6,
          y: b.y + 22,
          vx: (Math.random() - 0.5) * b.dropVx,
          vy: 0,
          life: 0,
          faction: hp.faction,
        });
      }
    }
  }

  // ---------- 球的运动 ----------
  // 球的物理用自己的时间步：timeScale < 1 时整体变慢，但发球节奏不受影响
  const sdt = dt * (b.timeScale === undefined ? 1 : b.timeScale);

  for (let i = b.balls.length - 1; i >= 0; i--) {
    const ball = b.balls[i];
    ball.vy += b.gravity * sdt;
    ball.x += ball.vx * sdt;
    ball.y += ball.vy * sdt;
    ball.life += sdt;

    // 左右墙
    if (ball.x < b.x + BALL_R) {
      ball.x = b.x + BALL_R;
      ball.vx = Math.abs(ball.vx) * 0.6;
    } else if (ball.x > b.x + b.w - BALL_R) {
      ball.x = b.x + b.w - BALL_R;
      ball.vx = -Math.abs(ball.vx) * 0.6;
    }

    // 钢柱碰撞
    for (const p of b.pegs) {
      const dx = ball.x - p.x, dy = ball.y - p.y;
      const rr = BALL_R + p.r;
      const d2 = dx * dx + dy * dy;
      if (d2 > rr * rr || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, ny = dy / d;

      // 推出去
      ball.x = p.x + nx * rr;
      ball.y = p.y + ny * rr;

      // 沿法线反射
      const vn = ball.vx * nx + ball.vy * ny;
      ball.vx -= (1 + b.restitution) * vn * nx;
      ball.vy -= (1 + b.restitution) * vn * ny;

      // 一点点随机，避免完美对称导致球永远走中间
      ball.vx += (Math.random() - 0.5) * b.jitterVx;
      if (Math.abs(ball.vy) < 40) ball.vy += b.minVyKick;   // 防止卡在柱子上
    }

    // 落槽
    if (ball.y > b.y + b.h - 30) {
      out.push({ bin: binAt(b, ball.x), faction: ball.faction });
      b.balls.splice(i, 1);
      continue;
    }

    // 兜底：超时消失
    if (ball.life > 14) b.balls.splice(i, 1);
  }
}

/** 绘制板子（钢柱、槽、球、两个发球口）
 *  highlight = 刚落球的槽（闪一下） */
export function drawBoard(ctx, b, binLabels, binColors, highlight) {
  // 底板
  ctx.fillStyle = "rgba(10,15,22,.94)";
  ctx.strokeStyle = "rgba(80,120,160,.22)";
  ctx.lineWidth = 1;
  roundRect(ctx, b.x, b.y, b.w, b.h, 10);
  ctx.fill();
  ctx.stroke();

  // ---------- 发球口 ----------
  const hx0 = b.hoppers[0] ? b.hoppers[0].x : b.x + b.w * 0.5;
  const hx1 = b.hoppers[1] ? b.hoppers[1].x : null;

  // 导轨
  ctx.strokeStyle = "rgba(90,130,170,.18)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(b.x + 30, b.y + 14);
  ctx.lineTo(b.x + b.w - 30, b.y + 14);
  ctx.stroke();

  for (let i = 0; i < b.hoppers.length; i++) {
    const hp = b.hoppers[i];
    const col = FACTION_BALL[hp.faction] || FACTION_BALL[0];
    const hx = hp.x;

    // 追赶中：发球口冒火
    if (hp.catchup) drawFlame(ctx, hx, b.y + 6, b.anim || 0);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(hx - 7, b.y + 8);
    ctx.lineTo(hx + 7, b.y + 8);
    ctx.lineTo(hx + 4, b.y + 21);
    ctx.lineTo(hx - 4, b.y + 21);
    ctx.closePath();
    ctx.fillStyle = col.fps;
    if (!hp.allow) ctx.globalAlpha = 0.3;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.55)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // 阵营小标：左上蓝 / 右上红
  if (b.hoppers.length > 1) {
    ctx.save();
    ctx.font = "600 10px 'Microsoft YaHei', system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(150,215,255,.55)";
    ctx.fillText("蓝", b.x + 10, b.y + 16);
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255,160,140,.55)";
    ctx.fillText("红", b.x + b.w - 10, b.y + 16);
    ctx.restore();
  }

  // 钢柱
  ctx.fillStyle = "rgba(120,150,180,.45)";
  for (const p of b.pegs) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 槽
  const bh2 = 32;
  for (let i = 0; i < b.bins.length; i++) {
    const bin = b.bins[i];
    const bw = bin.x1 - bin.x0 - 3;
    const bx = bin.x0 + 1.5;
    const by = b.y + b.h - bh2;

    const on = highlight === i;
    ctx.fillStyle = on ? "rgba(255,255,255,.16)" : "rgba(255,255,255,.05)";
    roundRect(ctx, bx, by, bw, bh2, 4);
    ctx.fill();

    ctx.strokeStyle = binColors[i] || "rgba(255,255,255,.2)";
    ctx.lineWidth = on ? 1.6 : 1;
    roundRect(ctx, bx, by, bw, bh2, 4);
    ctx.stroke();

    // 模板名：字号随槽宽自适应，放不下就逐级缩小
    ctx.save();
    const label = binLabels[i] || "";
    let fs = 13;
    ctx.font = "600 " + fs + "px 'Microsoft YaHei', system-ui, sans-serif";
    while (fs > 8 && ctx.measureText(label).width > bw - 10) {
      fs -= 1;
      ctx.font = "600 " + fs + "px 'Microsoft YaHei', system-ui, sans-serif";
    }
    ctx.fillStyle = binColors[i] || "#8ba4bb";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, (bin.x0 + bin.x1) / 2, by + bh2 / 2);
    ctx.restore();
  }

  // 球：按阵营上色
  for (const ball of b.balls) {
    const col = FACTION_BALL[ball.faction] || FACTION_BALL[0];
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = col.core;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R + 3, 0, Math.PI * 2);
    ctx.fillStyle = col.halo;
    ctx.fill();
  }
}

/** 发球口的追赶火焰：三团向上飘的加色光斑 */
function drawFlame(ctx, x, y, t) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let k = 0; k < 3; k++) {
    const ph = t * 16 + k * 2.1;
    const fy = y - k * 4.2 - Math.sin(ph) * 1.8;
    const px = x + Math.sin(ph * 0.7) * 2.2;
    const r = 5.4 - k * 1.4;
    ctx.beginPath();
    ctx.arc(px, fy, r, 0, Math.PI * 2);
    ctx.fillStyle = "hsla(" + (36 - k * 11) + ",100%," + (64 + k * 10) + "%," +
                    (0.55 - k * 0.14) + ")";
    ctx.fill();
  }
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
