/**
 * 能力模板 AbilityTemplate
 * -----------------------------------------------------------------
 * 设计见 design/261107_2机制改进/支援能力设计.md
 *
 * 这是「作用在友军身上的持续性资源恢复光环」，按 resource 分成两种：
 *   shield → 补护盾，可以顺带抬高目标护盾上限（grant）
 *   hull   → 补血量，不能超上限
 *
 * 三件事刻意不做：
 *   1. 没有能量、没有冷却、没有「使用次数」——纯速率，数值直接可读
 *   2. 不区分「建筑维修」——阶段一没有建筑
 *   3. 不写表现细节——fx 只是个 key，怎么画由渲染层决定
 *
 * 能力本身不挂载、不占空间。占空间的是**载体**（插件），能力只是载体指向的一张表。
 */

export const ABILITY_TEMPLATES = {
  "ability.shield_charger_s": {
    id: "ability.shield_charger_s",
    name: "护盾充能器·小",
    desc: "给半径内的友军补充护盾，并临时抬高他们的护盾上限",
    resource: "shield",
    radius: 140,
    rate: 10,            // 每个目标每秒 +10 点护盾
    maxTargets: 2,       // 单台设备同时照顾 2 个
    grant: 30,           // 临时 +30 护盾上限（多源取 max）
    includeSelf: true,
    select: "lowestRatio",
    fx: "shieldlink"
  },

  "ability.shield_charger_l": {
    id: "ability.shield_charger_l",
    name: "护盾充能器·大",
    desc: "舰队级的护盾保障，范围与回充速度都更高",
    resource: "shield",
    radius: 200,
    rate: 24,
    maxTargets: 4,
    grant: 60,
    includeSelf: true,
    select: "lowestRatio",
    fx: "shieldlink"
  },

  "ability.repair_drone": {
    id: "ability.repair_drone",
    name: "维修无人机",
    desc: "自动维修半径内血量百分比最低的友军",
    resource: "hull",
    radius: 180,
    rate: 8,
    // 刻意是 1：一架无人机照顾一艘船。想照顾更多目标就多装几架（count）
    maxTargets: 1,
    grant: 0,
    includeSelf: true,
    select: "lowestRatio",
    fx: "repairbeam"
  }
};

export const ABILITY_IDS = Object.keys(ABILITY_TEMPLATES);

/** 是否为护盾类能力（决定目标有效性判据、以及 grant 是否生效） */
export function isShieldAbility(a) {
  return a.resource === "shield";
}
