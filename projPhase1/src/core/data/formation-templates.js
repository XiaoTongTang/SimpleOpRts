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
 * 数值来源：迁移设计 §3.1.2 的机械换算（F = w × SPD，SPD = 96）。
 * ⚠ 阶段 2 的 sepRadius 仍是**圆心距**（= 旧 rRep），阶段 3 才改成表面间隙。
 */

export const FORMATIONS = {
  "form.standard": {
    id: "form.standard",
    name: "标准间距集群阵型",
    desc: "蜂群战斗群的站位 · 密集整齐",
    from: "swarm",
    p: {
      sepForce: 144, alignForce: 91, cohForce: 110,
      threatForce: 144, seekForce: 144, commandForce: 127,
      sepRadius: 5, alignRadius: 46, cohRadius: 86,
      arriveR: 46, smallPushShare: 30,
      r4: 80, r5: 300
    }
  },

  "form.guerrilla": {
    id: "form.guerrilla",
    name: "游击阵型",
    desc: "游击鱼雷战术群 · 松散、远攻、不贴脸",
    from: "skirmisher",
    p: {
      sepForce: 96, alignForce: 48, cohForce: 43,
      threatForce: 115, seekForce: 82, commandForce: 127,
      sepRadius: 22, alignRadius: 64, cohRadius: 120,
      arriveR: 46, smallPushShare: 30,
      r4: 200, r5: 350
    }
  },

  "form.dense": {
    id: "form.dense",
    name: "密集集群阵型",
    desc: "要塞战术群 · 高凝聚高威胁，贴近就被推开",
    from: "bastion",
    p: {
      sepForce: 101, alignForce: 48, cohForce: 139,
      threatForce: 192, seekForce: 96, commandForce: 127,
      sepRadius: 23, alignRadius: 60, cohRadius: 104,
      arriveR: 46, smallPushShare: 30,
      r4: 55, r5: 270
    }
  },

  "form.wide": {
    id: "form.wide",
    name: "大间距集群阵型",
    desc: "圣盾战斗群 · 凝聚半径全场最大，队形摊开",
    from: "anvil",
    p: {
      sepForce: 134, alignForce: 67, cohForce: 67,
      threatForce: 163, seekForce: 154, commandForce: 127,
      sepRadius: 18, alignRadius: 58, cohRadius: 200,
      arriveR: 46, smallPushShare: 30,
      r4: 60, r5: 280
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

export function getFormation(id) {
  return FORMATIONS[id] || null;
}

/**
 * 把阵型写进一个已经编好的 sq.p。
 * 只覆盖那 13 个键：血量、武器、人数都不动。
 */
export function applyFormation(p, formId) {
  const f = getFormation(formId);
  if (!f) return false;
  for (const k of FORMATION_KEYS) p[k] = f.p[k];
  return true;
}
