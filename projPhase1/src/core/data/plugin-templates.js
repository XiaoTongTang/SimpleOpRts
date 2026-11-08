/**
 * 插件模板（PluginTemplate）
 * -----------------------------------------------------------------
 * 最小占位集：插件的完整设计（获取途径、套装、改装）后面单独做，
 * 这里只提供「舰船模板」引用插件所必需的那几个字段。
 *
 * 字段：
 *   id        稳定唯一键，蓝图解锁按它走
 *   name      显示名
 *   capacity  占用船体承载量
 *   buildTime 附加建造工时（秒，未除以生产线效率）
 *   mods      对船体属性的加成，键名与船体 armor 字段同名
 *             capacity 特例：加到「最大装配承载量」上（扩容类插件）
 *             fireRate 特例：开火冷却乘数，<1 表示更快
 */

export const PLUGINS = {
  "plugin.capacitor": {
    id: "plugin.capacitor",
    name: "扩容电容",
    capacity: 2,
    buildTime: 0.8,
    mods: { capacity: 6 }
  },
  "plugin.shellplate": {
    id: "plugin.shellplate",
    name: "附加装甲",
    capacity: 3,
    buildTime: 1.5,
    mods: { hp: 25, hullHitR: 1.5 }
  },
  "plugin.deflector": {
    id: "plugin.deflector",
    name: "偏导护盾",
    capacity: 4,
    buildTime: 2.0,
    mods: { shield: 40, shieldRegen: 2 }
  },
  "plugin.autoloader": {
    id: "plugin.autoloader",
    name: "自动装填机",
    capacity: 3,
    buildTime: 1.8,
    mods: { fireRate: 0.85 }
  }
};

export const PLUGIN_IDS = Object.keys(PLUGINS);
