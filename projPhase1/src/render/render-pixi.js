/**
 * 渲染层接口 · PixiJS 实现
 * -----------------------------------------------------------------
 * 战场现在全部走 Pixi（WebGL）：
 *   · 单位是**像素船图**（public/imgs/frigate.png 的 64 张 32×32 切片）
 *   · 所有单位只按**阵营**着色，小队不再有自己的颜色
 *   · 弹丸、光束、爆炸、支援连线都画在一张 additive 的 Graphics 上
 *
 * 依然守着渲染层的三条规矩：
 *   1. 只读 view，不回写任何游戏状态
 *   2. 不碰 ctx（Pixi 自己管 GL 上下文）
 *   3. 不读游戏参数表 —— 颜色/尺寸都由这里的常量与数据决定
 */

import { Application, Container, Graphics, Sprite } from "pixi.js";
import { WorldRenderer } from "./renderer.js";
import { FACTION_TINT, NEUTRAL_HUE, hpColor, hslHex } from "./palette.js";
import { loadShipAtlas, variantOf, sizeOf } from "./ship-sprites.js";
import { getChamferedCellPolygon } from "../core/sim/wall-geometry.js";

const BG = 0x07090d;
const WALL_FILL = 0x1b2733;

// 血条（画法参数，不是游戏数值）
const BAR_W = 14;
const BAR_H = 2.2;
const BAR_DY = -5;          // 血条贴在贴图上沿外侧

export async function createPixiRenderer(canvas) {
  const r = new PixiRenderer();
  await r.init(canvas);
  return r;
}

class PixiRenderer extends WorldRenderer {
  constructor() {
    super();
    this.app = null;
    this.sprites = [];
    this.atlas = null;
    this.w = 1;
    this.h = 1;
  }

  async init(canvas) {
    const app = new Application();
    await app.init({
      canvas,
      width: 1,                            // 真正的尺寸由 layout 量出战场那一格再设
      height: 1,
      background: BG,
      antialias: false,                    // 像素风：不要抗锯齿
      resolution: Math.max(1, window.devicePixelRatio || 1),
      autoDensity: true,
      autoStart: false,                    // 主循环只有一个，由 main.js 调 draw()
      preference: "webgl"
    });
    this.app = app;

    this.world = new Container();
    this.border = new Graphics();
    this.walls = new Graphics();
    this.unitsLayer = new Container();
    this.bars = new Graphics();
    this.glow = new Graphics();
    this.glow.blendMode = "add";           // 特效和光束统一用叠加

    this.world.addChild(this.border, this.walls, this.unitsLayer, this.bars, this.glow);
    app.stage.addChild(this.world);

    this.atlas = await loadShipAtlas();
    this.w = 1;
    this.h = 1;
  }

  resize(width, height) {
    if (!this.app) return;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.app.renderer.resize(w, h);
  }

  draw(view) {
    const cam = view.camera || { ox: 0, oy: 0, zoom: 1 };

    this.world.position.set(cam.ox, cam.oy);
    this.world.scale.set(cam.zoom);

    this.drawBorder(view.world);
    this.drawWalls(view);
    this.drawUnits(view);
    this.drawBars(view);
    this.drawFx(view);
    this.drawProjectiles(view.projectiles);

    this.app.render();
  }

  // ---------------- 墙体 ----------------
  //
  // 画的是**倒角多边形**，和碰撞用的是同一份几何（core/sim/wall-geometry.js）。
  // 不能一边按方格画、一边按倒角算：玩家会看到"船离墙角还有半个格就被弹开"。
  // 按 map.rev 缓存，换图才重画。

  drawWalls(view) {
    const map = view.map;
    if (!map || !this.walls) return;
    if (this._wallRev === map.rev) return;
    this._wallRev = map.rev;

    const g = this.walls;
    g.clear();

    for (let cy = 0; cy < map.rows; cy++) {
      for (let cx = 0; cx < map.cols; cx++) {
        if (!map.isWall(cx, cy)) continue;
        const pts = getChamferedCellPolygon(map, cx, cy);
        if (!pts) continue;
        // 只填充不描边：相邻墙格共边，描边会画出一堆格子缝
        g.poly(pts.flat()).fill({ color: WALL_FILL, alpha: 1 });
      }
    }
  }

