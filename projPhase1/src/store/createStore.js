/**
 * 极小 store（Zustand 形状）
 * -----------------------------------------------------------------
 * 阶段一没有 npm 依赖，所以先自己实现一份**接口与 Zustand 一致**的 store。
 * 等 React / Zustand 能装上时，替换成：
 *
 *   import { create } from "zustand";
 *   export const useGameStore = create(() => ({ ... }));
 *
 * 组件与 bridge 都只依赖下面这几个方法，所以替换是机械的：
 *   getState()          组件外读
 *   setState(partial)   组件外写（bridge 从游戏循环推快照就走这里）
 *   subscribe(fn)       订阅全部变化
 *   subscribeSel(sel, fn)  只订阅某个切片（对应 subscribeWithSelector）
 */

export function createStore(initialState) {
  let state = initialState;
  const listeners = new Set();

  function emit(prev) {
    for (const l of listeners) l(state, prev);
  }

  const api = {
    getState: () => state,

    setState(partial) {
      const prev = state;
      const next = typeof partial === "function" ? partial(state) : partial;
      if (!next) return;
      state = { ...state, ...next };
      emit(prev);
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** 只在 selector 结果变化时回调（浅比较） */
    subscribeSel(selector, fn) {
      let last = selector(state);
      return api.subscribe(s => {
        const now = selector(s);
        if (!shallowEqual(now, last)) {
          const prev = last;
          last = now;
          fn(now, prev);
        }
      });
    }
  };

  return api;
}

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}
