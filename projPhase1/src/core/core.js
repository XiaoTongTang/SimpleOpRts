/**
 * GameCore —— 唯一真相源
 * -----------------------------------------------------------------
 * 三条纪律（对应 design/261107_2机制改进/状态管理与分层边界.md）：
 *   1. 本文件不 import React、不 import Pixi、不碰 document / window / canvas
 *   2. 写入只有一个入口：command()。渲染与 UI 都只能读
 *   3. 每帧推进是纯 JS，可以在 Node 里裸跑（见 test/core.smoke.mjs）
 *
 * 对外只有四个方法：
 *   step(dt)      推进一个固定步长
 *   stepFx(dt)    推进特效寿命（表现层用，但由 core 持有列表）
 *   getView()     给渲染层的只读投影
 *   snapshot()    给 UI 的节流快照（只含 UI 真正要显示的数字）
 *   command(cmd)  唯一的写入入口，返回 { ok, reasons }
 */

import {
  makeSquads, resizeSquad, computeCenters, computeSquadTargets, countMembers
} from "./sim/squad-layer.js";
import { stepUnits } from "./sim/group-layer.js";
import { Grid } from "./sim/spatial.js";
import { stepWeapons } from "./sim/weapon-system.js";
import { applyDamage, stepRegen, stepChargers, applyCombatParams } from "./sim/defense-system.js";
import {
  HULLS, MAX_PER_SQUAD, MODULES_PER_SHIP,
  createBuild, entryCost, commandsUsed
} from "./state.js";

const SPAWN_SPREAD = 55;

export class GameCore {
  constructor(opts = {}) {
    this.reset(opts);
  }

  // ------------------------------------------------------------------
  // 生命周期
  // ------------------------------------------------------------------

  reset(opts = {}) {
    const width = opts.width ?? this.width ?? 1280;
    const height = opts.height ?? this.height ?? 720;

    this.width = width;
    this.height = height;

    /** 全局参数（原型的 S 里与移动/战斗有关的那部分） */
    this.G = {
      drag: 0.30, stallSpeed: 60, stallAccel: 100, arriveR: 46,
      shieldHp: 80, chargerRange: 140, chargerCd: 2.5,
      energyMax: 100, energyCost: 25, energyRegen: 8
    };

    this.squads = makeSquads();
    this.units = [];
    this.projectiles = [];
    this.fx = [];
    this.hits = [];
    this.grid = new Grid(Math.max(1, width), Math.max(1, height));

    /** 构筑状态：权威 */
    this.build = createBuild();

    this.time = 0;
    this.paused = false;
    this.winner = -1;

    this.spawnAll();
    return this;
  }

  setViewport(width, height) {
    this.width = Math.max(1, width | 0);
    this.height = Math.max(1, height | 0);
    this.grid = new Grid(this.width, this.height);
  }

  /** 按构筑状态生成全部单位 */
  spawnAll() {
    this.units.length = 0;
    const cols = [this.width * 0.26, this.width * 0.74];

    for (const b of this.build.squads) {
      const sq = this.squads[b.id];
      sq.p.members = b.count;
      sq.p.hp = (HULLS[b.hull] || HULLS.frigate).hp;
      sq.p.weapon = b.weapon;

      const row = b.id % 4;
      const bx = cols[b.faction] ?? this.width * 0.5;
      const by = this.height * (0.14 + row * 0.235);

      for (let k = 0; k < b.count; k++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * SPAWN_SPREAD;
        this.units.push({
          x: bx + Math.cos(a) * r,
          y: by + Math.sin(a) * r,
          vx: 0, vy: 0,
          squad: b.id,
          alpha: 0, cAll: 0
        });
      }
    }

    computeCenters(this.units, this.squads);
    for (const b of this.build.squads) applyCombatParams(this.units, this.squads, b.id);
  }

  // ------------------------------------------------------------------
  // 推进
  // ------------------------------------------------------------------

  step(dt) {
    if (this.paused) return;
    const W = this.width, H = this.height;

    // 1. 集群移动
    computeCenters(this.units, this.squads);
    computeSquadTargets(this.units, this.squads);
    stepUnits(this.units, this.squads, this.G, dt, W, H);

    for (const u of this.units) {
      if (u.y < 8) { u.y = 8; if (u.vy < 0) u.vy = -u.vy * 0.3; }
      if (u.y > H - 8) { u.y = H - 8; if (u.vy > 0) u.vy = -u.vy * 0.3; }
      if (u.x < 8) { u.x = 8; if (u.vx < 0) u.vx = -u.vx * 0.3; }
      if (u.x > W - 8) { u.x = W - 8; if (u.vx > 0) u.vx = -u.vx * 0.3; }
    }

    // 2. 防御系统
    stepRegen(this.units, dt);
    stepChargers(this.units, this.squads, this.G, dt, this.fx);

    // 3. 武器系统（位置已定，重建一次空间索引，整帧有效）
    this.grid.clear();
    for (let i = 0; i < this.units.length; i++) this.grid.insert(i, this.units[i]);

    this.hits.length = 0;
    stepWeapons(this.units, this.squads, this.projectiles, dt, this.hits, this.time, this.fx, this.grid);

    // 4. 结算伤害 + 清尸体
    if (this.hits.length) {
      let anyDead = false;
      for (const h of this.hits) {
        if (applyDamage(h.t, h.dmg, h.pierce)) anyDead = true;
      }
      if (anyDead) {
        let w = 0;
        for (let i = 0; i < this.units.length; i++) {
          if (this.units[i].hp > 0) this.units[w++] = this.units[i];
        }
        this.units.length = w;
      }
    }

    this.time += dt;
  }

