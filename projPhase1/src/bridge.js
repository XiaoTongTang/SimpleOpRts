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

    /**
     * 只读查询通道（不写状态）。
     * UI 用它在「真正发命令之前」问一句合不合法，比如装配预览。
     */
    query(cmd) {
      return core.query(cmd);
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
    case "createShip": return "方案已创建";
    case "renameShip": return "方案已改名";
    case "duplicateShip": return "方案已复制";
    case "deleteShip": return "方案已删除";
    case "setShipFit": return "装配已更新";
    case "queueShip": return "已下单，出锅进散兵池";
    case "instantBuild": return "快速建造完成，进散兵池";
    case "absorb": return "已吸收散兵";
    case "disband": return "已解散，舰船退回散兵池";
    case "editSquadTemplate": return "编制模板已更新，引用它的小队已追溯剔除";
    case "setFormation": return "阵型已切换";
    default: return "已应用";
  }
}
