/**
 * 落球机（高尔顿板）
 * ---------------------------------------------------------------
 * 顶部发球器按随机间隔落球，球在钢柱间弹跳下落，
 * 落进底部某个槽就产出一个事件（对应一个模板）。
 *
 * 纯几何 + 简单物理，不依赖任何游戏状态。
 */

const BALL_R = 5;
// 钢柱半径要足够大：交错排列后相邻柱心的水平间距是 colGap/2，
// 必须满足 colGap/2 - 2*PEG_R < 球直径，球才不可能空过任何一行。
const PEG_R = 8;

/**
 * @param opts { x, y, w, h, binCount, dropMin, dropMax }
 *        x/y 是板子在画布上的左上角（世界坐标）
 */
export function createBoard(opts) {
  const { x, y, w, h, binCount } = opts;

  const top = y + 52;
  const bottom = y + h - 44;
  // 行列数按板子尺寸自适应，保证柱距满足"不可能空过"的条件
  const rows = Math.max(5, Math.round((bottom - top) / 34));
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

  return {
    x, y, w, h,
    top, bottom,
    pegs, bins, binW,
    balls: [],
    dropTimer: 3.5,
    dropMin: opts.dropMin || 6.0,
    dropMax: opts.dropMax || 11.0,
    gravity: opts.gravity || 260,
    restitution: 0.55,
    allowDrop: true,
    speedMul: 1,                 // 落球频率倍率（<1 = 更快），用于落后方的追赶
    // 发球器在顶部横向来回移动
    hopperPhase: Math.random() * Math.PI * 2,
    hopperSpeed: opts.hopperSpeed || 0.85,
    hopperX: x + w * 0.5
  };
}

/** 某个横坐标落在哪个槽 */
function binAt(b, bx) {
  for (const bin of b.bins) {
    if (bx >= bin.x0 && bx < bin.x1) return bin.index;
  }
  return bx < b.x ? 0 : b.bins.length - 1;
}

/**
 * 推进一帧。
 * @param out 落槽事件数组，会 push { bin: index }
 */
export function stepBoard(b, dt, out) {
  // ---------- 发球器横向往复 ----------
  b.hopperPhase += dt * b.hopperSpeed;
  const amp = Math.max(20, b.w * 0.5 - 46);
  b.hopperX = b.x + b.w * 0.5 + Math.sin(b.hopperPhase) * amp;

  // ---------- 发球 ----------
  b.dropTimer -= dt;
  if (b.dropTimer <= 0) {
    const base = b.dropMin + Math.random() * (b.dropMax - b.dropMin);
    b.dropTimer = base * (b.speedMul || 1);
    if (b.allowDrop) {
      b.balls.push({
        x: b.hopperX + (Math.random() - 0.5) * 6,
        y: b.y + 22,
        vx: (Math.random() - 0.5) * 26,
        vy: 0,
        life: 0
      });
    }
  }

  // ---------- 球的运动 ----------
  for (let i = b.balls.length - 1; i >= 0; i--) {
    const ball = b.balls[i];
    ball.vy += b.gravity * dt;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.life += dt;

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
      ball.vx += (Math.random() - 0.5) * 30;
      if (Math.abs(ball.vy) < 40) ball.vy += 30;   // 防止卡在柱子上
    }

    // 落槽
    if (ball.y > b.y + b.h - 30) {
      out.push({ bin: binAt(b, ball.x) });
      b.balls.splice(i, 1);
      continue;
    }

    // 兜底：超时消失
    if (ball.life > 14) b.balls.splice(i, 1);
  }
}

/** 绘制板子（钢柱、槽、球、发球器）
 *  highlight = 刚落球的槽（闪一下）；hover = 鼠标悬停的槽 */
export function drawBoard(ctx, b, binLabels, binColors, highlight, hover) {
  // 底板
  ctx.fillStyle = "rgba(10,15,22,.94)";
  ctx.strokeStyle = "rgba(80,120,160,.22)";
  ctx.lineWidth = 1;
  roundRect(ctx, b.x, b.y, b.w, b.h, 10);
  ctx.fill();
  ctx.stroke();

  // 发球器
  const hx = b.hopperX === undefined ? b.x + b.w * 0.5 : b.hopperX;
  // 导轨
  ctx.strokeStyle = "rgba(90,130,170,.20)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(b.x + 40, b.y + 14);
  ctx.lineTo(b.x + b.w - 40, b.y + 14);
  ctx.stroke();
  // 发球口
  ctx.beginPath();
  ctx.moveTo(hx - 7, b.y + 8);
  ctx.lineTo(hx + 7, b.y + 8);
  ctx.lineTo(hx + 4, b.y + 21);
  ctx.lineTo(hx - 4, b.y + 21);
  ctx.closePath();
  ctx.fillStyle = "rgba(150,200,255,.85)";
  ctx.fill();
  ctx.strokeStyle = "rgba(190,225,255,.8)";
  ctx.lineWidth = 1;
  ctx.stroke();

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
    const hv = hover === i;

    ctx.fillStyle = on ? "rgba(255,255,255,.16)"
                  : hv ? "rgba(255,255,255,.10)"
                       : "rgba(255,255,255,.05)";
    roundRect(ctx, bx, by, bw, bh2, 4);
    ctx.fill();

    // 悬停时加一层外发光，让人知道这是能点的
    if (hv) {
      ctx.save();
      ctx.shadowColor = binColors[i] || "rgba(255,255,255,.6)";
      ctx.shadowBlur = 10;
      ctx.strokeStyle = binColors[i] || "rgba(255,255,255,.7)";
      ctx.lineWidth = 2;
      roundRect(ctx, bx, by, bw, bh2, 4);
      ctx.stroke();
      ctx.restore();
    }

    ctx.strokeStyle = binColors[i] || "rgba(255,255,255,.2)";
    ctx.lineWidth = (on || hv) ? 1.6 : 1;
    roundRect(ctx, bx, by, bw, bh2, 4);
    ctx.stroke();

    // 模板名：字号随槽宽自适应，放不下就逐级缩小
    ctx.save();
    const label = binLabels[i] || "";
    let fs = 17;
    ctx.font = "600 " + fs + "px 'Microsoft YaHei', system-ui, sans-serif";
    while (fs > 9 && ctx.measureText(label).width > bw - 12) {
      fs -= 1;
      ctx.font = "600 " + fs + "px 'Microsoft YaHei', system-ui, sans-serif";
    }
    ctx.fillStyle = binColors[i] || "#8ba4bb";
    if (hv) { ctx.shadowColor = binColors[i] || "#fff"; ctx.shadowBlur = 8; }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, (bin.x0 + bin.x1) / 2, by + bh2 / 2);
    ctx.restore();
  }

  // 球
  for (const ball of b.balls) {
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,230,160,.95)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R + 3, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,200,90,.20)";
    ctx.fill();
  }
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
