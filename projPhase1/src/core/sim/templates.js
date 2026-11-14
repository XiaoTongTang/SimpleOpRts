/**
 * 小队模板表（参数基准记录）
 * ---------------------------------------------------------------
 * ⚠ **本文件当前没有被任何模块 import。**
 *   core 实际使用的是 `data/formation-templates.js`（阵型）与
 *   `sim/squad-layer.js` 的 `P_DEFS`（新建小队的默认值）。
 *   这里保留下来只作为「六种战斗群各自该长什么样」的参数基准，
 *   方便以后做兵种分化时抄数值。**不要在这里改完就以为线上变了。**
 *
 * 每个模板 = 一套 Couzin 参数 + 武器 + 防御配置。
 * 数值来源：迁移设计 §3.1.2 的机械换算（F = w × SPD，SPD = 96）。
 * ⚠ sepRadius 目前是**圆心距**（= 旧 rRep）；阶段 3 改成表面间隙后会减去 2 × r_ref。
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
      sepRadius: 5, alignRadius: 46, cohRadius: 86,
      sepForce: 144, alignForce: 91, cohForce: 110,
      threatForce: 144, seekForce: 144, commandForce: 127,
      arriveR: 46, smallPushShare: 30,
      r4: 80, r5: 300,
      members: 25, hp: 80, regen: 3.0
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
      sepRadius: 18, alignRadius: 58, cohRadius: 200,
      sepForce: 134, alignForce: 67, cohForce: 67,
      threatForce: 163, seekForce: 154, commandForce: 127,
      arriveR: 46, smallPushShare: 30,
      r4: 60, r5: 280,
      members: 12, hp: 290, regen: 7
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
      sepRadius: 22, alignRadius: 64, cohRadius: 120,
      sepForce: 96, alignForce: 48, cohForce: 43,
      threatForce: 115, seekForce: 82, commandForce: 127,
      arriveR: 46, smallPushShare: 30,
      r4: 200, r5: 350,
      members: 12, hp: 90, regen: 2.0
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
      sepRadius: 10, alignRadius: 50, cohRadius: 92,
      sepForce: 125, alignForce: 96, cohForce: 77,
      threatForce: 125, seekForce: 192, commandForce: 127,
      arriveR: 46, smallPushShare: 30,
      r4: 50, r5: 320,
      members: 15, hp: 40, regen: 2.0
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
      sepRadius: 23, alignRadius: 60, cohRadius: 104,
      sepForce: 101, alignForce: 48, cohForce: 139,
      threatForce: 192, seekForce: 96, commandForce: 127,
      arriveR: 46, smallPushShare: 30,
      r4: 55, r5: 270,
      members: 15, hp: 320, regen: 9
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
      sepRadius: 14, alignRadius: 56, cohRadius: 110,
      sepForce: 101, alignForce: 53, cohForce: 48,
      threatForce: 125, seekForce: 72, commandForce: 127,
      arriveR: 46, smallPushShare: 30,
      r4: 180, r5: 340,
      members: 12, hp: 70, regen: 1.5
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
    sepRadius: 6, alignRadius: 46, cohRadius: 92,
    sepForce: 134, alignForce: 82, cohForce: 91,
    threatForce: 149, seekForce: 106, commandForce: 127,
    arriveR: 46, smallPushShare: 30,
    r4: 110, r5: 320,
    members: 0, hp: 50, regen: 2.0
  }
};
