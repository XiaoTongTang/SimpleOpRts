/**
 * 船体模板 HullTemplate
 * -----------------------------------------------------------------
 * 开发者预设、只读。玩家不能改船体，只能通过「船体蓝图」解锁建造权限。
 * 设计见 design/261107_2机制改进/战舰构筑数据结构.md
 *
 * 纪律：
 *   1. 本文件只有数据 + 纯函数，没有状态
 *   2. command / buildTime / capacity 是**手填的权威值**，不要改成推导
 *      推荐值由 recommend.js 另算，只用来做偏离审计（见 balance.audit.mjs）
 *   3. 武器槽只有 id / size / pos，**没有 arc**：RTS 不做转角限制
 *   4. pos 是船体局部坐标：[+x 船头, +y 左舷]，按航向旋转后作为炮口位置
 */

import { deepFreeze } from "./util.js";

/** 尺寸等级：大槽能装小武器，小槽不能装大武器 */
export const SIZE_RANK = { S: 0, M: 1, L: 2 };

/**
 * 槽位「容积」：一个槽最多能塞多少承载量的装备。
 * 承载量上限的推荐值 = Σ 容积 × FILL_RATIO，所以这两个数必须一起改。
 */
export const SLOT_VOLUME = {
  weaponS: 5,
  weaponM: 8,
  weaponL: 12,
  plugin: 4
};

/**
 * 船体模板字段
 *   id / name / class / tier / sprite
 *   command    占总人口（母舰为 0，它自己是人口的提供方）
 *   buildTime  船体基准工时（秒），未除生产线效率
 *   capacity   承载量上限
 *   slots      { weapon: [{id,size,pos?}], plugin: [{id}] }
 *   armor      { hp, hpRegen, shield, shieldRegen, hullHitR, shieldHitR }
 *   abilities  可选，船体自带的支援能力（目前只有母舰）
 *   mothership 仅母舰有
 */
export const HULL_TEMPLATES = {
  "hull.falcon": {
    id: "hull.falcon",
    name: "矛隼级",
    class: "frigate",
    tier: 1,
    sprite: { sheet: "frigate", index: 12 },   // 细长型 · 矛隼

    command: 4,
    buildTime: 8.0,
    capacity: 14,

    slots: {
      weapon: [
        { id: "w1", size: "S", pos: [6, -4] },
        { id: "w2", size: "S", pos: [6, 4] }
      ],
      plugin: [{ id: "p1" }, { id: "p2" }]
    },
    armor: { hp: 60, hpRegen: 2.0, shield: 0, shieldRegen: 0, hullHitR: 6, shieldHitR: 10 }
  },

  "hull.bulwark": {
    id: "hull.bulwark",
    name: "壁垒级",
    class: "frigate",
    tier: 2,
    sprite: { sheet: "frigate", index: 33 },   // 后掠翼 · 壁垒

    command: 6,
    buildTime: 12.0,
    capacity: 17,

    slots: {
      weapon: [
        { id: "w1", size: "M", pos: [5, 0] },
        { id: "w2", size: "S", pos: [-2, 5] }
      ],
      plugin: [{ id: "p1" }, { id: "p2" }]
    },
    armor: { hp: 75, hpRegen: 2.5, shield: 30, shieldRegen: 1.5, hullHitR: 6.5, shieldHitR: 10.5 }
  },

  "hull.hammer": {
    id: "hull.hammer",
    name: "重锤级",
    class: "destroyer",
    tier: 1,
    sprite: { sheet: "frigate", index: 47 },   // 方厚型 · 重锤

    command: 10,
    buildTime: 26.0,
    capacity: 24,

    slots: {
      weapon: [
        { id: "w1", size: "M", pos: [8, 0] },
        { id: "w2", size: "S", pos: [-4, -6] },
        { id: "w3", size: "S", pos: [-4, 6] }
      ],
      plugin: [{ id: "p1" }, { id: "p2" }, { id: "p3" }]
    },
    armor: { hp: 130, hpRegen: 3.0, shield: 30, shieldRegen: 2.0, hullHitR: 9, shieldHitR: 14 }
  },

  "hull.citadel": {
    id: "hull.citadel",
    name: "堡垒级",
    class: "cruiser",
    tier: 1,
    sprite: { sheet: "frigate", index: 9 },    // 重甲型 · 堡垒

    command: 22,
    buildTime: 63.8,
    capacity: 34,

    slots: {
      weapon: [
        { id: "w1", size: "M", pos: [12, -4] },
        { id: "w2", size: "M", pos: [12, 4] },
        { id: "w3", size: "S", pos: [-8, -8] },
        { id: "w4", size: "S", pos: [-8, 8] }
      ],
      plugin: [{ id: "p1" }, { id: "p2" }, { id: "p3" }, { id: "p4" }]
    },
    armor: { hp: 280, hpRegen: 6.0, shield: 60, shieldRegen: 4.0, hullHitR: 13, shieldHitR: 19 }
  },

  "hull.ark": {
    id: "hull.ark",
    name: "方舟级",
    class: "mothership",
    tier: 1,
    sprite: { sheet: "mothership", index: 0 }, // 母舰图集第 1 帧

    command: 0,          // 母舰不进舰队人口，它提供人口
    buildTime: 0,
    capacity: 10,

    slots: {
      weapon: [{ id: "w1", size: "S", pos: [8, 0] }],
      plugin: [{ id: "p1" }, { id: "p2" }]
    },
    armor: { hp: 3000, hpRegen: 20, shield: 0, shieldRegen: 0, hullHitR: 40, shieldHitR: 40 },

    /** 母舰自带 4 架维修无人机：走能力模板，和插件装的维修模块完全同一套代码 */
    abilities: [{ id: "ability.repair_drone", count: 4 }],

    mothership: {
      moduleCap: 60,          // 预制模组存储上限
      moduleRegen: 0.6,       // 预制模组自然恢复 / 秒（生产线忙也照常）
      lines: 3,               // 生产线数量
      efficiency: 30,         // 生产效率总和（工时/分钟）
      commandCap: 900,        // 舰队指挥值总量
      captureLimit: 3         // 可占领建筑上限
    }
  }
};

deepFreeze(HULL_TEMPLATES);

export const HULL_IDS = Object.keys(HULL_TEMPLATES);

/** 取船体模板，找不到返回 null */
export function getHull(id) {
  return HULL_TEMPLATES[id] || null;
}

/** 找某个插槽定义；kind 是 "weapon" | "plugin" */
export function findSlot(hull, slotId) {
  if (!hull) return null;
  for (const s of hull.slots.weapon) if (s.id === slotId) return { ...s, kind: "weapon" };
  for (const s of hull.slots.plugin) if (s.id === slotId) return { ...s, kind: "plugin" };
  return null;
}

/** 某船体所有插槽 id（顺序：先武器后插件） */
export function slotIds(hull) {
  return [...hull.slots.weapon.map(s => s.id), ...hull.slots.plugin.map(s => s.id)];
}

/** 某船体的槽位容积和（承载量推荐值的基础） */
export function slotVolume(hull) {
  let sum = 0;
  for (const s of hull.slots.weapon) sum += SLOT_VOLUME["weapon" + s.size];
  sum += hull.slots.plugin.length * SLOT_VOLUME.plugin;
  return sum;
}
