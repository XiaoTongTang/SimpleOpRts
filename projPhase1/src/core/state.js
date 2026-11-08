/**
 * 构筑状态（build state）
 * -----------------------------------------------------------------
 * 这是「玩家能改的东西」的权威定义，住在 core 里，不住在 UI 里。
 *
 * 为什么放 core：改编制要受指挥值、预制模组约束，而规则属于模拟层。
 * UI 只能拿到它的投影 + 一份草稿，写入必须走 core.command()。
 *
 * 本文件是纯函数与常量，没有状态，方便单测。
 */

/** 船体表：费用 = 指挥值占用。
 *  初始编制 = 8 队 × 24 护卫 + 2 队 × 6 散兵 = 816，对上 900 的上限留一点余量。*/
export const HULLS = {
  frigate:   { name: "护卫舰", cost: 4,  hp: 60,  key: "frigate" },
  destroyer: { name: "驱逐舰", cost: 10, hp: 130, key: "destroyer" },
  cruiser:   { name: "巡洋舰", cost: 22, hp: 260, key: "cruiser" }
};

export const HULL_IDS = Object.keys(HULLS);

/** 单队编制硬上限（防止 UI 传一个离谱数字进来） */
export const MAX_PER_SQUAD = 48;

/** 一次战斗开局给的预制模组 */
export const START_MODULES = 24;

/** 指挥值上限 */
export const START_COMMAND_CAP = 900;

/** 一次编制增减的模组消耗（瞬间建成一艘船 = 1 个模组） */
export const MODULES_PER_SHIP = 1;

/** 单条编制的指挥值占用 */
export function entryCost(hull, count) {
  const h = HULLS[hull] || HULLS.frigate;
  return Math.max(0, Math.floor(count || 0)) * h.cost;
}

/** 整支部队已占用的指挥值 */
export function commandsUsed(build) {
  let sum = 0;
  for (const s of build.squads) sum += entryCost(s.hull, s.count);
  return sum;
}

/**
 * 初始构筑：与 sim 层 SQUAD_DEF 一一对应（10 队：双方各 4 正规 + 1 散兵）。
 * 计数来自 squad-layer 里正规队 24 / 散兵 6 的默认值。
 */
export function createBuild() {
  const squads = [];
  for (let i = 0; i < 10; i++) {
    const faction = i < 4 ? 0 : i < 8 ? 1 : i === 8 ? 0 : 1;
    const loose = i >= 8;
    squads.push({
      id: i,
      key: loose ? "散" : "ABCDEFGH"[i % 8],
      faction,
      loose,
      hull: "frigate",
      count: loose ? 6 : 24,
      weapon: "laser"
    });
  }
  return {
    squads,
    modules: START_MODULES,
    commandCap: START_COMMAND_CAP
  };
}

/** 深拷贝一份构筑（草稿用，避免 UI 直接摸到 core 的对象） */
export function cloneBuild(build) {
  return {
    modules: build.modules,
    commandCap: build.commandCap,
    squads: build.squads.map(s => ({ ...s }))
  };
}