  stepFx(dt) {
    const fx = this.fx;
    let w = 0;
    for (let i = 0; i < fx.length; i++) {
      const f = fx[i];
      f.life -= dt;
      if (f.life > 0) fx[w++] = f;
    }
    fx.length = w;
  }

  // ------------------------------------------------------------------
  // 只读投影
  // ------------------------------------------------------------------

  getView() {
    return {
      width: this.width,
      height: this.height,
      camera: { ox: 0, oy: 0, zoom: 1 },
      world: { w: this.width, h: this.height },
      bases: [],       // 阶段一未接基地/防御塔
      towers: [],
      units: this.units,
      squads: this.squads,
      fx: this.fx,
      projectiles: this.projectiles
    };
  }

  /**
   * UI 快照：只含 UI 要显示的数字。
   * 注意这里没有 units —— 每帧的单位数组永远不进 React。
   */
  snapshot() {
    const squads = this.build.squads.map(b => {
      const sq = this.squads[b.id];
      return {
        id: b.id, key: b.key, faction: b.faction, loose: b.loose,
        hull: b.hull, count: b.count, weapon: b.weapon,
        alive: countMembers(this.units, b.id),
        cost: entryCost(b.hull, b.count),
        hue: sq ? sq.hue : 200
      };
    });

    return {
      t: this.time,
      paused: this.paused,
      winner: this.winner,
      unitCount: this.units.length,
      modules: this.build.modules,
      commandCap: this.build.commandCap,
      commandUsed: commandsUsed(this.build),
      squads
    };
  }

  // ------------------------------------------------------------------
  // 唯一写入入口
  // ------------------------------------------------------------------

  /**
   * @param {{type:string}} cmd
   * @returns {{ok:boolean, reasons?:string[], code?:string}}
   */
  command(cmd) {
    if (!cmd || !cmd.type) return reject(["命令为空"]);

    switch (cmd.type) {
      case "setPaused":
        this.paused = !!cmd.value;
        return { ok: true };

      case "reset":
        this.reset({ width: this.width, height: this.height });
        return { ok: true };

      // 第一档：只改参数，直接写，下一帧生效
      case "setParam": {
        const sq = this.squads[cmd.squadId];
        if (!sq) return reject(["没有这支小队"]);
        if (!(cmd.key in sq.p)) return reject([`未知参数 ${cmd.key}`]);
        const v = Number(cmd.value);
        if (!Number.isFinite(v)) return reject(["参数必须是数字"]);
        sq.p[cmd.key] = v;
        return { ok: true };
      }

      // 第二档：改实体，事务式，可能被资源规则拒绝
      case "setLoadout":
        return this.applyLoadout(cmd);

      default:
        return reject([`未知命令 ${cmd.type}`], "unknown");
    }
  }

  /**
   * 编制/装配变更。
   * 校验 → 差量应用（保留存活单位的位置与战损比）→ 扣模组。
   */
  applyLoadout(cmd) {
    const id = cmd.squadId;
    const sq = this.squads[id];
    const b = this.build.squads[id];
    if (!sq || !b) return reject(["没有这支小队"]);

    const nextHull = cmd.hull ?? b.hull;
    const nextCount = cmd.count ?? b.count;
    const nextWeapon = cmd.weapon ?? b.weapon;
    const reasons = [];

    if (!HULLS[nextHull]) reasons.push(`未知船体 ${nextHull}`);
    if (!Number.isInteger(nextCount) || nextCount < 0) reasons.push("编制必须是 0 以上的整数");
    if (nextCount > MAX_PER_SQUAD) reasons.push(`单队编制上限 ${MAX_PER_SQUAD} 艘`);

    const deltaCost = entryCost(nextHull, nextCount) - entryCost(b.hull, b.count);
    const usedAfter = commandsUsed(this.build) + deltaCost;
    if (usedAfter > this.build.commandCap) {
      reasons.push(
        `超出指挥值：需 ${usedAfter}，上限 ${this.build.commandCap}（超 ${usedAfter - this.build.commandCap}）`
      );
    }

    const grow = Math.max(0, nextCount - b.count);
    if (grow > 0 && grow > this.build.modules) {
      reasons.push(`预制模组不足：需 ${grow}，剩 ${this.build.modules}`);
    }

    if (reasons.length) return reject(reasons);

    // ---- 应用（差量，不重建全场） ----
    b.hull = nextHull;
    b.count = nextCount;
    b.weapon = nextWeapon;

    sq.p.members = nextCount;
    sq.p.hp = HULLS[nextHull].hp;
    sq.p.weapon = nextWeapon;

    resizeSquad(this.units, this.squads, id, nextCount, this.width, this.height);
    // 血量为比例缩放，新单位补 initCombat —— 所以改配置不会让整队满血复活
    applyCombatParams(this.units, this.squads, id);

    this.build.modules -= grow;

    return { ok: true };
  }
}

function reject(reasons, code) {
  return { ok: false, reasons, code: code || "rejected" };
}
