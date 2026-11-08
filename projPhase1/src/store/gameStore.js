/**
 * 游戏 store（UI 侧的唯一数据源）
 * -----------------------------------------------------------------
 * 里面**没有**模拟状态：没有 units、没有 projectiles、没有 fx。
 * 只有 core.snapshot() 推过来的那几个数字 + 纯 UI 状态。
 *
 * 换成 Zustand 时，这个文件整体变成：
 *   export const useGameStore = create(() => ({ snap: null, selectedId: 0, fps: 0, msg: null }));
 * 其余模块不用动。
 */

import { createStore } from "./createStore.js";

export const gameStore = createStore({
  /** core.snapshot() 的原样拷贝，10 Hz 更新 */
  snap: null,
  /** 当前选中的小队 id（纯 UI 状态，core 不需要知道） */
  selectedId: 0,
  /** 帧率，只用于显示 */
  fps: 0,
  /** 最近一条提示：{ kind: "ok" | "error", text, at } */
  msg: null
});

export const actions = {
  applySnapshot(snap) {
    gameStore.setState({ snap });
  },

  setFps(fps) {
    gameStore.setState({ fps });
  },

  select(id) {
    gameStore.setState({ selectedId: id });
  },

  message(kind, text) {
    gameStore.setState({ msg: { kind, text, at: Date.now() } });
  }
};