  // ---------------- 战场底纹 ----------------

  drawBorder(world) {
    const g = this.border;
    const key = `${world.w}x${world.h}`;
    if (this._bgKey === key) return;
    this._bgKey = key;

    g.clear();
    const W = world.w, H = world.h;

    // 地图本体：比画布外圈稍亮一点，缩到全图时能一眼看出战场边界
    g.rect(0, 0, W, H).fill({ color: 0x0a1018, alpha: 1 });

    // 细网格：给空战场一点纵深（很淡，不抢单位）
    const STEP = 48;
    for (let x = 0; x <= W; x += STEP) {
      g.moveTo(x, 0).lineTo(x, H).stroke({ color: 0x5a82aa, alpha: 0.045, width: 1 });
    }
    for (let y = 0; y <= H; y += STEP) {
      g.moveTo(0, y).lineTo(W, y).stroke({ color: 0x5a82aa, alpha: 0.045, width: 1 });
    }

    // 世界边框：地图是有边的，不是无限平面
    g.rect(0, 0, W, H).stroke({ color: 0x3a5875, alpha: 0.75, width: 2 });

    // 四个角：比整圈虚线更干净
    const L = 26;
    const style = { color: 0x3a5875, alpha: 0.55, width: 1 };
    for (const [x, y, sx, sy] of [
      [0, 0, 1, 1], [W, 0, -1, 1], [0, H, 1, -1], [W, H, -1, -1]
    ]) {
      g.moveTo(x, y).lineTo(x + L * sx, y).stroke(style);
      g.moveTo(x, y).lineTo(x, y + L * sy).stroke(style);
    }
  }

  // ---------------- 单位 ----------------

  drawUnits(view) {
    const squads = view.squads || [];
    const units = view.units;
    const frames = this.atlas.frames;
    const count = this.atlas.count;

    // 补齐精灵池
    while (this.sprites.length < units.length) {
      const s = new Sprite(frames[0]);
      s.anchor.set(0.5);
      s._v = -1;
      s._ang = 0;
      this.unitsLayer.addChild(s);
      this.sprites.push(s);
    }

    let n = 0;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.base || u.tower || u.hp <= 0) continue;

      const sq = squads[u.squad];
      const faction = sq ? sq.faction : -1;

      const s = this.sprites[n++];
      s.visible = true;

      // 同型号恒定用同一张图：只有属性变了才换 texture
      const v = variantOf(u, count);
      if (s._v !== v) { s.texture = frames[v]; s._v = v; }

      const size = sizeOf(u);                // 世界像素：受击半径越大，船越大
      s.scale.set(size / 32);

      // 航向：静止时保持上一帧朝向，避免抖
      const sp = Math.hypot(u.vx, u.vy);
      if (sp > 4) s._ang = Math.atan2(u.vy, u.vx);
      s.rotation = s._ang + Math.PI / 2;     // 素材船头朝上

