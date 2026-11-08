/**
 * 小队编制模板（SquadTemplate）
 * -----------------------------------------------------------------
 * 设计见 design/261107_2机制改进/战斗中小队，散兵，建造关系.md。
 *
 * 一个编制模板 = 「这支小队该有哪些船」+「它能用哪些阵型」：
 *
 *   {
 *     id, name,
 *     entries:  [ { ship: "ship.std_falcon", n: 16 }, ... ]   // 可以有多种型号
 *     formations: [ "form.standard", ... ]                   // 有序，[0] 是默认阵型
 *   }
 *
 * 关键规则（这是"追溯"的来源）：
 *   **改模板 = 立刻改所有引用它的小队**：多出来的船剔除回散兵池，
 *   阵型重置成 formations[0]。小队不是模板的副本，是引用。
 *
 * 不引用模板的小队（无编制小队）自己拿一份 entries，改模板不影响它们，
 * 代价是失去「吸收散兵」。
 *
 * 阵营同构：这张表没有 owner / faction，两个阵营共用。
 */

/** 编队里最多能挂几个阵型（对应快捷键 1~4） */
export const MAX_FORMATION_SLOTS = 4;

/**
 * 内置的 4 个编制模板，成本都是 96 指挥值，
 * 这样初始部署（8 队 + 2 个散兵池）跟以前一样是 816。
 */
export const SQUAD_TEMPLATES = {
  "squad.assault": {
    id: "squad.assault",
    name: "突击队",
    desc: "24 矛隼压上去，基准编制",
    entries: [
      { ship: "ship.std_falcon", n: 24 }
    ],
    formations: ["form.standard", "form.dense", "form.wide"]
  },

  "squad.wall": {
    id: "squad.wall",
    name: "盾墙队",
    desc: "12 矛隼 + 8 壁垒，扛线用",
    entries: [
      { ship: "ship.std_falcon", n: 12 },
      { ship: "ship.std_bulwark", n: 8 }
    ],
    formations: ["form.dense", "form.standard"]
  },

  "squad.raider": {
    id: "squad.raider",
    name: "游击群",
    desc: "14 矛隼 + 4 重锤，打了就跑",
    entries: [
      { ship: "ship.std_falcon", n: 14 },
      { ship: "ship.std_hammer", n: 4 }
    ],
    formations: ["form.guerrilla", "form.wide", "form.standard"]
  },

  "squad.support": {
    id: "squad.support",
    name: "支援队",
    desc: "18 矛隼 + 6 维修舰",
    entries: [
      { ship: "ship.std_falcon", n: 18 },
      { ship: "ship.support_repair", n: 6 }
    ],
    formations: ["form.standard", "form.guerrilla"]
  }
};

export const SQUAD_TEMPLATE_IDS = Object.keys(SQUAD_TEMPLATES);

export function getSquadTemplate(id) {
  return SQUAD_TEMPLATES[id] || null;
}

/** 深拷贝一份 entries（外面的世界不许直接改模板里的数组） */
export function cloneEntries(entries) {
  return (entries || []).map(e => ({ ship: e.ship, n: e.n }));
}

/**
 * 深拷贝整张模板表。
 * 每个 GameCore 拿一份自己的：改模板只影响这一局，不会污染下一局。
 * 和舰船方案库一个道理。
 */
export function cloneTemplateLibrary(src = SQUAD_TEMPLATES) {
  const out = {};
  for (const id of Object.keys(src)) {
    const t = src[id];
    out[id] = {
      ...t,
      entries: cloneEntries(t.entries),
      formations: [...(t.formations || [])]
    };
  }
  return out;
}

/** 编制总艘数 */
export function entriesCount(entries) {
  let n = 0;
  for (const e of entries || []) n += Math.max(0, e.n | 0);
  return n;
}

/** 编制里是否真的有这型船 */
export function entriesHas(entries, shipId) {
  return (entries || []).some(e => e.ship === shipId && e.n > 0);
}
