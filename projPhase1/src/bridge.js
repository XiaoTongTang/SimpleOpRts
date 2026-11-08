/**
 * core ⇄ store 的桥
 * -----------------------------------------------------------------
 * 全部数据流只有两个方向，都写在这里，别处不许绕：
 *
 *   core  →  store    每 100 ms 推一次 snapshot（不含每帧数据）
 *   store →  core     run(cmd) 走 core.command()，失败把 reasons 原样交给 UI
 *
 * UI 不允许直接调用 core，也不允许自己判断一次编辑合不合法。
 */

import { actions } from "./store/gameStore.js";

export function createBridge(core, store, opts = {}) {
  const interval = 1 / (opts.hz || 10);
  let acc = interval;        // 首帧立刻推一次

  function push() {
    actions.applySnapshot(core.snapshot());
  }

  return {
    /** 每帧调用；内部自己节流 */
    tick(dt) {
      acc += dt;
      if (acc < interval) return;
      acc = 0;
      push();
    },

    /**
     * 唯一写入通道
     * @returns {{ok:boolean, reasons?:string[]}}
     */
    run(cmd) {
      const r = core.command(cmd);
      if (r.ok) {
        actions.message("ok", describe(cmd));
      } else {
        // 文案完全来自 core，UI 不加工、不翻译
        actions.message("error", (r.reasons || ["被拒绝"]).join("；"));
      }
      acc = interval;          // 立刻刷新，别等下一个节流窗口
      push();
      return r;
    },

    /** 窗口尺寸变化 */
    resize(width, height) {
      core.setViewport(width, height);
    },

    pushNow: push
  };
}

function describe(cmd) {
  switch (cmd.type) {
    case "setLoadout": return "编制已更新";
    case "setPaused": return cmd.value ? "已暂停" : "继续";
    case "reset": return "已重开";
    case "setParam": return `参数 ${cmd.key} = ${cmd.value}`;
    default: return "已应用";
  }
}
