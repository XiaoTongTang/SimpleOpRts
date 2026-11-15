/**
 * 阵型模板（FormationTemplate）
 * -----------------------------------------------------------------
 * 设计见 design/261107_2机制改进/阵型构筑数据结构.md。
 *
 * 一个阵型模板 = 一整套 Couzin 参数（13 个），切换时整块覆盖 sq.p：
 *
 *   社交力：sepForce · alignForce · cohForce
 *   战斗力：threatForce · seekForce
 *   命令力：commandForce
 *   战术：  arriveR（停车距离） · smallPushShare（谁围绕谁）
 *   半径：  sepRadius 分离（表面间隙） · alignRadius 对齐 · cohRadius 凝聚 · r4 威胁 · r5 感知
 *
 * 三条硬约定：
 *   1. 不做几何阵型（没有 offsets / geometry / rotate），形状是涌现的
 *   2. 切换瞬间生效，不插值、不重建实体
 *   3. 阵型不许改战斗力：p 里只有那 13 个键，不能出现 hp / shield / fireRate
 *
 * 数值来源：**质量速度模型沙盒的实测默认值**（不是旧参数换算出来的），
 * 目的：先让迁移过来的力模型跑出沙盒里那种"不抖"的手感，再谈分化。
 */

export const FORMATIONS = {
  "form.default": {
    id: "form.default",
    name: "默认阵型",
    desc: "数值直接取自质量速度模型沙盒（couzin质量模型-流场寻路-每鸟半径）",
    from: null,
    builtin: true,
    p: {
      // 社交力（px/s²）
      sepForce: 50, alignForce: 45, cohForce: 30,
      // 社交半径（px）：sepRadius 是**表面间隙**
      sepRadius: 12, alignRadius: 55, cohRadius: 180,
      // 命令与战术
      commandForce: 50, arriveR: 135, smallPushShare: 25,
      // （要恢复交战行为，把 threatForce / seekForce 调起来即可）
      threatForce: 50, seekForce: 50,
      r4: 190, r5: 500
    }
  }
};
export const FORMATION_IDS = Object.keys(FORMATIONS);

/** 阵型里允许写进 sq.p 的键（别的一律不许） */
export const FORMATION_KEYS = [
  "sepForce", "alignForce", "cohForce",
  "threatForce", "seekForce", "commandForce",
  "sepRadius", "alignRadius", "cohRadius",
  "arriveR", "smallPushShare",
  "r4", "r5"
];

// ------------------------------------------------------------------
// 参数面板的元数据（阵型编辑界面 + 校验共用同一份）
// ------------------------------------------------------------------
//
// 这是**当前**质量速度模型的 13 个参数，不是旧原型的 12 个（wSep/rRep/… 已经不存在了）。
// 分组依据是"这条参数影响什么"，不是历史包袱。

