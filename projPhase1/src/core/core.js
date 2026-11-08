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
import { applyDamage, stepRegen, applyCombatParams } from "./sim/defense-system.js";
import { stepSupport } from "./sim/support-system.js";
import {
  createFacility, enqueue, stepFacility, cancelJob,
  allocatedEff, lineRemaining, queuedCount
} from "./sim/production.js";
import { seedRng, rand } from "./sim/rng.js";
import {
  MAX_PER_SQUAD, MODULES_PER_SHIP,
  createBuild, entryCost, commandsUsed, applyShipToSquadParams
} from "./state.js";
import * as shipLib from "./data/ship-library.js";
import { computeShip, setFit } from "./data/ship-template.js";
import { getHull, HULL_TEMPLATES } from "./data/hull-templates.js";
import { PLUGIN_TEMPLATES } from "./data/plugin-templates.js";
import { WEAPONS } from "./sim/weapons.js";

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

    /** 随机种子：同一个 seed 每次重开都是同一场战斗 */
    this.seed = seedRng(opts.seed ?? this.seed ?? 1);

    /** 全局参数：只剩移动相关。战斗参数全部下沉到小队 p / 船体模板 */
    this.G = {
      drag: 0.30, stallSpeed: 60, stallAccel: 100, arriveR: 46
    };

    this.squads = makeSquads();
    this.units = [];
    this.projectiles = [];
    this.fx = [];
    this.hits = [];
    this.grid = new Grid(Math.max(1, width), Math.max(1, height));

    /** 构筑状态：权威 */
    this.ships = opts.ships && Object.keys(opts.ships).length
      ? opts.ships
      : (this.ships && Object.keys(this.ships).length ? this.ships : shipLib.createLibrary());
    this.shipRev = this.shipRev ?? 0;      // 方案库版本号，存档层据此判断要不要写盘
    this.unlocked = opts.unlocked || this.unlocked || null; // 蓝图解锁表；null = 不校验
    this.build = createBuild();

    /** 生产：阶段一没有母舰实体，直接用方舟级的产能参数虚拟一个 */
    const ms = getHull("hull.ark").mothership;
    this.moduleCap = ms.moduleCap;
    this.moduleRegen = ms.moduleRegen;
    this.production = [
      createFacility(0, { lines: ms.lines, efficiency: ms.efficiency }),
      createFacility(1, { lines: ms.lines, efficiency: ms.efficiency })
    ];
    this.jobSeq = 1;
    if (this.build.modules > this.moduleCap) this.build.modules = this.moduleCap;

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
      // 小船队的所有参数都从舰船模板编译而来（血量/护盾/武器/能力/炮口）
      applyShipToSquadParams(sq, this.ships[b.ship]);

      const row = b.id % 4;
      const bx = cols[b.faction] ?? this.width * 0.5;
      const by = this.height * (0.14 + row * 0.235);

      for (let k = 0; k < b.count; k++) {
        const a = rand() * Math.PI * 2;
        const r = Math.sqrt(rand()) * SPAWN_SPREAD;
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

    // 0. 生产（造好的船这一帧就能动）
    this.stepProduction(dt);

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

    // 2. 自然恢复（血 + 盾，只作用自己）
    stepRegen(this.units, dt);

    // 3. 空间索引（位置已定，重建一次，整帧有效）
    this.grid.clear();
    for (let i = 0; i < this.units.length; i++) this.grid.insert(i, this.units[i]);

    // 4. 支援能力（充盾 / 维修，作用范围内的友军）
    stepSupport(this.units, this.squads, this.grid, dt, this.fx);

    // 5. 武器系统
    this.hits.length = 0;
    stepWeapons(this.units, this.squads, this.projectiles, dt, this.hits, this.time, this.fx, this.grid);

    // 6. 结算伤害 + 清尸体
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

  /**
   * 推进生产：每帧一次。
   * 顺序放在移动之后、武器之前都行，这里放最前面 —— 船是「上一帧就造好了」的，
   * 这样它这一帧立刻能参与移动和开火，不会无故慢一帧。
   */
  stepProduction(dt) {
    // 预制模组自然恢复（生产线忙也照常，见设计文档）
    if (this.moduleRegen > 0 && this.build.modules < this.moduleCap) {
      this.build.modules = Math.min(this.moduleCap, this.build.modules + this.moduleRegen * dt);
    }

    for (const fac of this.production) {
      stepFacility(fac, dt, job => this.completeJob(job));
    }
  }

  /** 一艘船造好了：直接生成一个单位，不改编制设计值（那是指挥值已经付过的） */
  completeJob(job) {
    const sq = this.squads[job.squadId];
    if (!sq) return;
    const alive = countMembers(this.units, job.squadId);
    if (alive >= MAX_PER_SQUAD) return;          // 已经到单队上限，这艘弃掉
    resizeSquad(this.units, this.squads, job.squadId, alive + 1, this.width, this.height);
    applyCombatParams(this.units, this.squads, job.squadId);
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
      const ship = this.ships[b.ship];
      const d = ship?.derived;
      return {
        id: b.id, key: b.key, faction: b.faction, loose: b.loose,
        // 新字段
        ship: b.ship,
        shipName: ship?.name ?? "?",
        capacity: d?.capacity ?? 0,
        capacityUsed: d?.capacityUsed ?? 0,
        command: d?.command ?? 0,
        buildTime: d?.buildTime ?? 0,
        // 兼容旧 UI 的字段（P7 换 React 时删）
        hull: ship?.hull ?? "hull.falcon",
        weapon: d?.weapons?.[0]?.id ?? "laser",
        count: b.count,
        alive: countMembers(this.units, b.id),
        cost: entryCost(ship, b.count),
        hue: sq ? sq.hue : 200
      };
    });

    return {
      t: this.time,
      paused: this.paused,
      winner: this.winner,
      unitCount: this.units.length,
      modules: Math.floor(this.build.modules),
      moduleCap: this.moduleCap,
      commandCap: this.build.commandCap,
      commandUsed: commandsUsed(this.build, this.ships),
      shipRev: this.shipRev,
      squads,
      production: this.production.map(f => ({
        faction: f.faction,
        efficiencyTotal: f.efficiencyTotal,
        allocated: allocatedEff(f),
        queued: queuedCount(f),
        lines: f.lines.map((l, i) => {
          const job = l.queue[0];
          const tpl = job ? this.ships[job.shipId] : null;
          const rem = lineRemaining(l);
          return {
            index: i,
            alloc: l.alloc,
            queued: l.queue.length,
            job: job ? {
              id: job.id,
              squadId: job.squadId,
              shipId: job.shipId,
              name: tpl?.name ?? "?",
              progress: Math.round(job.progress * 100) / 100,
              buildTime: job.buildTime,
              pct: job.buildTime > 0 ? Math.min(1, job.progress / job.buildTime) : 1,
              remaining: Number.isFinite(rem) ? Math.round(rem * 10) / 10 : null
            } : null
          };
        })
      })),
      /** UI 选方案用；只给必要字段，不含 derived 明细 */
      shipList: shipLib.listShips(this.ships).map(s => {
        const hull = getHull(s.hull);
        return {
          id: s.id,
          name: s.name,
          hull: s.hull,
          hullName: hull?.name ?? "?",
          command: s.derived?.command ?? 0,
          capacity: s.derived?.capacity ?? 0,
          capacityUsed: s.derived?.capacityUsed ?? 0,
          buildTime: s.derived?.buildTime ?? 0,
          ok: !!s.derived?.ok,
          reasons: s.derived?.reasons ?? [],
          fit: { ...s.fit },
          slots: hull
            ? [
                ...hull.slots.weapon.map(w => ({ id: w.id, kind: "weapon", size: w.size })),
                ...hull.slots.plugin.map(p => ({ id: p.id, kind: "plugin", size: null }))
              ]
            : []
        };
      })
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

      // 方案库（玩家的舰船模板）
      case "createShip": return this.cmdCreateShip(cmd);
      case "renameShip": return this.cmdRenameShip(cmd);
      case "duplicateShip": return this.cmdDuplicateShip(cmd);
      case "deleteShip": return this.cmdDeleteShip(cmd);
      case "setShipFit": return this.cmdSetShipFit(cmd);

      // 生产
      case "setLineEfficiency": return this.cmdSetLineEfficiency(cmd);
      case "queueShip": return this.cmdQueueShip(cmd);
      case "buildSquad": return this.cmdBuildSquad(cmd);
      case "cancelOrder": return this.cmdCancelOrder(cmd);
      case "instantRefill": return this.cmdInstantRefill(cmd);

      default:
        return reject([`未知命令 ${cmd.type}`], "unknown");
    }
  }

  /**
   * 编队变更：换舰船方案 / 改编制。
   * 校验 → 差量应用（保留存活单位的位置与战损比）→ 扣模组。
   */
  applyLoadout(cmd) {
    const id = cmd.squadId;
    const sq = this.squads[id];
    const b = this.build.squads[id];
    if (!sq || !b) return reject(["没有这支小队"]);

    const nextShipId = cmd.ship ?? b.ship;
    const nextCount = cmd.count ?? b.count;
    const nextShip = this.ships[nextShipId];
    const reasons = [];

    // 舰船方案本身得合法（承载量、槽位尺寸、蓝图……全在 computeShip 里）
    if (!nextShip) {
      reasons.push(`未知舰船方案 ${nextShipId}`);
    } else {
      const chk = computeShip(nextShip, { unlocked: this.unlocked });
      if (!chk.ok) reasons.push(...chk.reasons.map(r => `${nextShip.name}：${r}`));
    }

    if (!Number.isInteger(nextCount) || nextCount < 0) reasons.push("编制必须是 0 以上的整数");
    if (nextCount > MAX_PER_SQUAD) reasons.push(`单队编制上限 ${MAX_PER_SQUAD} 艘`);

    if (nextShip) {
      const deltaCost = entryCost(nextShip, nextCount) - entryCost(this.ships[b.ship], b.count);
      const usedAfter = commandsUsed(this.build, this.ships) + deltaCost;
      if (usedAfter > this.build.commandCap) {
        reasons.push(
          `超出指挥值：需 ${usedAfter}，上限 ${this.build.commandCap}（超 ${usedAfter - this.build.commandCap}）`
        );
      }
    }

    const grow = Math.max(0, nextCount - b.count);
    if (grow > 0 && grow * MODULES_PER_SHIP > this.build.modules) {
      reasons.push(`预制模组不足：需 ${grow * MODULES_PER_SHIP}，剩 ${this.build.modules}`);
    }

    if (reasons.length) return reject(reasons);

    // ---- 应用（差量，不重建全场） ----
    b.ship = nextShipId;
    b.count = nextCount;

    sq.p.members = nextCount;
    applyShipToSquadParams(sq, nextShip);

    resizeSquad(this.units, this.squads, id, nextCount, this.width, this.height);
    // 血量为比例缩放，新单位补 initCombat —— 所以改配置不会让整队满血复活
    applyCombatParams(this.units, this.squads, id);

    this.build.modules -= grow * MODULES_PER_SHIP;

    return { ok: true };
  }

  // ------------------------------------------------------------------
  // 方案库（玩家的舰船模板集合）
  // ------------------------------------------------------------------

  get shipCount() {
    return Object.keys(this.ships).length;
  }

  cmdCreateShip(cmd) {
    if (this.shipCount >= shipLib.MAX_SHIPS) {
      return reject([`方案上限 ${shipLib.MAX_SHIPS} 个，请先删除一个`]);
    }
    if (!getHull(cmd.hull)) return reject([`未知船体 ${cmd.hull}`]);
    const id = cmd.id || shipLib.nextShipId(this.ships);
    if (this.ships[id]) return reject([`方案 id 已存在：${id}`]);

    let tpl;
    try {
      tpl = shipLib.addShip(this.ships, {
        id, name: cmd.name, hull: cmd.hull, fit: cmd.fit || {}, now: this.time
      });
    } catch (e) {
      return reject([String(e?.message || e)]);
    }
    if (!tpl.derived.ok) {
      delete this.ships[id];          // 建不出来就别留半成品
      return reject(tpl.derived.reasons);
    }
    this.shipRev++;
    return { ok: true, id };
  }

  cmdRenameShip(cmd) {
    const s = this.ships[cmd.shipId];
    if (!s) return reject([`没有这艘舰船 ${cmd.shipId}`]);
    const name = String(cmd.name ?? "").trim();
    if (!name) return reject(["方案名不能为空"]);
    if (name.length > 24) return reject(["方案名最多 24 个字"]);
    shipLib.renameShip(this.ships, s.id, name, this.time);
    this.shipRev++;
    return { ok: true };
  }

  cmdDuplicateShip(cmd) {
    if (this.shipCount >= shipLib.MAX_SHIPS) {
      return reject([`方案上限 ${shipLib.MAX_SHIPS} 个，请先删除一个`]);
    }
    if (!this.ships[cmd.shipId]) return reject([`没有这艘舰船 ${cmd.shipId}`]);
    const id = shipLib.nextShipId(this.ships);
    shipLib.duplicateShip(this.ships, cmd.shipId, id, cmd.name, this.time);
    this.shipRev++;
    return { ok: true, id };
  }

  cmdDeleteShip(cmd) {
    const id = cmd.shipId;
    if (!this.ships[id]) return reject([`没有这艘舰船 ${id}`]);
    const used = this.build.squads.filter(s => s.ship === id);
    if (used.length) {
      return reject([`还有 ${used.length} 支小队在用这个方案，先换掉再删`]);
    }
    shipLib.removeShip(this.ships, id);
    this.shipRev++;
    return { ok: true };
  }

  cmdSetShipFit(cmd) {
    const s = this.ships[cmd.shipId];
    if (!s) return reject([`没有这艘舰船 ${cmd.shipId}`]);
    // 装配改了但校验不过 —— 事务式拒绝，库里保持原样
    const r = shipLib.setShipFit(this.ships, cmd.shipId, cmd.slotId, cmd.itemId ?? null, this.time);
    if (!r.ok) return reject(r.reasons);

    // 这条方案如果正被小队使用，立刻把新装配同步进战场（不重建全场）
    this.syncShipUsage(cmd.shipId);
    this.shipRev++;
    return { ok: true };
  }

  /** 把某方案的编译结果刷进所有在用的小队 */
  syncShipUsage(shipId) {
    const tpl = this.ships[shipId];
    if (!tpl) return;
    for (const b of this.build.squads) {
      if (b.ship !== shipId) continue;
      applyShipToSquadParams(this.squads[b.id], tpl);
      applyCombatParams(this.units, this.squads, b.id);
    }
  }

  // ------------------------------------------------------------------
  // 生产命令
  // ------------------------------------------------------------------

  /** 某小队所属阵营的生产设施 */
  facilityOf(squadId) {
    const b = this.build.squads[squadId];
    if (!b) return null;
    return this.production.find(f => f.faction === b.faction) || null;
  }

  /** 某小队已经排了多少艘还没造出来 */
  queuedForSquad(squadId) {
    let n = 0;
    for (const fac of this.production) {
      for (const line of fac.lines) {
        for (const job of line.queue) if (job.squadId === squadId) n++;
      }
    }
    return n;
  }

  cmdSetLineEfficiency(cmd) {
    const fac = this.production[cmd.faction];
    if (!fac) return reject([`没有阵营 ${cmd.faction} 的生产设施`]);
    const line = fac.lines[cmd.line];
    if (!line) return reject([`没有第 ${cmd.line} 条生产线`]);

    const v = Math.round(Number(cmd.value) * 10) / 10;
    if (!Number.isFinite(v) || v < 0) return reject(["效率必须是不小于 0 的数字"]);

    const others = Math.round((allocatedEff(fac) - line.alloc) * 10) / 10;
    if (others + v > fac.efficiencyTotal + 1e-9) {
      return reject([
        `超出生产效率总和：已分 ${others}，想给 ${v}，总共只有 ${fac.efficiencyTotal}`
      ]);
    }
    line.alloc = v;
    return { ok: true };
  }

  /** 排一艘船进队列（不改编制，只补实际数量） */
  cmdQueueShip(cmd) {
    const b = this.build.squads[cmd.squadId];
    if (!b) return reject(["没有这支小队"]);
    const count = cmd.count ?? 1;
    if (!Number.isInteger(count) || count < 1) return reject(["数量必须是 ≥1 的整数"]);

    const tpl = this.ships[b.ship];
    if (!tpl || !tpl.derived.ok) return reject([`方案 ${b.ship} 当前不可建造`]);

    const fac = this.facilityOf(cmd.squadId);
    if (!fac) return reject(["这支小队没有可用的生产设施"]);

    const alive = countMembers(this.units, b.id);
    const pending = this.queuedForSquad(b.id);
    if (alive + pending + count > MAX_PER_SQUAD) {
      return reject([
        `超出单队上限：现有 ${alive} + 在造 ${pending} + 新排 ${count} > ${MAX_PER_SQUAD}`
      ]);
    }

    const buildTime = tpl.derived.buildTime;
    for (let i = 0; i < count; i++) {
      enqueue(fac, {
        id: "job" + (this.jobSeq++),
        squadId: b.id,
        shipId: b.ship,
        buildTime,
        progress: 0
      });
    }
    return { ok: true, queued: pending + count };
  }

  /** 一键建造 / 补充：按缺编数一次性排队 */
  cmdBuildSquad(cmd) {
    const b = this.build.squads[cmd.squadId];
    if (!b) return reject(["没有这支小队"]);
    const alive = countMembers(this.units, b.id);
    const pending = this.queuedForSquad(b.id);
    const missing = b.count - alive - pending;
    if (missing <= 0) return reject([pending > 0 ? "这支小队已经在补了" : "这支小队已经满编"]);
    return this.cmdQueueShip({ squadId: cmd.squadId, count: missing });
  }

  cmdCancelOrder(cmd) {
    for (const fac of this.production) {
      const job = cancelJob(fac, cmd.jobId);
      if (job) return { ok: true };
    }
    return reject([`没有这条订单 ${cmd.jobId}`]);
  }

  /** 用预制模组瞬间补船 */
  cmdInstantRefill(cmd) {
    const b = this.build.squads[cmd.squadId];
    if (!b) return reject(["没有这支小队"]);
    const alive = countMembers(this.units, b.id);
    const missing = b.count - alive;
    if (missing <= 0) return reject(["这支小队已经满编"]);

    const count = Math.min(cmd.count ?? 1, missing);
    if (count > this.build.modules) {
      return reject([`预制模组不足：需 ${count}，剩 ${Math.floor(this.build.modules)}`]);
    }

    this.build.modules -= count;
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * 55;
      const sq = this.squads[b.id];
      const cx = sq.cn ? sq.cx : this.width * 0.5;
      const cy = sq.cn ? sq.cy : this.height * 0.5;
      this.units.push({
        x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r,
        vx: 0, vy: 0, squad: b.id, alpha: 0, cAll: 0
      });
    }
    applyCombatParams(this.units, this.squads, b.id);
    computeCenters(this.units, this.squads);
    return { ok: true, built: count };
  }

  // ------------------------------------------------------------------
  // 只读查询：跟 command() 一样是唯一入口，只是不写状态
  // ------------------------------------------------------------------

  /**
   * @param {{type:string}} cmd
   * @returns {{ok:boolean, reasons?:string[], ...}}
   */
  query(cmd) {
    if (!cmd || !cmd.type) return { ok: false, reasons: ["查询为空"] };

    switch (cmd.type) {
      // 预览「把某个槽换成某装备」的结果，不写库。
      // UI 靠它做拖拽/下拉的即时红字，而不用先把非法状态存进去。
      case "previewFit": {
        const s = this.ships[cmd.shipId];
        if (!s) return { ok: false, reasons: [`没有这艘舰船 ${cmd.shipId}`] };
        const r = setFit(s, cmd.slotId, cmd.itemId ?? null, this.time);
        return {
          ok: r.ok,
          reasons: r.reasons,
          derived: r.template?.derived ?? null
        };
      }

      // UI 铺下拉框用的静态目录
      case "catalog": {
        return {
          ok: true,
          hulls: Object.values(HULL_TEMPLATES).map(h => ({
            id: h.id, name: h.name, class: h.class, command: h.command
          })),
          weapons: Object.values(WEAPONS)
            .filter(w => w.mountable !== false)
            .map(w => ({ id: w.id, name: w.name, size: w.size, capacity: w.capacity })),
          plugins: Object.values(PLUGIN_TEMPLATES).map(p => ({
            id: p.id, name: p.name, capacity: p.capacity,
            tags: p.tags || [], hasAbility: (p.abilities || []).length > 0
          }))
        };
      }

      case "ship": {
        const s = this.ships[cmd.shipId];
        return s ? { ok: true, derived: s.derived, fit: { ...s.fit } } : { ok: false, reasons: ["没有这艘舰船"] };
      }

      default:
        return { ok: false, reasons: [`未知查询 ${cmd.type}`] };
    }
  }
}

function reject(reasons, code) {
  return { ok: false, reasons, code: code || "rejected" };
}