      s.x = u.x;
      s.y = u.y;
      s.tint = FACTION_TINT[faction] ?? 0x9fb3c6;
      s.alpha = 1;
    }

    for (let i = n; i < this.sprites.length; i++) this.sprites[i].visible = false;
  }

  // ---------------- 血条 / 护盾 ----------------

  drawBars(view) {
    const g = this.bars;
    g.clear();

    for (const u of view.units) {
      if (u.base || u.tower || u.hp <= 0) continue;

      // 护盾：一圈淡蓝
      if (u.shield > 0) {
        const r = sizeOf(u) * 0.5 + 3;
        g.circle(u.x, u.y, r).stroke({ color: 0x78d2ff, alpha: 0.55, width: 1.1 });
      }

      if (!(u.hp < u.maxHp)) continue;

      const size = sizeOf(u);
      const bw = Math.max(BAR_W, size * 0.72);
      const bx = u.x - bw / 2;
      const by = u.y - size * 0.5 + BAR_DY;      const f = Math.max(0, Math.min(1, u.hp / u.maxHp));

      g.rect(bx - 0.5, by - 0.5, bw + 1, BAR_H + 1).fill({ color: 0x060a10, alpha: 0.72 });
      g.rect(bx, by, bw * f, BAR_H).fill({ color: hpColor(u.hp, u.maxHp), alpha: 1 });
    }
  }

  // ---------------- 特效 ----------------

  drawFx(view) {
    const g = this.glow;
    g.clear();

    const now = view.time || 0;
    for (const e of view.fx || []) {
      if (e.delay > 0) continue;
      const t = Math.max(0, e.life / e.max);      // 1 → 0
      const hue = e.hue === undefined ? NEUTRAL_HUE : e.hue;

      switch (e.type) {
        case "beam": beam(g, e, t, hue); break;
        case "rayshot": rayshot(g, e, t, hue); break;
        case "spark": spark(g, e, t, hue); break;
        case "impact": impact(g, e, t, hue); break;
        case "supportlink": supportLink(g, e, t, now); break;
        case "muzzle": muzzle(g, e, t, hue); break;
        case "blast": blast(g, e, t, hue); break;
        default: break;
      }
    }
  }

  // ---------------- 弹丸 ----------------

  drawProjectiles(projectiles) {
    const g = this.glow;

    for (const p of projectiles) {
      const sp = Math.hypot(p.vx, p.vy) || 1;
      const ux = p.vx / sp, uy = p.vy / sp;
      const hue = p.hue === undefined ? NEUTRAL_HUE : p.hue;

      if (p.style === "streak") {
        streak(g, p, ux, uy, hue);
        continue;
      }

      if (p.style === "line") lineTrail(g, p, hue);
      else smokeTrail(g, p, ux, uy, hue);

      head(g, p, ux, uy, hue, Math.max(0.8, Math.min(1.6, (p.contactR || 4) / 4)));
    }
  }
}

// ==================================================================
// 绘制小工具
// ==================================================================

/** 以 (cx,cy) 为中心、朝向 (ux,uy) 的矩形，返回 4 个顶点 */
function rectPts(cx, cy, ux, uy, len, wid) {
  const px = -uy, py = ux;
  const hx = ux * len * 0.5, hy = uy * len * 0.5;
  const wx = px * wid * 0.5, wy = py * wid * 0.5;
  return [cx - hx - wx, cy - hy - wy, cx + hx - wx, cy + hy - wy,
          cx + hx + wx, cy + hy + wy, cx - hx + wx, cy - hy + wy];
}

function dot(g, x, y, r, color, alpha) {
  g.circle(x, y, r).fill({ color, alpha });
}

// ---------------- 各种特效 ----------------

function beam(g, e, t, hue) {
  const ws = e.w || 1;
  g.moveTo(e.x1, e.y1).lineTo(e.x2, e.y2)
    .stroke({ color: hslHex(hue, 72, 56), alpha: 0.26 * t, width: 2.4 * ws });
  g.moveTo(e.x1, e.y1).lineTo(e.x2, e.y2)
    .stroke({ color: hslHex(hue, 82, 80), alpha: 0.72 * t, width: 0.9 * ws });

  dot(g, e.x1, e.y1, (1.1 + 1.8 * t) * ws, hslHex(hue, 82, 70), 0.55 * t);
  dot(g, e.x2, e.y2, (1.6 + 2.4 * t) * ws, hslHex(hue, 55, 90), 0.80 * t);
  g.circle(e.x2, e.y2, (3.4 + 3.6 * t) * ws)
    .stroke({ color: hslHex(hue, 78, 64), alpha: 0.36 * t, width: 0.9 });
}