export const FORMATION_PARAM_GROUPS = [
  {
    title: "社交力",
    hint: "单位 px/s²，越大越硬",
    items: [
      { k: "sepForce", name: "分离力", min: 0, max: 600, step: 5, dec: 0,
        desc: "靠近时互相推开的力度。乘在 1/gap² 上，贴脸时陡增" },
      { k: "alignForce", name: "对齐力", min: 0, max: 400, step: 5, dec: 0,
        desc: "把朝向拧向邻居平均朝向的力度，越大越齐头并进" },
      { k: "cohForce", name: "凝聚力", min: 0, max: 400, step: 5, dec: 0,
        desc: "拉向队形质心的力度。方向归一、幅值固定，与距离无关" }
    ]
  },
  {
    title: "社交半径",
    hint: "单位：世界像素",
    items: [
      { k: "sepRadius", name: "分离间隙", min: 0, max: 80, step: 1, dec: 0,
        desc: "两舰**表面之间**的间隙小于它就互相推开（不是圆心距，圆心距还要加两边半径）" },
      { k: "alignRadius", name: "对齐半径", min: 8, max: 300, step: 1, dec: 0,
        desc: "这个圆心距内才对齐邻居朝向" },
      { k: "cohRadius", name: "凝聚半径", min: 16, max: 600, step: 1, dec: 0,
        desc: "超过它不再有向心力，等于队形半径的上限" }
    ]
  },
  {
    title: "交战",
    hint: "只对敌方生效",
    items: [
      { k: "threatForce", name: "威胁力", min: 0, max: 600, step: 10, dec: 0,
        desc: "敌人进入威胁区时往外躲的力度" },
      { k: "seekForce", name: "寻敌力", min: 0, max: 600, step: 10, dec: 0,
        desc: "朝目标点压上去的力度。它与命令力**相加**，所以越大冲得越猛" },
      { k: "r4", name: "威胁区半径", min: 0, max: 400, step: 5, dec: 0,
        desc: "敌人进这个圈就被往外推" },
      { k: "r5", name: "感知半径", min: 16, max: 800, step: 10, dec: 0,
        desc: "能看到敌人的最远距离，也是小队统一寻敌的取景范围" }
    ]
  },
  {
    title: "命令与战术",
    hint: "决定怎么听指挥、怎么收尾",
    items: [
      { k: "commandForce", name: "命令力", min: 0, max: 600, step: 5, dec: 0,
        desc: "朝命令信标走的力度" },
      { k: "arriveR", name: "到达衰减半径", min: 8, max: 300, step: 2, dec: 0,
        desc: "离信标这个距离内命令力线性减弱，用来「收油停车」" },
      { k: "smallPushShare", name: "小个体推力占比", min: 0, max: 100, step: 5, dec: 0,
        desc: "大个体受到小个体分离力的百分比。0=大船完全不理会小船，100=完全双向" }
    ]
  }
];

/** 全部可编辑参数（顺序即面板顺序） */
export const FORMATION_PARAM_KEYS = FORMATION_PARAM_GROUPS.flatMap(g => g.items.map(i => i.k));

/** 参数元数据速查：key → { k, name, min, max, step, dec, desc } */
export const FORMATION_PARAM_META = {};
for (const g of FORMATION_PARAM_GROUPS) for (const it of g.items) FORMATION_PARAM_META[it.k] = it;

/**
 * 把一个参数夹进合法区间并按元数据取整。
 * 未知键原样返回 0 —— 编辑界面的输入永远不该把 NaN 写进 sq.p。
 */
export function clampFormationParam(key, value) {
  const meta = FORMATION_PARAM_META[key];
  const v = Number(value);
  if (!meta) return Number.isFinite(v) ? v : 0;
  if (!Number.isFinite(v)) return meta.min;
  const clamped = Math.min(meta.max, Math.max(meta.min, v));
  return Number(clamped.toFixed(meta.dec));
}

/** 只保留 FORMATION_KEYS，并逐个夹进区间 */
export function sanitizeFormationParams(p) {
  const out = {};
  for (const k of FORMATION_KEYS) {
    if (p && p[k] !== undefined) out[k] = clampFormationParam(k, p[k]);
  }
  return out;
}

/** 深拷贝一张阵型库（每个 GameCore 一份，和编制模板库同一套做法） */
export function cloneFormations(src = FORMATIONS) {
  const out = {};
  for (const id of Object.keys(src)) {
    const f = src[id];
    out[id] = {
      id,
      name: f.name,
      desc: f.desc || "",
      from: f.from || null,
      // 内置库里的阵型默认都是"内置"（只有自建的才会显式写 false）
      builtin: f.builtin !== false,
      p: { ...f.p }
    };
  }
  return out;
}

/**
 * 造一个新阵型（自建）。
 * @param {object} o { id, name, from, p, builtin }
 */
export function makeFormation(o = {}) {
  const base = { ...(FORMATIONS[o.from]?.p || FORMATIONS["form.default"].p) };
  return {
    id: o.id,
    name: o.name || "新阵型",
    desc: o.desc || "",
    from: o.from || null,
    builtin: !!o.builtin,
    p: { ...base, ...sanitizeFormationParams(o.p || {}) }
  };
}

export function getFormation(id, lib = FORMATIONS) {
  return lib[id] || null;
}

/**
 * 把阵型写进一个已经编好的 sq.p。
 * 只覆盖那 13 个键：血量、武器、人数都不动。
 */
export function applyFormation(p, formId, lib = FORMATIONS) {
  const f = lib[formId];
  if (!f) return false;
  for (const k of FORMATION_KEYS) p[k] = f.p[k];
  return true;
}
