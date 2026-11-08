/**
 * 船体模板（HullTemplate）
 * -----------------------------------------------------------------
 * 开发者预设、只读。玩家不能改船体，只能通过「船体蓝图」解锁它的建造权限。
 * 设计见 design/261107_2机制改进/战舰构筑数据结构.md
 *
 * 三条纪律：
 *   1. 本文件只有数据 + 纯函数，没有状态
 *   2. 移动/武器/防御的运行参数一律从 armor 块读，不再散落在别处
 *   3. 指挥值、建造时间**不要手写**，由 hullCommand() / hullBuildTime() 推导
 */

/** 推导常量：改这里就等于重新平衡全表 */
export const COMMAND_WEIGHTS = {
  hp: 1 / 15,       // 每 15 点血 = 1 指挥值
  shield: 1 / 30,   // 每 30 点盾 = 1 指挥值
  capacity: 1 / 40  // 每 40 点承载量 = 1 指挥值
};

/** 每 1 点指挥值对应的船体建造工时（秒），按级别递增 */
export const CLASS_TIME_MUL = {
  frigate: 2.0,
  destroyer: 2.6,
  cruiser: 2.9,
  mothership: 0
};

/** 插槽尺寸等级：大槽能装小武器，小槽不能装大武器 */
export const SIZE_RANK = { S: 0, M: 1, L: 2 };

/**
 * 船体模板字段
 *   id          稳定唯一键
 *   name        显示名
 *   class       frigate | destroyer | cruiser | mothership
 *   tier        同级内档次，用于排序与蓝图稀有度
 *   sprite      { sheet, frame } 贴图引用（见 imgs/*_atlas.json）
 *   capacity    最大装配承载量
 *   slots.weapon[]  { id, size, pos?, arc? }  pos 为船体局部坐标（像素）
 *   slots.plugin[]  { id }                    插件槽不分尺寸
 *   armor       { hp, hpRegen, shield, shieldRegen, hullHitR, shieldHitR }
 *   mothership  仅母舰有，见下方 hull.ark
 */
export const HULL_TEMPLATES = {
  "hull.falcon": {
    id: "hull.falcon",
    name: "矛隼级",
    class: "frigate",
    tier: 1,
    sprite: { sheet: "护卫舰素材1", frame: "frigate_01" },
    capacity: 12,
    slots: {
      weapon: [
        { id: "w1", size: "S", pos: [-5, -7], arc: 220 },
        { id: "w2", size: "S", pos: [5, -7], arc: 220 }
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
    sprite: { sheet: "护卫舰素材1", frame: "frigate_17" },
    capacity: 16,
    slots: {
      weapon: [
        { id: "w1", size: "M", pos: [0, -7], arc: 200 },
        { id: "w2", size: "S", pos: [6, 4], arc: 200 }
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
    sprite: { sheet: "护卫舰素材1", frame: "frigate_33" },
    capacity: 30,
    slots: {
      weapon: [
        { id: "w1", size: "M", pos: [0, -9], arc: 260 },
        { id: "w2", size: "S", pos: [-8, -2], arc: 180 },
        { id: "w3", size: "S", pos: [8, -2], arc: 180 }
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
    sprite: { sheet: "护卫舰素材1", frame: "frigate_49" },
    capacity: 60,
    slots: {
      weapon: [
        { id: "w1", size: "L", pos: [0, -12], arc: 160 },
        { id: "w2", size: "M", pos: [-11, 0], arc: 240 },
        { id: "w3", size: "M", pos: [11, 0], arc: 240 },
        { id: "w4", size: "S", pos: [0, 10], arc: 300 }
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
    sprite: { sheet: "母舰可用素材_atlas", frame: "母舰4_3" },
    capacity: 20,
    slots: {
      weapon: [{ id: "w1", size: "S", pos: [0, -10], arc: 360 }],
      plugin: [{ id: "p1" }, { id: "p2" }]
    },
    armor: { hp: 3000, hpRegen: 20, shield: 0, shieldRegen: 0, hullHitR: 40, shieldHitR: 40 },
    /** 母舰专属：不参与编队指挥值计算，自己提供指挥值总量 */
    mothership: {
      moduleCap: 60,          // 预制模组存储上限
      moduleRegen: 0.6,       // 预制模组自然恢复 / 秒
      lines: 3,               // 生产线数量
      efficiency: 30,         // 生产效率总和（每分钟工时）
      repairDrones: { count: 4, rate: 8, radius: 180 },
      commandCap: 900,        // 舰队指挥值总量
      captureLimit: 3         // 可占领建筑上限
    }
  }
};

export const HULL_IDS = Object.keys(HULL_TEMPLATES);

/**
 * 占用指挥值。母舰不计入舰队人口，返回 0。
 * 只取船体属性，**与装配无关**——玩家能做的是「用同样的指挥值塞进更多战斗力」。
 */
export function hullCommand(hull) {
  if (!hull || hull.class === "mothership") return 0;
  const a = hull.armor;
  const raw =
    a.hp * COMMAND_WEIGHTS.hp +
    a.shield * COMMAND_WEIGHTS.shield +
    hull.capacity * COMMAND_WEIGHTS.capacity;
  return Math.max(1, Math.round(raw));
}

/** 船体基准建造工时（秒）。挂武器/插件还要另外加时间，见 ship-template.js */
export function hullBuildTime(hull) {
  if (!hull) return 0;
  return round1(hullCommand(hull) * (CLASS_TIME_MUL[hull.class] || 0));
}

/** 取某个插槽定义（武器槽或插件槽） */
export function findSlot(hull, slotId) {
  if (!hull) return null;
  for (const s of hull.slots.weapon) if (s.id === slotId) return { ...s, kind: "weapon" };
  for (const s of hull.slots.plugin) if (s.id === slotId) return { ...s, kind: "plugin" };
  return null;
}

export function round1(v) {
  return Math.round(v * 10) / 10;
}
