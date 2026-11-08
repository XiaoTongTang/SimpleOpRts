/**
 * 依赖冒烟：验证 React 19 + PixiJS 8 + Zustand 5 在这个环境里能一起跑。
 * 这不是游戏代码，跑通就可以删。
 *
 * 数据流和正式架构一致：
 *   React 只读 store → 点按钮写 store → Pixi 每帧读 store 改变颜色
 */

import { create } from "zustand";
import { Application, Graphics } from "pixi.js";
import { createRoot } from "react-dom/client";
import { useState, useEffect } from "react";
import { createElement as h } from "react";

// ---------------- store（Zustand 真身） ----------------
// 注意：颜色用数字 hex 传给 Pixi，不用 CSS 字符串 —— v8 的 Color 解析对
// "hsl(353,72%,58%)" 这类写法不保证成立，解析失败会静默变黑，很难查。
const PALETTE = [0x4fa3e8, 0xe8614f, 0x7ed957, 0xe8c14a, 0xb07de8];

const useStore = create(set => ({
  idx: 0,
  spins: 0,
  bump: () => set(s => ({ idx: (s.idx + 1) % PALETTE.length, spins: s.spins + 1 }))
}));

// ---------------- Pixi ----------------
async function bootPixi() {
  const app = new Application();
  await app.init({
    background: "#07090d",
    resizeTo: document.getElementById("pixi"),
    antialias: false   // 像素风：先关掉
  });
  document.getElementById("pixi").appendChild(app.canvas);

  const g = new Graphics();
  app.stage.addChild(g);

  let t = 0;
  app.ticker.add(() => {
    t += app.ticker.deltaMS / 1000;
    const { idx, spins } = useStore.getState();   // ← 组件外读 store
    g.clear();
    const R = 70 + Math.sin(t * 2) * 8;
    const pts = Array.from({ length: 3 }, (_, i) => {
      const a = t + spins * 0.4 + i * Math.PI * 2 / 3;
      return [Math.cos(a) * R, Math.sin(a) * R];
    });
    g.poly(pts.map(([x, y]) => ({ x, y })));   // v8 用 {x,y} 最稳
    g.fill(PALETTE[idx]);
    g.position.set(app.renderer.width / 2, app.renderer.height / 2);
    window.__DRAWN = (window.__DRAWN || 0) + 1;
  });

  window.__APP = app;
  window.__G = g;
  window.__TICKER_STARTED = app.ticker.started;

  return app;
}

// ---------------- React ----------------
function Panel() {
  const idx = useStore(s => s.idx);
  const spins = useStore(s => s.spins);
  const bump = useStore(s => s.bump);
  const [fps, setFps] = useState(0);

  useEffect(() => {
    let raf = 0, last = performance.now(), frames = 0;
    const loop = now => {
      frames++;
      if (now - last > 500) { setFps(Math.round(frames * 1000 / (now - last))); frames = 0; last = now; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return h("div", null,
    h("h3", null, "React 19 · 读 Zustand"),
    h("div", { className: "row" }, h("span", null, "色号"), h("b", null, "#" + PALETTE[idx].toString(16).padStart(6, "0"))),
    h("div", { className: "row" }, h("span", null, "点击次数"), h("b", null, spins)),
    h("div", { className: "row" }, h("span", null, "React 自身 FPS"), h("b", null, fps)),
    h("div", { style: { marginTop: 10 } }, h("button", { onClick: bump }, "换色 / 加速旋转")),
    h("h3", { style: { marginTop: 18 } }, "Pixi 8 · 读同一个 store"),
    h("div", { className: "row" }, h("span", null, "渲染器"), h("b", null, "WebGL")),
    h("div", { className: "row" }, h("span", null, "三角形颜色"), h("b", null, "#" + PALETTE[idx].toString(16).padStart(6, "0")))
  );
}

bootPixi().then(() => {
  createRoot(document.getElementById("react")).render(h(Panel));
  window.__SMOKE_OK = true;
}).catch(err => {
  window.__SMOKE_ERR = String(err);
  console.error(err);
});
