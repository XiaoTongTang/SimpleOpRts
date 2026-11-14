/**
 * 启动入口
 * -----------------------------------------------------------------
 * 这里负责「组装」，不负责游戏规则，也不负责画面细节。
 *
 * 全项目只有一个主循环（rAF）：
 *   core.step → renderer.draw → bridge.tick
 * React（将来）不注册自己的 rAF，只跟着 store 更新。
 *
 * 渲染器是 PixiJS（WebGL）：要先等它（和贴图）初始化完，再开始跑循环。
 */

import { GameCore } from "./core/core.js";
import { blankMap } from "./core/map.js";
import { createPixiRenderer } from "./render/render-pixi.js";
import { gameStore, actions } from "./store/gameStore.js";
import { loadShips, saveShips } from "./store/persist.js";
import { createBridge } from "./bridge.js";
import { mountUI } from "./ui/ui.js";

const FIXED = 1 / 60;

// 地图是固定大小的：窗口怎么变都不动它，取景靠相机（滚轮缩放 / 中键拖拽 / 小地图）
const WORLD_W = 2000;
const WORLD_H = 1200;

async function boot() {
  const cvs = document.getElementById("c");
  const renderer = await createPixiRenderer(cvs);

  // 先读方案库：玩家的设计跨局保留，重开不清空
  // 世界尺寸由地图派生：这里只给出"默认地图"是什么，core 从它读出 width / height
  const core = new GameCore({
    map: blankMap(WORLD_W, WORLD_H, 8, "默认战场"),
    ships: loadShips()
  });
  const bridge = createBridge(core, gameStore, { hz: 10 });

  let lastShipRev = core.shipRev;

  const ui = mountUI({ store: gameStore, bridge });

  /**
   * 把画布钉在「战场」那一格上。
   * 战场渲染区从此等于中间那栏 —— 不会再有内容跑到左右栏底下去。
   */
  function layout() {
    const r = ui.fieldRect();
    if (!r || r.width < 8 || r.height < 8) return;    // 构筑界面打开时战场不可见
    cvs.style.left = r.left + "px";
    cvs.style.top = r.top + "px";
    cvs.style.width = r.width + "px";
    cvs.style.height = r.height + "px";
    renderer.resize(r.width, r.height);
    bridge.resize(r.width, r.height);
  }
  layout();

  // 战场那一格的尺寸变化（窗口缩放、面板宽度、进出构筑界面）都重新钉一次
  new ResizeObserver(layout).observe(document.getElementById("field"));
  window.addEventListener("resize", layout);

  // 调试钩子：允许在控制台直接发命令（等价于 UI 的一条命令）
  window.__CORE = core;
  window.__STORE = gameStore;
  window.__CMD = cmd => bridge.run(cmd);
  window.__RENDERER = renderer;

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
    const view = core.getView();
    renderer.draw(view);
    ui.syncBattlefield(view);       // 小队标识 / 命令信标跟着每帧位置走

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
}

boot();
