/**
 * 插件模板 PluginTemplate
 * -----------------------------------------------------------------
 * 插件是唯一能改船体属性（mods）和提供支援能力（abilities）的装配件。
 * 不分尺寸、不参与开火、占插件槽。
 *
 * 字段：
 *   command    手填，附加指挥值（默认 0，见设计文档 D1）
 *   buildTime  手填，附加工时（秒）
 *   capacity   手填，承载占用
 *   mods       属性加成，键名**与船体 armor 同名**
 *                特例 1：mods.capacity 加到「承载量上限」
 *                特例 2：mods.fireRate 是开火冷却乘数，多插件相乘
 *   abilities  支援能力引用 [{ id, count }]，见 ability-templates.js
 *   limits     { maxPerShip } 同船最多装几个
 *   tags       纯 UI 分类
 *
 * 一个插件可以只有 mods、只有 abilities、或两者都有。
 */

import { deepFreeze } from "./util.js";

export const PLUGIN_TEMPLATES = {
  // ---- 属性类 ----
  "plugin.capacitor": {
    id: "plugin.capacitor",
    name: "扩容电容",
    desc: "腾出更多装配空间，但本身也要占地方",
    command: 0, buildTime: 2.0, capacity: 5,
    mods: { capacity: 6 },
    abilities: [],
    limits: { maxPerShip: 1 },
    tags: ["能源"]
  },

  "plugin.shellplate": {
    id: "plugin.shellplate",
    name: "附加装甲",
    desc: "焊上去的一层装甲板，更耐打也更笨重",
    command: 0, buildTime: 1.2, capacity: 3,
    mods: { hp: 25, hullHitR: 1.5 },
    abilities: [],
    limits: {},
    tags: ["装甲"]
  },

  "plugin.deflector": {
    id: "plugin.deflector",
    name: "偏导护盾",
    desc: "给本舰增加护盾容量与自回速度",
    command: 0, buildTime: 1.6, capacity: 4,
    mods: { shield: 40, shieldRegen: 2 },
    abilities: [],
    limits: {},
    tags: ["护盾"]
  },

  "plugin.autoloader": {
    id: "plugin.autoloader",
    name: "自动装填机",
    desc: "全部武器开火冷却缩短 15%（乘算）",
    command: 0, buildTime: 0.8, capacity: 2,
    mods: { fireRate: 0.85 },
    abilities: [],
    limits: {},
    tags: ["武器"]
  },

  // ---- 支援类 ----
  "plugin.charger_s": {
    id: "plugin.charger_s",
    name: "护盾充能器·小",
    desc: "给附近友军补护盾并临时抬高护盾上限",
    command: 0, buildTime: 1.8, capacity: 4,
    mods: {},
    abilities: [{ id: "ability.shield_charger_s", count: 1 }],
    limits: { maxPerShip: 2 },
    tags: ["支援", "护盾"]
  },

  "plugin.charger_l": {
    id: "plugin.charger_l",
    name: "护盾充能器·大",
    desc: "舰队级护盾保障，范围与回充都更高",
    command: 0, buildTime: 7.2, capacity: 16,
    mods: {},
    abilities: [{ id: "ability.shield_charger_l", count: 1 }],
    limits: { maxPerShip: 1 },
    tags: ["支援", "护盾"]
  },

  "plugin.repair_drone": {
    id: "plugin.repair_drone",
    name: "维修无人机",
    desc: "自动维修半径内血量最低的友军",
    command: 0, buildTime: 0.5, capacity: 1,
    mods: {},
    abilities: [{ id: "ability.repair_drone", count: 1 }],
    limits: { maxPerShip: 3 },
    tags: ["支援", "维修"]
  }
};

deepFreeze(PLUGIN_TEMPLATES);

export const PLUGIN_IDS = Object.keys(PLUGIN_TEMPLATES);

export function getPlugin(id) {
  return PLUGIN_TEMPLATES[id] || null;
}
