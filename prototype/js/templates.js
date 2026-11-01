/**
 * 小队模板表
 * ---------------------------------------------------------------
 * 每个模板 = 一套 Couzin 参数 + 武器 + 防御配置。
 * 只写要覆盖的项，其余用 P_DEFS 的默认值兜底。
 *
 * info 是页面上展示的三栏介绍，全部手写：
 *   weapon    武器
 *   defense   防御配置
 *   formation 阵型特性（社交力）
 * 每栏建议控制在 18 个汉字以内，超了会被列宽裁掉。
 */

export const TEMPLATES = [
  {
    key: "swarm", name: "蜂群战斗群",
    weapon: "laser",
    hue: [190, 325],                // [蓝方, 红方] 蓝=冷色系 红=暖色系，同模板相距 135°
    info: {
      weapon: "激光",
      defense: "80血,3每秒回血,0护盾充能器",
      formation: "20人口,密集整齐的阵型"
    },
    p: {
      // 密集、凝聚强、个体脆
      rRep: 17, rOri: 46, rAtt: 86,
      wSep: 1.50, wAli: 0.95, wCoh: 1.15,
      r4: 80, r5: 300, wSeek: 1.50, wThreat: 1.50,
      members: 25, hp: 80, regen: 3.0, chargers: 0
    }
  },
  {
    key: "anvil", name: "圣盾战斗群",
    weapon: "railgun",
    hue: [208, 343],
    info: {
      weapon: "轨道炮",
      defense: "170血,1.5每秒回血,10护盾充能器",
      formation: "12人口,密集抱团阵型"
    },
    p: {
      // 厚重、抱团、正面硬顶
      rRep: 30, rOri: 58, rAtt: 200,
      wSep: 1.40, wAli: 0.70, wCoh: 0.7,
      r4: 60, r5: 280, wSeek: 1.60, wThreat: 1.70,
      members: 12, hp: 290, regen: 7, chargers: 12
    }
  },
  {
    key: "skirmisher", name: "游击鱼雷战术群",
    weapon: "torpedo",
    hue: [226, 1],
    info: {
      weapon: "鱼雷",
      defense: "90血,1每秒回血,0护盾充能器",
      formation: "12人口,分散作战,擅长风筝"
    },
    p: {
      // 松散、远攻、不爱贴脸
      rRep: 34, rOri: 64, rAtt: 120,
      wSep: 1.00, wAli: 0.50, wCoh: 0.45,
      r4: 200, r5: 350, wSeek: 0.85, wThreat: 1.20,
      members: 12, hp: 90, regen: 2.0, chargers: 0
    }
  },
  {
    key: "cavalry", name: "突击鱼雷战斗群",
    weapon: "torpedo",
    hue: [244, 19],
    info: {
      weapon: "鱼雷",
      defense: "100血,2每秒回血,1护盾充能器",
      formation: "13人口,紧凑冲锋,贴身缠斗"
    },
    p: {
      // 激进、贴脸、追得狠
      rRep: 22, rOri: 50, rAtt: 92,
      wSep: 1.30, wAli: 1.00, wCoh: 0.80,
      r4: 50, r5: 320, wSeek: 2.00, wThreat: 1.30,
      members: 15, hp: 40, regen: 2.0, chargers: 4
    }
  },
  {
    key: "bastion", name: "要塞战术群", desc: "缓慢硬墙",
    weapon: "chaingun",
    hue: [262, 37],
    info: {
      weapon: "突击链炮",
      defense: "300血,6每秒回血,5护盾充能器",
      formation: "10人口,等距阵列,缓慢推进"
    },
    p: {
      // 极厚极慢：高凝聚 + 高威胁，贴近就被推开，很难被切开
      rRep: 35, rOri: 60, rAtt: 104,
      wSep: 1.05, wAli: 0.50, wCoh: 1.45,
      r4: 55, r5: 270, wSeek: 1.00, wThreat: 2.00,
      members: 15, hp: 320, regen: 9, chargers: 5
    }
  },
  {
    key: "falcon", name: "游隼导弹战斗群",
    weapon: "missile",
    hue: [280, 55],                 // 蓝=紫，红=黄橙；与同阵营其他模板相距 18°
    info: {
      weapon: "导弹",
      defense: "70血,1.5每秒回血,0护盾充能器",
      formation: "12人口,松散游猎,远程压制"
    },
    p: {
      // 远程、松散、脆：靠射程和追踪吃饭，被贴脸就崩
      rRep: 26, rOri: 56, rAtt: 110,
      wSep: 1.05, wAli: 0.55, wCoh: 0.50,
      r4: 180, r5: 340, wSeek: 0.75, wThreat: 1.30,
      members: 12, hp: 70, regen: 1.5, chargers: 0
    }
  }
];

/** 取某模板在某阵营下的色相 */
export function templateHue(tpl, faction) {
  return tpl.hue ? tpl.hue[faction & 1] : 200;
}

/** 把模板展开成一个 makeSquad 能吃的 def */
export function templateDef(tpl, faction) {
  return {
    key: tpl.key,
    name: tpl.name,
    hue: templateHue(tpl, faction),
    sat: 82,
    flatLum: 54,        // 亮度钉死，和顶部色块 swatchColor 完全一致
    weapon: tpl.weapon,
    p: tpl.p
  };
}

/** 顶部色块 / 槽位标签统一用这个颜色，必须和 templateDef 的 flatLum 保持同一个值 */
export function swatchColor(hue, sat) {
  return "hsl(" + hue + "," + (sat === undefined ? 82 : sat) + "%,54%)";
}

export const FACTION_NAME = ["蓝方", "红方"];

/** 基地血量 */
export const BASE_HP = 3000;

/**
 * 基地产出的"无编队"小队模板
 * 血量低、单体很脆，靠数量骚扰；物理上带一个指向敌方基地的命令力
 */
export const LOOSE_SQUAD = {
  key: "loose", name: "散兵", desc: "炮灰",
  weapon: "laser",
  hue: [205, 5],          // 直接用阵营色（蓝/红），再压暗降饱和
  p: {
    rRep: 18, rOri: 46, rAtt: 92,
    wSep: 1.40, wAli: 0.85, wCoh: 0.95,
    r4: 110, r5: 320, wSeek: 1.10, wThreat: 1.55,
    members: 0, hp: 50, regen: 2.0, chargers: 2
  }
};
