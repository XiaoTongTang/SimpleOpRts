/**
 * 启动入口
 * -----------------------------------------------------------------
 * 这里负责「组装」，不负责游戏规则，也不负责画面细节。
 *
 * 全项目只有一个主循环（rAF）：
 *   core.step → renderer.draw → bridge.tick
 * React（将来）不注册自己的 rAF，只跟着 store 更新。
 */

import { GameCore } from "./core/core.js";
import { createCanvas2DRenderer } from "./render/render-canvas2d.js";
import { gameStore, actions } from "./store/gameStore.js";
import { loadShips, saveShips } from "./store/persist.js";
import { createBridge } from "./bridge.js";
import { mountUI } from "./ui/ui.js";

const FIXED = 1 / 60;

const cvs = document.getElementById("c");
const renderer = createCanvas2DRenderer(cvs);

// 先读方案库：玩家的设计跨局保留，重开不清空
const core = new GameCore({
  width: window.innerWidth,
  height: window.innerHeight,
  ships: loadShips()
});
const bridge = createBridge(core, gameStore, { hz: 10 });

let lastShipRev = core.shipRev;

renderer.resize(window.innerWidth, window.innerHeight);
mountUI({ store: gameStore, bridge });

window.addEventListener("resize", () => {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.resize(w, h);
  bridge.resize(w, h);
});

// 调试钩子：允许在控制台直接发命令（等价于 UI 的一条命令）
window.__CORE = core;
window.__STORE = gameStore;
window.__CMD = cmd => bridge.run(cmd);

let last = performance.now();
let acc = 0;

// FPS 统计
let fpsAcc = 0, fpsFrames = 0;

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  // ---- 1. 模拟（固定步长，追帧上限 5 步） ----
  if (!core.paused) {
    acc += dt;
    let guard = 0;
    while (acc >= FIXED && guard++ < 5) {
      core.step(FIXED);
      acc -= FIXED;
    }
    if (acc > FIXED) acc = 0;
    core.stepFx(dt);
  }

  // ---- 2. 渲染（直接读 core 的只读投影，不经过 store） ----
  renderer.draw(core.getView());

  // ---- 3. 快照（节流推给 UI） ----
  bridge.tick(dt);

  // ---- 4. 方案库有改动就落盘 ----
  if (core.shipRev !== lastShipRev) {
    lastShipRev = core.shipRev;
    saveShips(core.ships);
  }

  // ---- FPS ----
  fpsAcc += dt; fpsFrames++;
  if (fpsAcc >= 0.5) {
    actions.setFps(Math.round(fpsFrames / fpsAcc));
    fpsAcc = 0; fpsFrames = 0;
  }

  requestAnimationFrame(frame);
}

// 首帧先推一次快照，避免 UI 空白
bridge.pushNow();
requestAnimationFrame(frame);
