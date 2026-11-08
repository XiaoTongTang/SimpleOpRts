/**
 * 阵型模板（FormationTemplate）
 * -----------------------------------------------------------------
 * 设计见 design/261107_2机制改进/阵型构筑数据结构.md。
 *
 * 一个阵型模板 = 一整套 Couzin 参数（12 个），切换时整块覆盖 sq.p：
 *
 *   社交力：分离 wSep · 对齐 wAli · 凝聚 wCoh
 *   命令力：omega × wCmd
 *   战斗力：威胁 wThreat · 寻敌 wSeek
 *   半径：  rRep 排斥 · rOri 对齐 · rAtt 凝聚上限 · r4 威胁区 · r5 感知
 *
 * 三条硬约定：
 *   1. 不做几何阵型（没有 offsets / geometry / rotate），形状是涌现的
 *   2. 切换瞬间生效，不插值、不重建实体
 *   3. 阵型不许改战斗力：p 里只有那 12 个键，不能出现 hp / shield / fireRate
 *
 * 数值全部照抄 sim/templates.js 里那四个战斗群，不做校验、不做缩放。
 */

export const FORMATIONS = {
  "form.standard": {
    id: "form.standard",
    name: "标准间距集群阵型",
    desc: "蜂群战斗群的站位 · 密集整齐",
    from: "swarm",
    p: {
      wSep: 1.50, wAli: 0.95, wCoh: 1.15,
      omega: 1.10, wCmd: 1.20,
      rRep: 17, rOri: 46, rAtt: 86,
      wThreat: 1.50, wSeek: 1.50,
      r4: 80, r5: 300
    }
  },

  "form.guerrilla": {
    id: "form.guerrilla",
    name: "游击阵型",
    desc: "游击鱼雷战术群 · 松散、远攻、不贴脸",
    from: "skirmisher",
    p: {
      wSep: 1.00, wAli: 0.50, wCoh: 0.45,
      omega: 1.10, wCmd: 1.20,
      rRep: 34, rOri: 64, rAtt: 120,
      wThreat: 1.20, wSeek: 0.85,
      r4: 200, r5: 350
    }
  },

  "form.dense": {
    id: "form.dense",
    name: "密集集群阵型",
    desc: "要塞战术群 · 高凝聚高威胁，贴近就被推开",
    from: "bastion",
    p: {
      wSep: 1.05, wAli: 0.50, wCoh: 1.45,
      omega: 1.10, wCmd: 1.20,
      rRep: 35, rOri: 60, rAtt: 104,
      wThreat: 2.00, wSeek: 1.00,
      r4: 55, r5: 270
    }
  },

  "form.wide": {
    id: "form.wide",
    name: "大间距集群阵型",
    desc: "圣盾战斗群 · 凝聚半径全场最大，队形摊开",
    from: "anvil",
    p: {
      wSep: 1.40, wAli: 0.70, wCoh: 0.70,
      omega: 1.10, wCmd: 1.20,
      rRep: 30, rOri: 58, rAtt: 200,
      wThreat: 1.70, wSeek: 1.60,
      r4: 60, r5: 280
    }
  }
};

export const FORMATION_IDS = Object.keys(FORMATIONS);

/** 阵型里允许写进 sq.p 的键（别的一律不许） */
export const FORMATION_KEYS = [
  "wSep", "wAli", "wCoh", "omega", "wCmd",
  "rRep", "rOri", "rAtt", "wThreat", "wSeek", "r4", "r5"
];

export function getFormation(id) {
  return FORMATIONS[id] || null;
}

/**
 * 把阵型写进一个已经编好的 sq.p。
 * 只覆盖那 12 个键：血量、武器、人数都不动。
 */
export function applyFormation(p, formId) {
  const f = getFormation(formId);
  if (!f) return false;
  for (const k of FORMATION_KEYS) p[k] = f.p[k];
  return true;
}
