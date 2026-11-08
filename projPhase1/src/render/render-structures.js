/**
 * 大型结构的绘制：空间站（基地）与防御塔
 * -----------------------------------------------------------------
 * 候选方案在 prototype/station-tower-sketches.html 里选出来的：
 *   空间站 = S7 棱堡环港（六边内核固定 + 外港环 / 悬臂 / 方形港缓慢旋转）
 *   防御塔 = T2 三叶哨戒（三片扇叶 + 三根固定的炮塔基座钢筋 + 中心三角旋转）
 *
 * 约定：调用方先把 ctx 平移到结构中心，这里按 (0,0) 画，半径 R 交给调用方定。
 * 只画，不读游戏状态 —— hue 与时间 t 都由调用方传入。
 */

const TAU = Math.PI * 2;

const hsl = (h, l, a = 1, s = 72) => `hsla(${h},${s}%,${l}%,${a})`;

/** 切角正多边形路径 */
function roundPoly(g, n, r, cut, rot = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rot + i * TAU / n;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const unit = (x, y) => { const d = Math.hypot(x, y) || 1; return [x / d, y / d]; };
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i + n - 1) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const v0 = unit(p0[0] - p1[0], p0[1] - p1[1]);
    const v2 = unit(p2[0] - p1[0], p2[1] - p1[1]);
    const ax = p1[0] + v0[0] * cut, ay = p1[1] + v0[1] * cut;
    const bx = p1[0] + v2[0] * cut, by = p1[1] + v2[1] * cut;
    if (i === 0) g.moveTo(ax, ay); else g.lineTo(ax, ay);
    g.quadraticCurveTo(p1[0], p1[1], bx, by);
  }
  g.closePath();
}

/** 从内到外发光的圆点 */
function glowDot(g, x, y, r, hue, a = 1) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, hsl(hue, 90, Math.min(1, .95 * a)));
  gr.addColorStop(.40, hsl(hue, 72, .30 * a));
  gr.addColorStop(1, hsl(hue, 60, 0));
  g.fillStyle = gr;
  g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
}

function arcStroke(g, r, a0, a1, w, color) {
  g.save();
  g.strokeStyle = color; g.lineWidth = w;
  g.beginPath(); g.arc(0, 0, r, a0, a1); g.stroke();
  g.restore();
}

/** 金属壳体：上亮下暗的线性渐变 */
function hullGrad(g, r, hue, lit = .35, dark = .12) {
  const gr = g.createLinearGradient(-r, -r, r * .8, r);
  gr.addColorStop(0, hsl(hue, lit * 100, .96, 40));
  gr.addColorStop(.55, hsl(hue, lit * 72, .97, 34));
  gr.addColorStop(1, hsl(hue, dark * 100, .98, 38));
  return gr;
}

// ---------------------------------------------------------------------
// 空间站 · S7 棱堡环港
// ---------------------------------------------------------------------

/** 六边内核：唯一不动的部分 */
function hexCore(g, hue, t, R) {
  const r = R * .62;
  roundPoly(g, 6, r, r * .20);
  g.fillStyle = hullGrad(g, r, hue); g.fill();
  g.strokeStyle = hsl(hue, 76, .88); g.lineWidth = R * .045; g.stroke();

  roundPoly(g, 6, r * .76, r * .18);
  g.strokeStyle = hsl(hue, 70, .28); g.lineWidth = R * .026; g.stroke();

  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + i * TAU / 3;
    g.strokeStyle = hsl(hue, 65, .20); g.lineWidth = R * .022;
    g.beginPath();
    g.moveTo(Math.cos(a) * r * .30, Math.sin(a) * r * .30);
    g.lineTo(Math.cos(a) * r * .74, Math.sin(a) * r * .74);
    g.stroke();
  }

  glowDot(g, 0, 0, R * .38, hue, .85 + .15 * Math.sin(t * 2.4));
  g.fillStyle = hsl(hue, 94, .34);
  g.beginPath(); g.arc(0, 0, R * .11, 0, TAU); g.fill();
}

/**
 * 空间站：外港环 + 三条悬臂 + 三个方形港整组慢速旋转，六边内核固定。
 * @param t 累计时间（秒）
 * @param R 半径
 */