function rayshot(g, e, t, hue) {
  const el = e.max - e.life;
  const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const prog = el <= e.aim ? 0 : Math.min(1, (el - e.aim) / e.fly);
  const lineT = el <= e.aim ? 1
    : Math.max(0.12, 1 - ((el - e.aim) / Math.max(0.001, e.max - e.aim)) * 1.15);

  g.moveTo(e.x1, e.y1).lineTo(e.x2, e.y2)
    .stroke({ color: hslHex(hue, 70, 55), alpha: 0.15 * lineT, width: 1.8 });
  g.moveTo(e.x1, e.y1).lineTo(e.x2, e.y2)
    .stroke({ color: hslHex(hue, 75, 80), alpha: 0.26 * lineT, width: 0.8 });

  if (prog <= 0) return;

  const fade = prog <= 0.8 ? 1 : Math.max(0, 1 - (prog - 0.8) / 0.2);
  if (fade <= 0.01) return;

  const hx = e.x1 + dx * prog;
  const hy = e.y1 + dy * prog;
  const trailLen = Math.min(80, len * prog);
  const seed = e.seed || 0;

  for (let k = 8; k >= 1; k--) {
    const f = k / 8;
    const d = f * trailLen;
    const wob = (Math.sin(d * 0.30 + seed) * 1.6 + Math.sin(d * 0.12 + seed * 2.3) * 1.0) * f;
    dot(g, hx - ux * d - uy * wob, hy - uy * d + ux * wob,
      2.9 * (1 - f) + 0.5, hslHex(hue, 78, 62), 0.34 * (1 - f) * fade);
  }

  g.poly(rectPts(hx, hy, ux, uy, 6.4, 4.0)).fill({ color: hslHex(hue, 85, 84), alpha: 0.95 * fade });
  g.poly(rectPts(hx + ux * 1.5, hy + uy * 1.5, ux, uy, 1.8, 2.0))
    .fill({ color: hslHex(hue, 35, 98), alpha: 0.95 * fade });
}

function spark(g, e, t, hue) {
  const p = 1 - t, s = e.s || 1;
  g.circle(e.x, e.y, (2.4 + 6.5 * p) * s)
    .stroke({ color: hslHex(hue, 82, 74), alpha: 0.30 * t, width: 1 });
  dot(g, e.x, e.y, (1.5 + 1.7 * t) * s, hslHex(hue, 42, 97), 0.58 * t);
  dot(g, e.x, e.y, (0.9 + 0.8 * t) * s, 0xffffff, 0.40 * t);
}

function impact(g, e, t, hue) {
  const p = 1 - t, r = 3 + 13 * p;
  g.moveTo(e.x - r, e.y).lineTo(e.x + r, e.y)
    .stroke({ color: hslHex(hue, 45, 95), alpha: 0.95 * t, width: 1.4 });
  g.moveTo(e.x, e.y - r).lineTo(e.x, e.y + r)
    .stroke({ color: hslHex(hue, 45, 95), alpha: 0.95 * t, width: 1.4 });

  const q = r * 0.6;
  g.moveTo(e.x - q, e.y - q).lineTo(e.x + q, e.y + q)
    .stroke({ color: hslHex(hue, 60, 88), alpha: 0.5 * t, width: 0.9 });
  g.moveTo(e.x - q, e.y + q).lineTo(e.x + q, e.y - q)
    .stroke({ color: hslHex(hue, 60, 88), alpha: 0.5 * t, width: 0.9 });

  dot(g, e.x, e.y, 2.2 + 3.2 * t, hslHex(hue, 40, 96), 0.8 * t);
  g.circle(e.x, e.y, 4 + 10 * p)
    .stroke({ color: hslHex(hue, 80, 64), alpha: 0.45 * t, width: 1.2 });
}

function supportLink(g, e, t, now) {
  const hue = e.hue ?? 195;
  const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const sx = e.x1 + ux * 5, sy = e.y1 + uy * 5;
  const ex = e.x2 - ux * (e.rEnd || 8.6), ey = e.y2 - uy * (e.rEnd || 8.6);

  let nx = -uy, ny = ux;
  if (ny > 0) { nx = -nx; ny = -ny; }
  const bend = Math.min(36, len * 0.22);
  const cx = (sx + ex) / 2 + nx * bend;
  const cy = (sy + ey) / 2 + ny * bend;

  // 流动虚线：沿二次贝塞尔采样，按相位跳过一些段
  const SEG = 14;
  const phase = ((now * 180) % 14) / 14;
  const pt = (u) => {
    const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;
    return [a * sx + b * cx + c * ex, a * sy + b * cy + c * ey];
  };
  for (let i = 0; i < SEG; i++) {
    const u0 = (i + phase) / SEG;
    if (u0 >= 1) continue;
    const u1 = Math.min(1, u0 + 0.5 / SEG);
    const [ax, ay] = pt(u0), [bx, by] = pt(u1);
    g.moveTo(ax, ay).lineTo(bx, by)
      .stroke({ color: hslHex(hue, 95, 70), alpha: 0.35 * t, width: 2.2 });
    g.moveTo(ax, ay).lineTo(bx, by)
      .stroke({ color: hslHex(hue, 100, 88), alpha: 0.75 * t, width: 0.9 });
  }

  dot(g, ex, ey, 2.0, hslHex(hue, 100, 90), 0.7 * t);
}

