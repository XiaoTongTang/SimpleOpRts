/**
 * 武器参数表
 * -----------------------------------------------------------------
 * 这里只有数据，没有判定逻辑。加一把枪 = 在这里加一个对象。
 *
 * 字段分五组，互相正交：
 *   delivery  投递方式  "hitscan" | "projectile"
 *   travel    飞行参数  hitscan 只要 range；projectile 要 speed + lifetime
 *   hit       命中几何  contactR（打多大） + maxHits（能打几个）
 *   impact    命中效果  dmg / blastR / blastDmg / pierceShield
 *   fire      开火节奏  cd / burst / burstDelay / fan / energy
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
    fire:   { cd: 2.6, burst: 1, burstDelay: 0, fan: 0, energy: 0 },
    fx:     "rayshot",
  },

  laser: {
    id: "laser",
    name: "激光",
    delivery: "hitscan",
    travel: { range: 300 },
    hit:    { contactR: 2, maxHits: 1 },         // 点杀，只打锁定的那个
    impact: { dmg: 24, blastR: 0, blastDmg: 0, pierceShield: false },
    fire:   { cd: 2.0, burst: 1, burstDelay: 0, fan: 0, energy: 0 },
    fx:     "beam",
  },

  torpedo: {
    id: "torpedo",
    name: "鱼雷",
    delivery: "projectile",
    // 射程 = speed × lifetime = 210 × 1.81 ≈ 380
    travel: { speed: 210, lifetime: 1.81 },
    hit:    { contactR: 5, maxHits: 1 },         // 碰到第一个就起爆
    impact: { dmg: 18, blastR: 50, blastDmg: 18, pierceShield: false },
    fire:   { cd: 6.0, burst: 1, burstDelay: 0, fan: 0, energy: 0 },
    fx:     "muzzle",
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
