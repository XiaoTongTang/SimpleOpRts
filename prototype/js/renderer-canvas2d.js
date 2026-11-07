/**
 * 渲染层接口 · Canvas2D 实现
 * -----------------------------------------------------------------
 * 现在唯一在用的实现。所有矢量绘制都留在这一层，将来换 Pixi 时
 * 这个文件可以被整体替换（或者并存，加一个 debug 开关对照）。
 *
 * 具体的图形代码复用 js/structures.js（空间站 / 防御塔）、
 * js/render-units.js（单位 / 弹丸）、js/render-fx.js（特效）。
 */

import { WorldRenderer } from "./renderer.js";
import { drawUnits, drawProjectiles } from "./render-units.js";
import { drawFx } from "./render-fx.js";
import { drawStation, drawTower as drawTowerArt } from "./structures.js";

const BG = "#07090d";

// 血条尺寸：这是「画法」，不是游戏参数，所以留在渲染层
const BASE_BAR = { w: 84, h: 5 };
const TOWER_BAR = { w: 40, h: 3.5 };

class Canvas2DRenderer extends WorldRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.width = 0;      // 逻辑尺寸（CSS px）
    this.height = 0;
    this.dpr = 1;
  }

  /**
   * 后备缓冲按设备像素分配，绘制坐标仍是 CSS px。
   * 之前按 CSS px 分配 → 浏览器把位图拉伸到设备分辨率，整屏是糊的。
   */
  resize(width, height) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.width = width;
    this.height = height;
    this.dpr = dpr;

    const c = this.canvas;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    c.style.width = width + "px";
    c.style.height = height + "px";
  }

  draw(view) {
    const ctx = this.ctx;
    const cam = view.camera;

    // 每帧重设基准变换：画布尺寸变化会重置 transform
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.save();
    ctx.translate(cam.ox, cam.oy);
    ctx.scale(cam.zoom, cam.zoom);

    // 战场边框：虚线，缩小后仍然是 1px
    ctx.setLineDash([5, 9]);
    ctx.strokeStyle = "rgba(80,120,160,.14)";
    ctx.lineWidth = 1 / cam.zoom;
    ctx.strokeRect(0.5, 0.5, view.world.w - 1, view.world.h - 1);
    ctx.setLineDash([]);

    for (const b of view.bases) this.drawBase(b);
    for (const tw of view.towers) this.drawTower(tw);
    drawUnits(ctx, view.units, view.squads);
    drawFx(ctx, view.fx);
    drawProjectiles(ctx, view.projectiles);

    ctx.restore();
  }

  /** 空间站 + 血条 */
  drawBase(b) {
    const ctx = this.ctx;
    const R = b.radius;

    ctx.save();
    ctx.translate(b.x, b.y);
    if (b.dead) ctx.globalAlpha = 0.35;
    drawStation(ctx, b.hue, b.pulse, R);
    ctx.restore();

    const { w: bw, h: bh } = BASE_BAR;
    const bx = b.x - bw / 2, by = b.y + R + 18;
    const f = Math.max(0, Math.min(1, b.hp / b.maxHp));

    ctx.fillStyle = "rgba(6,10,16,.8)";
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = hpColor(b.hue, f);
    ctx.fillRect(bx, by, bw * f, bh);

    ctx.save();
    ctx.font = "600 10px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(150,175,200,.75)";
    ctx.fillText(Math.max(0, Math.round(b.hp)) + " / " + b.maxHp, b.x, by + 8);
    ctx.restore();
  }

  /** 防御塔 + 掉血时才出现的小血条 */
  drawTower(tw) {
    const ctx = this.ctx;

    ctx.save();
    ctx.translate(tw.x, tw.y);
    if (tw.dead) ctx.globalAlpha = 0.32;
    drawTowerArt(ctx, tw.hue, tw.pulse, tw.radius);
    ctx.restore();

    if (tw.dead || tw.hp >= tw.maxHp) return;

    const { w: bw, h: bh } = TOWER_BAR;
    const bx = tw.x - bw / 2, by = tw.y + tw.radius + 12;
    const f = Math.max(0, Math.min(1, tw.hp / tw.maxHp));

    ctx.fillStyle = "rgba(6,10,16,.8)";
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = hpColor(tw.hue, f);
    ctx.fillRect(bx, by, bw * f, bh);
  }
}

function hpColor(hue, f) {
  return f > 0.5 ? "hsl(" + hue + ",72%,58%)"
       : f > 0.25 ? "#e8c14a" : "#e8564f";
}

/** 工厂：以后加 Pixi 实现时，这里换一行即可 */
export function createCanvas2DRenderer(canvas) {
  return new Canvas2DRenderer(canvas);
}
