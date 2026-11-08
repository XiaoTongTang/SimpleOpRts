/**
 * 方案库持久化（开发期用 localStorage，将来换成存档文件/云存档只改这一层）
 * -----------------------------------------------------------------
 * 只存「能重建装配」的最小信息（船体 id + 每个槽装了什么 + 名字），
 * derived 一律读档后重算 —— 这样改了数值表，旧存档自动跟着更新，
 * 不会出现「存档里躺着一份过期的人口/工时」。
 *
 * core 不认识 localStorage，所以这一层故意放在 store/ 而不是 core/。
 */

import { serializeLibrary, deserializeLibrary } from "../core/data/ship-library.js";

const KEY = "simpleoprts.ships.v1";

/** 读档。没有存档 / 存档坏了都返回 null，让 core 走默认库。 */
export function loadShips() {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    const raw = ls.getItem(KEY);
    if (!raw) return null;
    const lib = deserializeLibrary(JSON.parse(raw));
    return Object.keys(lib).length ? lib : null;
  } catch {
    return null;
  }
}

/** 写档。失败（隐私模式/配额满）不抛错，只是这局不持久化。 */
export function saveShips(lib) {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return false;
    ls.setItem(KEY, JSON.stringify(serializeLibrary(lib)));
    return true;
  } catch {
    return false;
  }
}

export function clearShips() {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch { /* 忽略 */ }
}
