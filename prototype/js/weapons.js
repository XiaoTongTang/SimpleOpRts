/**
 * 武器参数表
 * -----------------------------------------------------------------
 * 这里只有数据，没有判定逻辑。加一把枪 = 在这里加一个对象。
 *
 * 字段分五组，互相正交：
 *   delivery  投递方式  "hitscan" | "projectile"
 *   travel    飞行参数  hitscan 只要 range；projectile 要 speed + lifetime（+ 可选 turnRate）
 *   hit       命中几何  contactR（打多大） + maxHits（能打几个）
 *   impact    命中效果  dmg / blastR / blastDmg / pierceShield
 *   fire      开火节奏  cd / burst / burstDelay / fan / energy
 *   trail     拖尾样式  "smoke"（烟团，鱼雷）| "line"（弯曲线，导弹）| "streak"（细亮线，链炮）
 *
 * 设计见 design/261101_1武器系统改造/03-武器参数表.md
 *
 * 两条硬规矩：
 *   1. 表里不出现随机数（`fan` 是确定性扇形，不是散布）
 *   2. `hit` 与 `impact` 是两件事：`contactR` 决定打不打中，`blastR` 决定打中之后波及多大
 */

export const WEAPONS = {
  railgun: {
    id: "railgun",
    name: "轨道炮",
    delivery: "hitscan",
    travel: { range: 250 },
    hit:    { contactR: 14, maxHits: 3 },        // 最多打穿 3 个单位
    impact: { dmg: 20, blastR: 0, blastDmg: 0, pierceShield: true },
    fire:   { cd: 2.6, burst: 1, fan: 0, energy: 0 },
    fx:     "rayshot",
  },

  laser: {
    id: "laser",
    name: "激光",
    delivery: "hitscan",
    travel: { range: 300 },
    hit:    { contactR: 2, maxHits: 1 },         // 点杀，只打锁定的那个
    impact: { dmg: 24, blastR: 0, blastDmg: 0, pierceShield: false },
    fire:   { cd: 2.0, burst: 1, fan: 0, energy: 0 },
    fx:     "beam",
  },

  torpedo: {
    id: "torpedo",
    name: "鱼雷",
    delivery: "projectile",
    // 射程 = speed × lifetime = 210 × 1.81 ≈ 380
    travel: { speed: 210, lifetime: 1.81, turnRate: 0 },   // 不追踪，直飞
    hit:    { contactR: 5, maxHits: 1 },         // 碰到第一个就起爆
    impact: { dmg: 18, blastR: 55, blastDmg: 18, pierceShield: false },
    fire:   { cd: 6.0, burst: 1, fan: 0, energy: 0 },
    fx:     "muzzle",
    trail:  "smoke",                             // 烟团拖尾
  },

  missile: {
    id: "missile",
    name: "导弹",
    delivery: "projectile",
    // 射程 = 240 × 2 = 480
    // turnRate 决定最小转弯半径 = speed / turnRate = 96px
    // guideR = 制导范围：只朝这个圆内「敌人最密集的方向」转，不锁定具体目标
    travel: { speed: 240, lifetime: 2, turnRate: 2.5, guideR: 180 },
    hit:    { contactR: 4, maxHits: 1 },
    impact: { dmg: 40, blastR: 24, blastDmg: 24, pierceShield: false },
    fire:   { cd: 2.6, burst: 1, fan: 0, energy: 0 },
    fx:     "muzzle",
    trail:  "line",                              // 弯曲线状拖尾
  },

  chaingun: {
    id: "chaingun",
    name: "突击链炮",
    delivery: "projectile",
    // 射程 = 800 × 0.5 = 400
    travel: { speed: 600, lifetime: 0.5 },
    hit:    { contactR: 4, maxHits: 1 },
    impact: { dmg: 20, blastR: 0, blastDmg: 0, pierceShield: false },
    // 一轮 4 发，一发一发地打，间隔 0.12s（整轮 0.36s）
    // 4 发按 3° 扇形铺开：-1.5° / -0.5° / +0.5° / +1.5°
    // cd 从最后一发起算
    fire:   { cd: 2.0, burst: 4, burstDelay: 0.12, fan: 3, energy: 0 },
    fx:     "muzzle",
    trail:  "streak",                            // 线形射弹（细亮线），命中有泛白闪光
  },
};

export const WEAPON_IDS = Object.keys(WEAPONS);

/**
 * 射程。hitscan 直接给；projectile 由 speed × lifetime 推出。
 * 注意：对追踪弹，这个值是「直线飞能飞多远」的上界，实际路径更长。
 */
export function weaponRange(w) {
  return w.delivery === "hitscan"
    ? w.travel.range
    : w.travel.speed * w.travel.lifetime;
}
