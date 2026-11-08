/**
 * 相机自检
 *   node test/camera.smoke.mjs
 *
 * 规则：
 *   1. 世界（地图）是固定大小，setViewport 只改视口，不改世界
 *   2. 默认缩放 = 整图刚好铺满视口；相机居中
 *   3. 滚轮缩放以锚点为轴：锚点下的世界坐标不动
 *   4. 相机永远夹在世界里，看不到地图外面
 */

import { GameCore } from "../src/core/core.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
  : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));
const eq = (n, a, b) => ok(n, a === b, `期望 ${b}，实际 ${a}`);
const near = (n, a, b, eps = 1e-6) => ok(n, Math.abs(a - b) <= eps, `期望 ${b}，实际 ${a}`);

const mk = (w = 2000, h = 1200) => new GameCore({ width: w, height: h });

console.log("\n[1] 视口 ≠ 世界");
{
  const core = mk();
  eq("世界宽度固定", core.width, 2000);
  core.setViewport(900, 700);
  eq("setViewport 不改世界宽度", core.width, 2000);
  eq("setViewport 不改世界高度", core.height, 1200);

  const cam = core.getView().camera;
  near("视口被记住了（宽）", cam.vw, 900);
  near("视口被记住了（高）", cam.vh, 700);
}

console.log("\n[2] 默认取景 = 整图铺满并居中");
{
  const core = mk();
  core.setViewport(900, 700);
  const cam = core.getView().camera;
  const fit = Math.min(900 / 2000, 700 / 1200);
  near("缩放 = fit", cam.zoom, fit);
  near("相机在水平中点", cam.x, 1000);
  near("相机在垂直中点", cam.y, 600);
  // 世界中心应该落在视口中心
  const sx = 1000 * cam.zoom + cam.ox;
  const sy = 600 * cam.zoom + cam.oy;
  near("世界中心映射到视口正中（x）", sx, 450);
  near("世界中心映射到视口正中（y）", sy, 350);
}

console.log("\n[3] 滚轮缩放以锚点为轴");
{
  const core = mk();
  core.setViewport(900, 700);
  core.command({ type: "setCamera", zoom: 2 });
  core.command({ type: "setCamera", x: 1000, y: 600 });

  // 只有两个方向都能移动时才谈得上「锚点不动」，所以先放大
  const ax = 200, ay = 500;
  const before = core.getView().camera;
  const wx = before.x + (ax - before.vw / 2) / before.zoom;
  const wy = before.y + (ay - before.vh / 2) / before.zoom;

  const r = core.command({ type: "setCamera", factor: 1.16, ax, ay });
  ok("缩放命令通过", r.ok);

  const after = core.getView().camera;
  ok("确实放大了", after.zoom > before.zoom, `${before.zoom} → ${after.zoom}`);
  near("锚点下的世界坐标没动（x）", after.x + (ax - after.vw / 2) / after.zoom, wx, 1e-9);
  near("锚点下的世界坐标没动（y）", after.y + (ay - after.vh / 2) / after.zoom, wy, 1e-9);
}

console.log("\n[4] 相机夹在世界里");
{
  const core = mk();
  core.setViewport(900, 700);
  core.command({ type: "setCamera", factor: 2, ax: 450, ay: 350 });   // 放大到能移动的程度

  core.command({ type: "setCamera", x: -99999, y: -99999 });
  let cam = core.getView().camera;
  near("拖到世界左上外，视口左边界 = 0", cam.x - cam.vw / (2 * cam.zoom), 0);
  near("拖到世界左上外，视口上边界 = 0", cam.y - cam.vh / (2 * cam.zoom), 0);

  core.command({ type: "setCamera", x: 99999, y: 99999 });
  cam = core.getView().camera;
  near("拖到世界右下外，视口右边界 = 世界宽", cam.x + cam.vw / (2 * cam.zoom), 2000);
  near("拖到世界右下外，视口下边界 = 世界高", cam.y + cam.vh / (2 * cam.zoom), 1200);
}

console.log("\n[5] 缩放范围与全图");
{
  const core = mk();
  core.setViewport(900, 700);
  const fit = core.getView().camera.zoom;

  core.command({ type: "setCamera", factor: 0.01, ax: 450, ay: 350 });
  near("最小缩放到不了全图以外", core.getView().camera.zoom, fit);

  core.command({ type: "setCamera", factor: 999, ax: 450, ay: 350 });
  const zmax = core.getView().camera.zoom;
  ok("最大缩放有上限", zmax <= Math.max(fit * 3.2, 2.6) + 1e-9, String(zmax));

  core.command({ type: "setCamera", fit: true });
  const cam = core.getView().camera;
  near("全图回到 fit", cam.zoom, fit);
  near("全图回中（x）", cam.x, 1000);
  near("全图回中（y）", cam.y, 600);
}

console.log("\n[6] 窗口变化时保持取景不丢");
{
  const core = mk();
  core.setViewport(900, 700);
  core.command({ type: "setCamera", factor: 2, ax: 450, ay: 350 });
  core.setViewport(600, 700);          // 窗口变窄

  const cam = core.getView().camera;
  near("视口宽度跟着变", cam.vw, 600);
  ok("相机仍在世界里", cam.x - cam.vw / (2 * cam.zoom) >= -1e-9
    && cam.x + cam.vw / (2 * cam.zoom) <= 2000 + 1e-9, `${cam.x}`);
}

console.log(fail ? `\n失败 ${fail} 项 / 通过 ${pass} 项` : `\n全部通过：${pass} 通过 / 0 失败`);
process.exit(fail ? 1 : 0);