function muzzle(g, e, t, hue) {
  dot(g, e.x, e.y, 1.6 + 2.4 * t, hslHex(hue, 80, 64), 0.35 * t);
}

function blast(g, e, t, hue) {
  const k = 1 - t;
  g.circle(e.x, e.y, e.r * (0.32 + 0.68 * k))
    .stroke({ color: hslHex(hue, 75, 58), alpha: 0.55 * t, width: 1.6 });

  const flash = Math.max(0, (t - 0.6) / 0.4);
  if (flash > 0) {
    dot(g, e.x, e.y, e.r * 0.42, hslHex(hue, 80, 58), 0.26 * flash);
    dot(g, e.x, e.y, e.r * 0.19, hslHex(hue, 45, 92), 0.55 * flash);
  }
}

// ---------------- 弹丸 ----------------

function streak(g, p, ux, uy, hue) {
  const LEN = 13;
  const tx = p.x - ux * LEN, ty = p.y - uy * LEN;
  g.moveTo(tx, ty).lineTo(p.x, p.y)
    .stroke({ color: hslHex(hue, 88, 62), alpha: 0.18, width: 2.6 });
  g.moveTo(tx, ty).lineTo(p.x, p.y)
    .stroke({ color: hslHex(hue, 85, 76), alpha: 0.5, width: 1.3 });
  g.moveTo(p.x - ux * LEN * 0.55, p.y - uy * LEN * 0.55).lineTo(p.x, p.y)
    .stroke({ color: hslHex(hue, 35, 97), alpha: 0.58, width: 0.7 });
  dot(g, p.x, p.y, 1.0, hslHex(hue, 25, 99), 0.56);
}

function smokeTrail(g, p, ux, uy, hue) {
  const px = -uy, py = ux;
  const seed = p.seed || 0;
  const TRAIL = 26;
  for (let k = 6; k >= 1; k--) {
    const f = k / 6;
    const d = f * TRAIL;
    const wob = (Math.sin(d * 0.34 + seed) * 1.6 + Math.sin(d * 0.13 + seed * 2.7) * 1.1) * f;
    dot(g, p.x - ux * d + px * wob, p.y - uy * d + py * wob,
      2.8 * (1 - f) + 0.5, hslHex(hue, 72, 65), 0.34 * (1 - f));
  }
}

function lineTrail(g, p, hue) {
  const path = p.path;
  const n = path ? (path.length / 2) | 0 : 0;
  if (n < 2) return;

  for (let k = 0; k + 3 < path.length; k += 4) {
    const f = (k / 2) / (n - 1);
    g.moveTo(path[k], path[k + 1]).lineTo(path[k + 2], path[k + 3])
      .stroke({
        color: hslHex(hue, 88, 56 + f * 18),
        alpha: 0.03 + f * 0.26,
        width: 0.5 + f * 1.4
      });
  }
  dot(g, p.x, p.y, 4.5, hslHex(hue, 90, 72), 0.18);
}

function head(g, p, ux, uy, hue, s) {
  const L = 3.8 * s, W = 2.3 * s;
  g.poly(rectPts(p.x, p.y, ux, uy, L, W))
    .fill({ color: hslHex(hue, 84, 80), alpha: 1 });
  g.poly(rectPts(p.x + ux * 1.1 * s, p.y + uy * 1.1 * s, ux, uy, 1.3 * s, 1.4 * s))
    .fill({ color: hslHex(hue, 40, 96), alpha: 0.92 });
}