export function drawStation(g, hue, t, R) {
  g.save();
  g.rotate(t * .10);

  const rr = R * .94, w = R * .17;
  arcStroke(g, rr, 0, TAU, w, hsl(hue, 22, .96, 42));
  arcStroke(g, rr, 0, TAU, w * .84, hsl(hue, 16, .99, 40));
  arcStroke(g, rr - w * .5, 0, TAU, w * .07, hsl(hue, 74, .62));
  arcStroke(g, rr + w * .5, 0, TAU, w * .07, hsl(hue, 74, .45));

  // 环上的分节刻线
  for (let i = 0; i < 30; i++) {
    const a = i * TAU / 30;
    g.strokeStyle = hsl(hue, 60, .16); g.lineWidth = R * .018;
    g.beginPath();
    g.moveTo(Math.cos(a) * (rr - w * .46), Math.sin(a) * (rr - w * .46));
    g.lineTo(Math.cos(a) * (rr + w * .46), Math.sin(a) * (rr + w * .46));
    g.stroke();
  }

  // 三条悬臂 + 方形港
  for (let i = 0; i < 3; i++) {
    g.save();
    g.rotate(-Math.PI / 2 + i * TAU / 3);

    g.fillStyle = hsl(hue, 20, .90, 38);
    g.beginPath(); g.rect(R * .50, -R * .095, R * .42, R * .19); g.fill();
    g.strokeStyle = hsl(hue, 68, .48); g.lineWidth = R * .022; g.stroke();

    g.fillStyle = hsl(hue, 26, .97);
    g.beginPath(); g.rect(R * .88, -R * .20, R * .17, R * .40); g.fill();
    g.strokeStyle = hsl(hue, 68, .55);
    g.beginPath(); g.rect(R * .88, -R * .20, R * .17, R * .40); g.stroke();

    g.fillStyle = hsl(hue, 92, .85 + .15 * Math.sin(t * 3 + i));
    g.beginPath(); g.arc(R * .965, 0, R * .032, 0, TAU); g.fill();
    g.restore();
  }
  g.restore();

  hexCore(g, hue, t, R);
}

// ---------------------------------------------------------------------
// 防御塔 · T3 蜂窝塔
// ---------------------------------------------------------------------

/**
 * 防御塔：六边壳体 + 六个顶点各一个发射器 + 内六边 + 中心竖井。
 * 整个塔不转、也没有炮塔，六个发射器的呼吸灯相位错开，看起来是「轮流充能」。
 */
export function drawTower(g, hue, t, R) {
  roundPoly(g, 6, R * 1.08, R * .16);
  g.fillStyle = hsl(hue, 20, .97, 38); g.fill();
  g.strokeStyle = hsl(hue, 68, .62); g.lineWidth = R * .06; g.stroke();

  // 六个发射器
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + i * TAU / 6;
    const x = Math.cos(a) * R * .92, y = Math.sin(a) * R * .92;
    g.save(); g.translate(x, y); g.rotate(a);
    g.fillStyle = hsl(hue, 34, .94, 50);
    g.beginPath(); g.rect(-R * .10, -R * .10, R * .22, R * .20); g.fill();
    g.strokeStyle = hsl(hue, 78, .70); g.lineWidth = R * .035; g.stroke();
    g.fillStyle = hsl(hue, 94, .55 + .25 * Math.sin(t * 3 + i * 1.1));
    g.beginPath(); g.arc(R * .13, 0, R * .05, 0, TAU); g.fill();
    g.restore();
  }

  // 内六边
  roundPoly(g, 6, R * .58, R * .10);
  g.fillStyle = hullGrad(g, R * .58, hue); g.fill();
  g.strokeStyle = hsl(hue, 82, .84); g.lineWidth = R * .05; g.stroke();

  // 中心竖井
  glowDot(g, 0, 0, R * .42, hue, .9 + .1 * Math.sin(t * 2.4));
  g.fillStyle = hsl(hue, 96, .44);
  g.beginPath(); g.arc(0, 0, R * .10, 0, TAU); g.fill();
}
