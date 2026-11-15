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
  makeSquads, makeSquad, resizeSquad, computeCenters, computeSquadTargets, countMembers,
  GLOBAL_PARAM_DEFS, GLOBAL_PARAM_KEYS, clampGlobalParam
} from "./sim/squad-layer.js";
import { stepUnits } from "./sim/group-layer.js";
import { buildAvoidField } from "./sim/avoid-field.js";
import { Grid } from "./sim/spatial.js";
import {
  blankMap, parseMapDocument, clampCellSize,
  DEFAULT_WORLD_COLS, DEFAULT_WORLD_ROWS, DEFAULT_CELL_SIZE
} from "./map.js";
import { resolveUnitWall } from "./sim/wall-collision.js";
import { buildFlowField, FlowCache, targetCellOf } from "./sim/flow-field.js";
import { stepWeapons } from "./sim/weapon-system.js";
import { applyDamage, stepRegen, applyCombatParams, initUnit, retrofitUnit,
         unitSignature, runtimeSignature } from "./sim/defense-system.js";
import { stepSupport } from "./sim/support-system.js";
import {
  createFacility, enqueue, stepFacility, cancelJob,
  allocatedEff, lineRemaining, queuedCount
} from "./sim/production.js";
import { seedRng, rand } from "./sim/rng.js";
import {
  MAX_PER_SQUAD, MODULES_PER_SHIP,
  createBuild, cloneBuild, entryCost, entriesCost, squadEntries, commandsUsed, applyShipToSquadParams
} from "./state.js";
import {
  cloneEntries, cloneTemplateLibrary, entriesCount, MAX_FORMATION_SLOTS
} from "./data/squad-templates.js";
import {
  cloneFormations, applyFormation, makeFormation, clampFormationParam,
  FORMATION_KEYS, FORMATION_PARAM_KEYS, FORMATION_PARAM_GROUPS
} from "./data/formation-templates.js";
import * as shipLib from "./data/ship-library.js";
import { computeShip, compileShip, setFit } from "./data/ship-template.js";
import { getHull, HULL_TEMPLATES } from "./data/hull-templates.js";
import { PLUGIN_TEMPLATES } from "./data/plugin-templates.js";
import { ABILITY_TEMPLATES } from "./data/ability-templates.js";
import { WEAPONS } from "./sim/weapons.js";

const SPAWN_SPREAD = 55;

/** 地图里有没有墙（用来决定要不要建避墙场；空图建出来全是 0，白费几毫秒） */
function hasAnyWall(map) {
  const w = map.walls;
  for (let i = 0; i < w.length; i++) if (w[i] === 1) return true;
  return false;
}

/**
 * 每帧最多算几张流场。
 *
 * **必须是定数**：按毫秒预算会让不同机器在"第几帧算完"上分叉，同一颗种子
 * 跑出的战斗就不一样了（determinism.smoke 会红）。
 * 实测一张 250×150 的场约 2~3 ms，一帧 16.7 ms 有余量。
 */
const FLOW_PER_FRAME = 1;

export class GameCore {
  constructor(opts = {}) {
    this.reset(opts);
  }

  // ------------------------------------------------------------------
  // 生命周期
  // ------------------------------------------------------------------

  reset(opts = {}) {
    // 世界尺寸由**地图**派生（宽度 = 格数 × 格长），不再是独立状态。
    // 给法优先级从上到下：
    //   1. opts.map               —— 一张现成的地图（导入 / 测试）
    //   2. opts.cols/rows[/cell]  —— 格数（+ 格长），合成一张空图
    //   3. opts.width/height      —— **px 便捷入口**，只给测试/工具用：
    //                                换算成格数（向上取整），所以世界尺寸可能比分给的多不到一格
    //   4. 都不给                  —— 沿用当前地图（reset 就是"同一张图重开一局"）
    const cur = this.map;
    const cell = clampCellSize(
      opts.cell ?? (cur ? cur.cellSize : DEFAULT_CELL_SIZE));

    let map = opts.map || null;
    if (!map && (opts.cols != null || opts.rows != null)) {
      map = blankMap(
        opts.cols ?? (cur ? cur.cols : DEFAULT_WORLD_COLS),
        opts.rows ?? (cur ? cur.rows : DEFAULT_WORLD_ROWS),
        cell
      );
    }
    if (!map && (opts.width != null || opts.height != null)) {
      const w = opts.width ?? (cur ? cur.width : DEFAULT_WORLD_COLS * cell);
      const h = opts.height ?? (cur ? cur.height : DEFAULT_WORLD_ROWS * cell);
      map = blankMap(Math.ceil(w / cell), Math.ceil(h / cell), cell);
    }
    if (!map && cur) {
      // 格长没变就沿用原图；变了就按新格长重造同样格数的一张空图
      map = cell === cur.cellSize ? cur : blankMap(cur.cols, cur.rows, cell, cur.name);
    }
    if (!map) map = blankMap(DEFAULT_WORLD_COLS, DEFAULT_WORLD_ROWS, cell);
    this.map = map;

    // 世界尺寸：**派生量**（cols × cellSize）。改格长它就跟着变，这里只是缓存成字段方便读。
    this.width = map.width;
    this.height = map.height;

    // 静息避墙场：**每张地图一张**（与目标、队伍都无关），只在有墙时才建。
    // 没有命令信标的小队靠它躲墙；有信标的小队走带通行成本的流场，不读它。
    this.avoidField = hasAnyWall(map) ? buildAvoidField(map) : null;

    // 相机是「观察状态」，不是战斗状态：zoom = 0 表示自动铺满视口
    if (!this.cam) this.cam = { x: this.width / 2, y: this.height / 2, zoom: 0 };

    /** 随机种子：同一个 seed 每次重开都是同一场战斗 */
    this.seed = seedRng(opts.seed ?? this.seed ?? 1);

    /** 全局移动参数。数值取质量速度模型沙盒的实测默认值（见 form.default 的注释） */
    this.G = {
      damping: 1.1,        // 粘性阻尼 λ（1/s）
      mass: 1.00,           // 全局质量：a = F / mass
      boostSpeed: 60,       // 低速助推阈值
      boostForce: 45,       // 低速助推力
      maxSpeedFactor: 1.20, // 安全阀：|v| ≤ SPD × 这个系数（沙盒没有上限，这里保留以防火箭）
      wallAvoidForce: 40    // 无信标小队在离墙 B 格内受到的恒定避墙力（0 = 关掉）
    };

    this.squads = makeSquads();
    this.units = [];
    this.projectiles = [];
    this.fx = [];
    this.hits = [];
    this.grid = new Grid(Math.max(1, this.width), Math.max(1, this.height));

    // 流场：按目标格共享的缓存 + 待算队列（队列顺序决定"哪一帧算完"，必须是确定的）
    this.flowCache = new FlowCache(8);
    this.flowQueue = [];

    /** 构筑状态：权威 */
    this.ships = opts.ships && Object.keys(opts.ships).length
      ? opts.ships
      : (this.ships && Object.keys(this.ships).length ? this.ships : shipLib.createLibrary());
    this.shipRev = this.shipRev ?? 0;      // 方案库版本号，存档层据此判断要不要写盘
    this.unlocked = opts.unlocked || this.unlocked || null; // 蓝图解锁表；null = 不校验

    // 编制模板库：每个 core 一份自己的（和舰船方案库一样，reset 不清空）
    this.squadTemplates = (this.squadTemplates && Object.keys(this.squadTemplates).length)
      ? this.squadTemplates
      : cloneTemplateLibrary();

    // 阵型库：每个 core 一份自己的（和编制模板库一样，reset 不清空）
    this.formations = (this.formations && Object.keys(this.formations).length)
      ? this.formations
      : cloneFormations();

    // 构筑：默认按模板库生成。`opts.build` 可以让调用方塞一份现成的构筑
    // （阵型编辑界面用它造一个只有一两支小队的预览战场），之后 reset 都沿用同一份。
    this.buildTemplate = opts.build || this.buildTemplate || null;
    this.build = this.buildTemplate
      ? cloneBuild(this.buildTemplate)
      : createBuild(this.squadTemplates);

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

    this._rtCache = null;          // 舰船方案的编译缓存（reset 时丢掉）

    this.spawnAll();
    return this;
  }

  /** 视口 = 画布（战场那一格）的像素尺寸；只影响相机取景，不改世界大小 */
  setViewport(width, height) {
    this.vw = Math.max(1, width | 0);
    this.vh = Math.max(1, height | 0);
  }

  // ------------------------------------------------------------------
  // 相机（纯观察状态；画布多大只看这一块，世界永远是自己那么大）
  // ------------------------------------------------------------------

  viewportSize() {
    return [this.vw || this.width, this.vh || this.height];
  }

  /** 铺满视口的缩放：窗口变小只会让这个基准变小 */
  fitZoom() {
    const [vw, vh] = this.viewportSize();
    return Math.min(vw / this.width, vh / this.height) || 1;
  }

  /** 缩放范围：最小就是「整张图刚好铺满」，最大再放大 3.2 倍 */
  clampZoom(z) {
    const fit = this.fitZoom();
    return Math.min(Math.max(z, fit), Math.max(fit * 3.2, 2.6));
  }

  /**
   * 当前取景 → 给渲染层的世界→屏幕变换（屏幕坐标相对画布左上角）。
   * 相机中心会被夹在世界范围内：视野比世界大时直接居中，不能让画面跑出地图外。
   */
  cameraView() {
    const [vw, vh] = this.viewportSize();
    const fit = this.fitZoom();
    const z = this.cam.zoom > 0 ? this.clampZoom(this.cam.zoom) : fit;
    const hw = vw / (2 * z), hh = vh / (2 * z);
    const x = hw * 2 >= this.width ? this.width / 2 : clampNum(this.cam.x, hw, this.width - hw);
    const y = hh * 2 >= this.height ? this.height / 2 : clampNum(this.cam.y, hh, this.height - hh);

    // 夹回来的结果写回相机，避免拖到边界后「松手还在往外拖」
    this.cam.x = x;
    this.cam.y = y;
    if (this.cam.zoom > 0) this.cam.zoom = z;

    return { ox: vw / 2 - x * z, oy: vh / 2 - y * z, zoom: z, x, y, vw, vh };
  }

  /**
   * 视角命令：
   *   { x, y }        把相机中心移到世界坐标（小地图点哪看哪）
   *   { zoom }        绝对缩放
   *   { factor, ax, ay }  相对缩放，ax/ay 是画布内的锚点（滚轮以鼠标位置为中心）
   *   { fit: true }   回到整图铺满
   */
  cmdSetCamera(cmd) {
    if (cmd.fit) {
      this.cam = { x: this.width / 2, y: this.height / 2, zoom: 0 };
      return { ok: true };
    }

    const [vw, vh] = this.viewportSize();
    const z0 = this.cameraView().zoom;

    let z = z0;
    if (Number.isFinite(cmd.zoom)) z = Number(cmd.zoom);
    else if (Number.isFinite(cmd.factor) && cmd.factor > 0) z = z0 * Number(cmd.factor);
    if (!Number.isFinite(z) || z <= 0) return reject(["缩放值无效"]);
    z = this.clampZoom(z);

    let x = Number.isFinite(cmd.x) ? Number(cmd.x) : this.cam.x;
    let y = Number.isFinite(cmd.y) ? Number(cmd.y) : this.cam.y;

    // 滚轮缩放：锚点下面的那块地面不动
    if (Number.isFinite(cmd.factor) && Number.isFinite(cmd.ax) && Number.isFinite(cmd.ay)) {
      const wx = this.cam.x + (cmd.ax - vw / 2) / z0;
      const wy = this.cam.y + (cmd.ay - vh / 2) / z0;
      x = wx - (cmd.ax - vw / 2) / z;
      y = wy - (cmd.ay - vh / 2) / z;
    }

    this.cam = { x, y, zoom: z };
    this.cameraView();              // 立刻夹回世界内
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // 地图
  // ------------------------------------------------------------------
  //
  // 世界尺寸由地图派生（见 ./map.js）。校验必须在 core 里做：
  // UI 只负责把文件读成 JSON 对象，判断"这张图能不能用"是游戏规则。

  /**
   * 换地图。换图 = 重开一局：单位重摆、所有流场失效、相机回到铺满整图。
   * 构筑状态（编制 / 方案库）跨局保留，和 reset 一致。
   */
  cmdImportMap(cmd) {
    const r = parseMapDocument(cmd.data, cmd.name);
    if (!r.ok) return reject(r.reasons);

    this.reset({ map: r.map, seed: this.seed });
    this.cam = { x: this.width / 2, y: this.height / 2, zoom: 0 };
    return {
      ok: true,
      cols: r.map.cols,
      rows: r.map.rows,
      cellSize: r.map.cellSize,
      floor: r.map.floorCount()
    };
  }

  /**
   * 换格长（比例尺）**没有运行时命令**。
   *
   * 格长是"一格等于多少 PX"，也就是整张地图的比例尺：改它意味着世界从 2000×1200 变成
   * 6000×3600 这种量级变化，属于"换一张世界"，不是一局之内能发生的事。
   * 所以入口只有一个：改 `map.js` 的 `DEFAULT_CELL_SIZE` 然后重新启动
   * （见 design/261115_1地图相关测试复盘/05-技术设计-格长即比例尺.md D3）。
   */

  // ------------------------------------------------------------------
  // 单位战斗属性
  // ------------------------------------------------------------------
  //
  // 舰船身上**不保留方案引用**，只存它自己在战斗里要用的那套属性
  // （血量 / 护盾 / 武器槽 / 支援能力）。属性在造出来那一刻从所属小队的
  // 方案编译一次，之后就不再和方案库有任何联系。
  //
  // 于是「改方案会不会追溯已经造好的船」这个问题只剩一个答案：
  // 会（syncShipUsage 就是在干这件事）—— 但我们用「在役就禁止改方案」
  // 从命令层把这条路堵死。不需要每条船留版本快照。

  /** 某方案的运行时规格（编译结果缓存，方案库一变就失效） */
  runtimeOf(shipId) {
    const tpl = this.ships[shipId];
    if (!tpl) return null;
    if (!this._rtCache || this._rtCache.rev !== this.shipRev) {
      this._rtCache = { rev: this.shipRev, map: new Map() };
    }
    let rt = this._rtCache.map.get(shipId);
    if (!rt) {
      rt = compileShip(tpl);
      this._rtCache.map.set(shipId, rt);
    }
    return rt;
  }

  /** 造一艘船：属性直接写在这一艘身上，不带方案引用 */
  makeUnit(squadId, rt, x, y) {
    if (!rt) return null;
    const u = { squad: squadId, x, y, vx: 0, vy: 0, alpha: 0, cAll: 0 };
    initUnit(u, rt);
    this.settleUnit(u);
    return u;
  }

  /**
   * 把一个刚放下的单位从墙里挤出来。
   * 出生点、生产线出锅、吸收散兵、改编制补人 —— 所有"凭空出现"的船都要过这一道，
   * 否则它会以 `radius + 2px` 的位移被弹出来（大船尤其明显）。
   * 不消耗随机数，所以不影响确定性。
   */
  settleUnit(u) {
    if (!u || !this.map) return u;
    resolveUnitWall(this.map, u, u.radius || 0);
    return u;
  }

  /**
   * 某方案在战场上有多少活的舰船（= 锁定判据）。
   *
   * 舰船没有方案引用，所以「此方案对应的舰船」只能这样认：
   * 编制里列了这个方案的小队里，属性和它同型号的那些船。
   * 散兵池不算（池子里的船没有编制归属，强行改方案也不会追到它们）。
   */
  shipInService(shipId) {
    const sig = this.sigOf(shipId);
    if (!sig) return 0;
    let n = 0;
    for (const b of this.build.squads) {
      if (b.loose) continue;
      if (!squadEntries(b).some(e => e.ship === shipId && e.n > 0)) continue;
      n += countBySignature(this.units, b.id, sig);
    }
    return n;
  }

  // ------------------------------------------------------------------
  // 散兵池
  // ------------------------------------------------------------------
  //
  // 每个阵营有一个散兵池（build.squads 里的 loose 项）：收纳所有未编队舰船。
  // 它在战场上就是一支普通小队——有位置、能领命令信标，只是没有编制。
  //
  // 池子的入口：生产线造好的船、被解散的小队、被编制剔除的船。
  // 出口：吸收散兵（按同型签名挑船补进编制）。

  /** 某阵营散兵池的小队 id；没有返回 -1 */
  poolOf(faction) {
    const b = this.build.squads.find(s => s.loose && s.faction === faction);
    return b ? b.id : -1;
  }

  /** 池子没有编制：把 b.count 同步成实际舰数，UI 和指挥值都读它 */
  syncPoolCount(poolId) {
    const b = this.build.squads[poolId];
    if (!b || !b.loose) return;
    b.count = countMembers(this.units, poolId);
  }

  /** 某方案的型号签名（吸收散兵时按它挑船；UI 也能用） */
  sigOf(shipId) {
    const rt = this.runtimeOf(shipId);
    return rt ? runtimeSignature(rt) : "";
  }

  /** 某阵营散兵池里某型号的舰数 */
  poolCountOf(faction, sig) {
    const poolId = this.poolOf(faction);
    if (poolId < 0) return 0;
    let n = 0;
    for (const u of this.units) {
      if (u.squad !== poolId) continue;
      if (unitSignature(u) === sig) n++;
    }
    return n;
  }

  /** 按构筑状态生成全部单位 */
  spawnAll() {
    this.units.length = 0;
    const cols = [this.width * 0.26, this.width * 0.74];
    const pending = [];        // { u, shipId }：先摆位置，再统一初始化

    // 第一遍：只摆位置。随机数的消耗顺序和以前完全一致，
    // 免得「加属性层」这件事顺手把整局战斗的走向也改掉。
    for (const b of this.build.squads) {
      const sq = this.squads[b.id];
      const entries = b.loose
        ? [{ ship: b.ship, n: b.count }]
        : squadEntries(b);

      sq.p.members = b.count;
      // 小队默认参数按主方案编译（战斗属性由每艘船自己带，不从这里来）
      applyShipToSquadParams(sq, this.ships[b.ship]);
      if (b.form) applyFormation(sq.p, b.form, this.formations);  // 阵型：13 个参数整块覆盖

      const row = b.id % 4;
      const bx = cols[b.faction] ?? this.width * 0.5;
      const by = this.height * (0.14 + row * 0.235);

      // 混编小队按 entries 顺序铺开：先矛隼后重锤，位置混在一起
      for (const e of entries) {
        for (let k = 0; k < (e.n | 0); k++) {
          const a = rand() * Math.PI * 2;
          const r = Math.sqrt(rand()) * SPAWN_SPREAD;
          const u = {
            x: bx + Math.cos(a) * r,
            y: by + Math.sin(a) * r,
            vx: 0, vy: 0,
            squad: b.id,
            alpha: 0, cAll: 0
          };
          this.units.push(u);
          pending.push({ u, shipId: e.ship });
        }
      }
    }

    computeCenters(this.units, this.squads);

    // 第二遍：按每艘船自己的方案初始化战斗属性
    for (const it of pending) { initUnit(it.u, this.runtimeOf(it.shipId)); this.settleUnit(it.u); }

    // 池子没有编制，count 直接同步成实际舰数
    for (const b of this.build.squads) if (b.loose) this.syncPoolCount(b.id);
  }

  // ------------------------------------------------------------------
  // 推进
  // ------------------------------------------------------------------

  step(dt) {
    if (this.paused) return;

    // 0. 生产（造好的船这一帧就能动）
    this.stepProduction(dt);

    // 1. 集群移动（位置推进 + 墙体硬碰撞都在 stepUnits 内部完成，
    //    这里不再有任何 [8, W-8] 的硬夹 —— 墙的边界由 map 的世界边框处理）
    // 流场先补一张（每帧最多 FLOW_PER_FRAME 张），再让船去读它
    this.stepFlowQueue();

    computeCenters(this.units, this.squads);
    computeSquadTargets(this.units, this.squads);
    stepUnits(this.units, this.squads, this.G, dt, this.width, this.height, this.map, this.avoidField);

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

  /**
   * 一艘船造好了：**并入该阵营的散兵池**。
   * 出厂的船不直接进任何编制——编制要靠「吸收散兵」把船拉进去。
   */
  completeJob(job) {
    const poolId = this.poolOf(job.faction);
    if (poolId < 0) return;
    const sq = this.squads[poolId];
    const rt = this.runtimeOf(job.shipId);
    if (!rt) return;

    // 落在池子重心附近（先取位置、后初始化，保持随机数消耗顺序与旧版一致）
    const cx = sq.cn ? sq.cx : this.width * (job.faction === 0 ? 0.26 : 0.74);
    const cy = sq.cn ? sq.cy : this.height * 0.5;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 55;

    const u = this.makeUnit(poolId, rt, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    if (!u) return;

    this.units.push(u);
    computeCenters(this.units, this.squads);
    this.syncPoolCount(poolId);
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
      map: this.map,
      camera: this.cameraView(),
      world: { w: this.width, h: this.height },
      bases: [],       // 阶段一未接基地/防御塔
      towers: [],
      units: this.units,
      squads: this.squads,
      fx: this.fx,
      projectiles: this.projectiles,
      time: this.time
    };
  }

  /**
   * UI 快照：只含 UI 要显示的数字。
   * 注意这里没有 units —— 每帧的单位数组永远不进 React。
   */
  snapshot() {
    // 一次遍历：按「型号签名」数场上的船——在役数、池子分类都用它
    const sigPool0 = new Map();         // sig -> 蓝方池子里的艘数（给 UI 显示）
    const sigBySquad = new Map();       // squadId -> Map(sig -> n)
    for (const u of this.units) {
      const b = this.build.squads[u.squad];
      if (!b) continue;
      const k = unitSignature(u);
      if (b.loose && b.faction === 0) sigPool0.set(k, (sigPool0.get(k) || 0) + 1);

      let m = sigBySquad.get(u.squad);
      if (!m) { m = new Map(); sigBySquad.set(u.squad, m); }
      m.set(k, (m.get(k) || 0) + 1);
    }

    // 签名 → 方案名：舰船没有方案引用，只能靠签名认出是哪一型
    const sigName = new Map();
    for (const id of Object.keys(this.ships)) {
      const rt = this.runtimeOf(id);
      if (rt) sigName.set(runtimeSignature(rt), this.ships[id].name);
    }
    const poolKinds = [...sigPool0.entries()].map(([sig, n]) => ({
      name: sigName.get(sig) || "（已下线的改型）", n
    })).sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : 1));
    const poolSize = poolKinds.reduce((s, k) => s + k.n, 0);

    // 在役：编制里引用了这个方案、且场上真有同型号的船
    const inServiceMap = new Map();
    for (const b of this.build.squads) {
      if (b.loose) continue;
      const m = sigBySquad.get(b.id);
      if (!m) continue;
      for (const e of squadEntries(b)) {
        if (!(e.n > 0)) continue;
        const sig = this.sigOf(e.ship);
        const n = m.get(sig) || 0;
        if (n) inServiceMap.set(e.ship, (inServiceMap.get(e.ship) || 0) + n);
      }
    }

    const squads = this.build.squads.map(b => {
      const sq = this.squads[b.id];
      const ship = this.ships[b.ship];
      const d = ship?.derived;
      const alive = countMembers(this.units, b.id);
      const aliveBySig = sigBySquad.get(b.id) || new Map();

      // 编制（entries）+ 每种型号现在活了几艘
      const entries = b.loose ? [] : squadEntries(b);
      const comp = entries.map(e => {
        const sig = this.sigOf(e.ship);
        return {
          ship: e.ship,
          name: this.ships[e.ship]?.name ?? "?",
          n: e.n,
          alive: aliveBySig.get(sig) || 0
        };
      });

      // 散兵池没有编制：数量就是实际舰数，指挥值按每艘船自己的 command 累加
      let cost;
      if (b.loose) {
        cost = 0;
        for (const u of this.units) if (u.squad === b.id) cost += u.command || 0;
      } else {
        cost = entriesCost(entries, this.ships);
      }

      return {
        id: b.id, key: b.key, faction: b.faction, loose: b.loose,
        // 界面上显示的名字（新建小队用模板名，初始队用字母）
        name: b.name || (b.loose ? "散兵" : b.key),
        template: b.template || null,
        templateName: b.template ? (this.squadTemplates[b.template]?.name ?? b.template) : null,
        // 编制：多型号
        entries: comp,
        // 阵型：当前 + 可选（有序，[0] 是模板默认）
        form: b.form || null,
        formations: [...(b.formations || [])],
        // 战场上的质心 + 命令信标（没有信标就是 null）
        x: sq ? sq.cx : 0,
        y: sq ? sq.cy : 0,
        goal: sq && sq.goal ? { x: sq.goal.x, y: sq.goal.y } : null,
        // 主方案（兼容旧 UI）
        ship: b.ship,
        shipName: ship?.name ?? "?",
        capacity: d?.capacity ?? 0,
        capacityUsed: d?.capacityUsed ?? 0,
        command: d?.command ?? 0,
        buildTime: d?.buildTime ?? 0,
        hull: ship?.hull ?? "hull.falcon",
        weapon: d?.weapons?.[0]?.id ?? "laser",
        count: b.loose ? alive : entriesCount(entries),
        alive,
        cost
      };
    });

    return {
      t: this.time,
      paused: this.paused,
      winner: this.winner,
      // 地图元信息：格数（权威）+ 格长（比例尺）→ 世界尺寸（派生）
      map: {
        cols: this.map.cols,
        rows: this.map.rows,
        cell: this.map.cellSize,
        width: this.width,
        height: this.height,
        name: this.map.name
      },
      unitCount: this.units.length,
      modules: Math.floor(this.build.modules),
      moduleCap: this.moduleCap,
      commandCap: this.build.commandCap,
      commandUsed: commandsUsed(this.build, this.ships, this.units),
      // 每个阵营一份统计：界面左上角的阵营切换要能看到对方的账
      factions: [0, 1].map(f => {
        let ships = 0, squads = 0;
        for (const b of this.build.squads) {
          if (b.faction !== f) continue;
          squads++;
        }
        for (const u of this.units) {
          const b = this.build.squads[u.squad];
          if (b && b.faction === f) ships++;
        }
        return {
          faction: f,
          commandUsed: this.commandUsedOf(f),
          commandCap: this.build.commandCap,
          ships, squads
        };
      }),
      // 散兵池：没有编制，UI 单独显示（哪几型、各多少艘）
      pool: { faction: 0, size: poolSize, kinds: poolKinds },
      // 编制模板库：UI 编辑它就会追溯改所有引用它的小队
      templates: Object.values(this.squadTemplates).map(t => {
        // 编制总览数值：把每条船的编译结果乘上数量
        let hp = 0, shield = 0, dps = 0, command = 0, ships = 0;
        const entries = t.entries.map(e => {
          const rt = this.runtimeOf(e.ship);
          const n = e.n | 0;
          ships += n;
          if (rt) {
            hp += (rt.maxHp || 0) * n;
            shield += (rt.maxShield || 0) * n;
            command += (rt.command || 0) * n;
            dps += (rt.weapons || []).reduce((s, id) => s + weaponDps(id), 0) * n;
          }
          return {
            ship: e.ship,
            name: this.ships[e.ship]?.name ?? "?",
            n,
            single: rt ? {
              hp: rt.maxHp || 0,
              shield: rt.maxShield || 0,
              dps: Math.round((rt.weapons || []).reduce((s, id) => s + weaponDps(id), 0) * 10) / 10,
              command: rt.command || 0
            } : null
          };
        });
        return {
          id: t.id,
          name: t.name,
          desc: t.desc || "",
          entries,
          formations: [...(t.formations || [])],
          usedBy: this.build.squads.filter(b => b.template === t.id).length,
          stats: {
            ships,
            hp,
            shield,
            dps: Math.round(dps * 10) / 10,
            command
          }
        };
      }),
      // 阵型库：玩家可编辑的 Couzin 参数组。usedBy = 有多少支小队"当前正在用"它
      formationList: Object.values(this.formations).map(f => ({
        id: f.id,
        name: f.name,
        desc: f.desc || "",
        from: f.from || null,
        builtin: !!f.builtin,
        usedBy: this.build.squads.filter(b => b.form === f.id).length,
        p: { ...f.p }
      })),
      /** 参数面板要用：分组、上下限、小数位、说明 */
      formationParams: FORMATION_PARAM_GROUPS.map(g => ({
        title: g.title,
        hint: g.hint,
        items: g.items.map(i => ({ ...i }))
      })),
      /** 全局群体参数：当前值 + 元数据（阵型编辑界面的「全局参数」卡片） */
      G: { ...this.G },
      globalParams: GLOBAL_PARAM_DEFS.map(d => ({ ...d })),
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
        const d = s.derived || {};
        return {
          id: s.id,
          name: s.name,
          hull: s.hull,
          hullName: hull?.name ?? "?",
          command: d.command ?? 0,
          capacity: d.capacity ?? 0,
          capacityUsed: d.capacityUsed ?? 0,
          buildTime: d.buildTime ?? 0,
          // 数值面板要的：血量 / 回血 / 护盾 / 护盾回复 / 受击半径
          armor: d.armor ? { ...d.armor } : null,
          dps: Math.round((d.weapons || []).reduce((n, w) => n + weaponDps(w.id), 0) * 10) / 10,
          // 装了什么（名字 + 承载），右侧装配区要用
          weapons: (d.weapons || []).map(w => ({ ...w })),
          plugins: (d.plugins || []).map(p => ({ ...p })),
          // 在役舰数：>0 表示这个方案被锁死（不能改、不能删）
          inService: inServiceMap.get(s.id) || 0,
          ok: !!d.ok,
          reasons: d.reasons ?? [],
          fit: { ...s.fit },
          slots: hull
            ? [
                ...hull.slots.weapon.map(w => ({ id: w.id, kind: "weapon", size: w.size, pos: w.pos || null })),
                ...hull.slots.plugin.map(p => ({ id: p.id, kind: "plugin", size: null, pos: null }))
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

      // 视角：不是战斗状态，不参与模拟、不落盘
      case "setCamera": return this.cmdSetCamera(cmd);

      case "reset":
        // 同一张图重开一局（地图、格长都不动）
        this.reset({ seed: this.seed });
        return { ok: true };

      // 换地图：等于重开一局（构筑与方案库跨局保留，和 reset 一致）
      case "importMap": return this.cmdImportMap(cmd);

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
      case "setShipHull": return this.cmdSetShipHull(cmd);

      // 生产
      case "setLineEfficiency": return this.cmdSetLineEfficiency(cmd);
      case "queueShip": return this.cmdQueueShip(cmd);
      case "cancelOrder": return this.cmdCancelOrder(cmd);
      case "instantBuild": return this.cmdInstantBuild(cmd);

      // 散兵池
      case "absorb": return this.cmdAbsorb(cmd);
      case "disband": return this.cmdDisband(cmd);

      // 指挥：命令信标（小队会朝这个点移动）
      case "setGoal": return this.cmdSetGoal(cmd);
      case "clearGoal": return this.cmdClearGoal(cmd);

      // 建造：按编制模板一键建一支小队
      case "buildFromTemplate": return this.cmdBuildFromTemplate(cmd);

      // 编制模板 / 阵型
      case "editSquadTemplate": return this.cmdEditSquadTemplate(cmd);
      case "createSquadTemplate": return this.cmdCreateSquadTemplate(cmd);
      case "deleteSquadTemplate": return this.cmdDeleteSquadTemplate(cmd);
      case "setFormation": return this.cmdSetFormation(cmd);
      case "setGlobalParams": return this.cmdSetGlobalParams(cmd);

      // 阵型库（玩家可编辑的 Couzin 参数组）
      case "editFormation": return this.cmdEditFormation(cmd);
      case "editFormationBatch": return this.cmdEditFormationBatch(cmd);
      case "createFormation": return this.cmdCreateFormation(cmd);
      case "duplicateFormation": return this.cmdDuplicateFormation(cmd);
      case "renameFormation": return this.cmdRenameFormation(cmd);
      case "deleteFormation": return this.cmdDeleteFormation(cmd);

      default:
        return reject([`未知命令 ${cmd.type}`], "unknown");
    }
  }

  /**
   * 编队变更：换舰船方案 / 改编制。
   *
   * 引用了编制模板的小队不接受逐队改编制 —— 改模板才对（那是"追溯"的唯一入口）。
   * 所以这条命令现在只有一种效果：**把这支小队从模板上摘下来**，变成
   * 一支自己拿一份编制的「无编制小队」。代价是它以后不能吸收散兵。
   */
  applyLoadout(cmd) {
    const id = cmd.squadId;
    const sq = this.squads[id];
    const b = this.build.squads[id];
    if (!sq || !b) return reject(["没有这支小队"]);
    if (b.loose) return reject(["散兵池没有编制，不能改编制"]);

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
      // 解散状态的队伍本来就没占指挥值（commandsUsed 跳过它），按 0 起算
      const prevCost = entriesCost(squadEntries(b), this.ships);
      const usedAfter = commandsUsed(this.build, this.ships, this.units)
        - prevCost + entryCost(nextShip, nextCount);
      if (usedAfter > this.build.commandCap) {
        reasons.push(
          `超出指挥值：需 ${usedAfter}，上限 ${this.build.commandCap}（超 ${usedAfter - this.build.commandCap}）`
        );
      }
    }

    const grow = Math.max(0, nextCount - entriesCount(squadEntries(b)));
    if (grow > 0 && grow * MODULES_PER_SHIP > this.build.modules) {
      reasons.push(`预制模组不足：需 ${grow * MODULES_PER_SHIP}，剩 ${this.build.modules}`);
    }

    if (reasons.length) return reject(reasons);

    // ---- 应用（差量，不重建全场） ----
    b.template = null;                 // 脱离模板：从此自己拿一份编制
    b.entries = [{ ship: nextShipId, n: nextCount }];
    b.ship = nextShipId;
    b.count = nextCount;
    if (!b.formations || !b.formations.length) {
      b.formations = b.form ? [b.form] : [];
    }

    sq.p.members = nextCount;
    applyShipToSquadParams(sq, nextShip);

    // 整队换装：这是玩家的显式操作，整队都换成新方案的属性。
    // 新造的船在 push 完之后统一初始化（保持随机数顺序）。
    const rt = this.runtimeOf(nextShipId);
    resizeSquad(this.units, this.squads, id, nextCount, this.width, this.height,
      u => { initUnit(u, rt); this.settleUnit(u); });

    // 血量为比例缩放，新单位补 initCombat —— 所以改配置不会让整队满血复活
    applyCombatParams(this.units, this.squads, id);
    for (const u of this.units) if (u.squad === id) u.command = rt.command || 0;

    this.build.modules -= grow * MODULES_PER_SHIP;

    return { ok: true };
  }

  // ------------------------------------------------------------------
  // 编制模板（改模板 = 追溯改所有引用它的小队）
  // ------------------------------------------------------------------

  /**
   * 改一个编制模板，并把结果追到所有引用它的小队：
   *   - 编制里多出来的船 → 退回散兵池（"剔除不符合编制的舰船"）
   *   - 阵型重置成模板的默认阵型（formations[0]）
   *   - 缺口不自动补：要船就按「吸收散兵」去池子里拿
   */
  cmdEditSquadTemplate(cmd) {
    const tplId = cmd.templateId;
    const tpl = this.squadTemplates[tplId];
    if (!tpl) return reject([`没有这个编制模板 ${tplId}`]);
    const nextEntries = cmd.entries ? cloneEntries(cmd.entries) : cloneEntries(tpl.entries);
    const nextForms = cmd.formations ? [...cmd.formations] : [...tpl.formations];

    if (nextForms.length > MAX_FORMATION_SLOTS) {
      return reject([`一个编制最多挂 ${MAX_FORMATION_SLOTS} 个阵型`]);
    }
    for (const f of nextForms) {
      if (!this.formations[f]) return reject([`未知阵型 ${f}`]);
    }
    for (const e of nextEntries) {
      if (!this.ships[e.ship]) return reject([`未知舰船方案 ${e.ship}`]);
      if (!Number.isInteger(e.n) || e.n < 0) return reject([`${e.ship} 的数量必须是 0 以上的整数`]);
    }
    const total = entriesCount(nextEntries);
    if (total > MAX_PER_SQUAD) return reject([`单队编制上限 ${MAX_PER_SQUAD} 艘`]);

    // 指挥值：算上"改完之后"的编制
    const used = commandsUsed(this.build, this.ships, this.units);
    let delta = 0;
    for (const b of this.build.squads) {
      if (b.template !== tplId) continue;
      delta += entriesCost(nextEntries, this.ships) - entriesCost(squadEntries(b), this.ships);
    }
    if (used + delta > this.build.commandCap) {
      return reject([
        `超出指挥值：改完需 ${used + delta}，上限 ${this.build.commandCap}（超 ${used + delta - this.build.commandCap}）`
      ]);
    }

    // ---- 写回模板（这只是"库"；真正的影响在下面逐个追下去） ----
    tpl.entries = nextEntries;
    tpl.formations = nextForms;

    let touched = 0, ejected = 0;
    for (const b of this.build.squads) {
      if (b.template !== tplId) continue;
      touched++;
      ejected += this.applySquadTemplate(b, nextEntries, nextForms);
    }

    return { ok: true, touched, ejected };
  }

  /** 新建一个空的编制模板（UI 的「新建编制」） */
  cmdCreateSquadTemplate(cmd) {
    const name = String(cmd.name ?? "").trim() || "新编制";
    if (name.length > 16) return reject(["编制名最多 16 个字"]);

    let id = cmd.id;
    if (!id) {
      let n = 1;
      while (this.squadTemplates[`squad.usr_${String(n).padStart(4, "0")}`]) n++;
      id = `squad.usr_${String(n).padStart(4, "0")}`;
    }
    if (this.squadTemplates[id]) return reject([`编制 id 已存在：${id}`]);

    const entries = Array.isArray(cmd.entries) ? cloneEntries(cmd.entries) : [];
    for (const e of entries) {
      if (!this.ships[e.ship]) return reject([`未知舰船方案 ${e.ship}`]);
      if (!Number.isInteger(e.n) || e.n < 0) return reject(["数量必须是 0 以上的整数"]);
    }
    const forms = Array.isArray(cmd.formations) ? [...cmd.formations] : ["form.default"];
    for (const f of forms) if (!this.formations[f]) return reject([`未知阵型 ${f}`]);

    this.squadTemplates[id] = {
      id, name,
      desc: cmd.desc || "",
      entries,
      formations: forms.slice(0, MAX_FORMATION_SLOTS)
    };
    return { ok: true, id };
  }

  /** 删除一个编制模板（还有小队在引用就拒绝） */
  cmdDeleteSquadTemplate(cmd) {
    const tpl = this.squadTemplates[cmd.templateId];
    if (!tpl) return reject([`没有这个编制模板 ${cmd.templateId}`]);

    const used = this.build.squads.filter(b => b.template === tpl.id);
    if (used.length) {
      return reject([`还有 ${used.length} 支小队在用这个编制，先换掉再删`]);
    }
    delete this.squadTemplates[tpl.id];
    return { ok: true };
  }

  /**
   * 把一份编制套到一支小队上，并剔除多出来的船。
   * @returns 退回散兵池的舰数
   */
  applySquadTemplate(b, entries, forms) {
    const poolId = this.poolOf(b.faction);
    const oldEntries = squadEntries(b);
    let ejected = 0;

    // 每种型号：现在的船比新编制多出来的部分，退回池子
    for (const e of oldEntries) {
      const sig = this.sigOf(e.ship);
      if (!sig) continue;
      const want = entries.find(x => x.ship === e.ship)?.n ?? 0;
      // 用「签名」认船：编制里同型号可能被拆成两条，所以按签名归并
      const have = countBySignature(this.units, b.id, sig);
      let excess = have - want;
      if (excess <= 0) continue;

      for (let i = this.units.length - 1; i >= 0 && excess > 0; i--) {
        const u = this.units[i];
        if (u.squad !== b.id) continue;
        if (unitSignature(u) !== sig) continue;
        u.squad = poolId;
        excess--;
        ejected++;
      }
    }

    b.entries = cloneEntries(entries);
    b.formations = [...forms];
    b.ship = b.entries[0]?.ship ?? b.ship;
    b.count = entriesCount(b.entries);

    // 阵型重置为模板默认（没有阵型就保持原样）
    const formId = forms[0] || null;
    if (formId) {
      b.form = formId;
      applyFormation(this.squads[b.id].p, formId, this.formations);
    }

    if (poolId >= 0) this.syncPoolCount(poolId);
    return ejected;
  }

  /** 切换一支小队的阵型（瞬间生效，只改那 12 个参数） */
  cmdSetFormation(cmd) {
    const b = this.build.squads[cmd.squadId];
    if (!b) return reject(["没有这支小队"]);
    if (b.loose) return reject(["散兵池没有阵型"]);
    if (!this.formations[cmd.form]) return reject([`未知阵型 ${cmd.form}`]);
    if (!(b.formations || []).includes(cmd.form)) {
      return reject([`这支小队的编制没解锁阵型 ${cmd.form}`]);
    }
    b.form = cmd.form;
    applyFormation(this.squads[b.id].p, cmd.form, this.formations);
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // 流场
  // ------------------------------------------------------------------
  //
  // 每支小队一张场，但**按目标格共享缓存**：8 支队伍下同一个信标只算一次。
  // 换图、清信标、改信标都要让对应的场失效。
  // 算场是"贵活"，所以排队 + 定数调度（每帧最多一张），绝不按毫秒决定。

  /** 把一支队伍排进待算队列（已在队列里就不重复排） */
  enqueueFlow(squadId) {
    if (squadId === undefined || squadId === null) return;
    if (!this.flowQueue.includes(squadId)) this.flowQueue.push(squadId);
  }

  /** 每帧补一批流场。返回这一帧算了几张 */
  stepFlowQueue() {
    let done = 0;
    while (done < FLOW_PER_FRAME && this.flowQueue.length > 0) {
      const id = this.flowQueue.shift();
      this.buildSquadFlow(id);
      done++;
    }
    return done;
  }

  /** 给某支队伍配好流场（优先从缓存拿） */
  buildSquadFlow(squadId) {
    const sq = this.squads[squadId];
    if (!sq) return false;
    if (!sq.goal || !this.map) { sq.flow = null; return false; }

    const map = this.map;
    const cell = targetCellOf(map, sq.goal.x, sq.goal.y);
    if (!cell) { sq.flow = null; return false; }

    const key = FlowCache.keyOf(map, cell.cellX, cell.cellY);
    let field = this.flowCache.get(key);

    if (!field) {
      const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
      field = buildFlowField(map, sq.goal.x, sq.goal.y);
      if (field) {
        field.computeMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
        this.flowCache.set(key, field);
      }
    }

    sq.flow = field || null;
    return !!field;
  }

  /** 某支队伍当前的流场状态（调试 / UI 用） */
  flowInfoOf(squadId) {
    const sq = this.squads[squadId];
    if (!sq) return null;
    const f = sq.flow;
    if (!f) return { ready: false, pending: this.flowQueue.includes(squadId) };
    return {
      ready: true,
      targetCellX: f.targetCellX,
      targetCellY: f.targetCellY,
      reachable: f.reachable,
      computeMs: f.computeMs || 0
    };
  }

  // ------------------------------------------------------------------
  // 阵型库（玩家可编辑的 Couzin 参数组）
  // ------------------------------------------------------------------
  //
  // 阵型是**设计数据**，不是战场状态：每个 core 一份自己的库，reset 不清空。
  // 改一个参数要立刻摊到"正在用它的那些小队"上，否则玩家改了没反应。
  // 编制模板里引用的阵型 id 也在这里校验，删阵型前要看有没有人还在用。

  /**
   * 改全局群体参数（阻尼 / 质量 / 助推 / 限速）。
   * 一次可以只给一部分键；未知键与非法值都会被夹住或忽略。
   */
  cmdSetGlobalParams(cmd) {
    const p = cmd.p;
    if (!p || typeof p !== "object") return reject(["缺少参数对象"]);

    let n = 0;
    for (const k of GLOBAL_PARAM_KEYS) {
      if (p[k] === undefined) continue;
      this.G[k] = clampGlobalParam(k, p[k]);
      n++;
    }
    if (!n) return reject(["没有可用的全局参数"]);

    // 质量变了要同步到场上每一艘船（有效质量 = u.mass × G.mass，通常只靠 G.mass）
    return { ok: true, changed: n, G: { ...this.G } };
  }

  /** 生成一个不冲突的自建阵型 id */
  nextFormId() {
    let n = 1;
    for (const id of Object.keys(this.formations)) {
      const m = /^form\.custom\.(\d+)$/.exec(id);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
    return `form.custom.${n}`;
  }

  /** 把某个阵型重新摊到所有"当前阵型就是它"的小队上 */
  reapplyFormation(formId) {
    let n = 0;
    for (const b of this.build.squads) {
      if (b.form !== formId) continue;
      const sq = this.squads[b.id];
      if (!sq) continue;
      applyFormation(sq.p, formId, this.formations);
      n++;
    }
    return n;
  }

  /** 改阵型的一个参数（立刻生效） */
  cmdEditFormation(cmd) {
    const f = this.formations[cmd.formId];
    if (!f) return reject([`未知阵型 ${cmd.formId}`]);
    if (!FORMATION_KEYS.includes(cmd.key)) return reject([`不是阵型参数 ${cmd.key}`]);

    const value = clampFormationParam(cmd.key, cmd.value);
    f.p[cmd.key] = value;
    const applied = this.reapplyFormation(cmd.formId);
    return { ok: true, key: cmd.key, value, applied };
  }

  /** 一次改多个参数（面板整体保存用） */
  cmdEditFormationBatch(cmd) {
    const f = this.formations[cmd.formId];
    if (!f) return reject([`未知阵型 ${cmd.formId}`]);
    if (!cmd.p || typeof cmd.p !== "object") return reject(["缺少参数对象"]);

    let n = 0;
    for (const k of FORMATION_KEYS) {
      if (cmd.p[k] === undefined) continue;
      f.p[k] = clampFormationParam(k, cmd.p[k]);
      n++;
    }
    const applied = this.reapplyFormation(cmd.formId);
    return { ok: true, changed: n, applied };
  }

  /** 新建一个自建阵型（默认照抄 standard，可以指定 from） */
  cmdCreateFormation(cmd) {
    const id = this.nextFormId();
    const from = cmd.from && this.formations[cmd.from] ? cmd.from : "form.default";
    this.formations[id] = makeFormation({
      id,
      name: cmd.name || "新阵型",
      from,
      p: cmd.p || null,
      builtin: false
    });
    return { ok: true, formId: id };
  }

  /** 复制一个现有阵型 */
  cmdDuplicateFormation(cmd) {
    const src = this.formations[cmd.formId];
    if (!src) return reject([`未知阵型 ${cmd.formId}`]);
    const id = this.nextFormId();
    this.formations[id] = makeFormation({
      id,
      name: cmd.name || `${src.name} 副本`,
      from: null,
      p: src.p,
      builtin: false
    });
    return { ok: true, formId: id };
  }

  cmdRenameFormation(cmd) {
    const f = this.formations[cmd.formId];
    if (!f) return reject([`未知阵型 ${cmd.formId}`]);
    const name = String(cmd.name || "").trim();
    if (!name) return reject(["名字不能为空"]);
    if (name.length > 24) return reject(["名字太长（最多 24 字）"]);
    f.name = name;
    return { ok: true };
  }

  /** 删一个自建阵型：内置的不能删，还有人在用的也不能删 */
  cmdDeleteFormation(cmd) {
    const f = this.formations[cmd.formId];
    if (!f) return reject([`未知阵型 ${cmd.formId}`]);
    if (f.builtin) return reject(["内置阵型不能删除"]);

    for (const t of Object.values(this.squadTemplates)) {
      if ((t.formations || []).includes(cmd.formId)) {
        return reject([`编制模板「${t.name}」还在用这个阵型`]);
      }
    }
    for (const b of this.build.squads) {
      if ((b.formations || []).includes(cmd.formId)) {
        return reject([`小队「${b.name || b.key}」还在用这个阵型`]);
      }
    }

    delete this.formations[cmd.formId];
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

    // 锁定①：还有活的舰船在役 → 不能删（属性都在它们身上，删了就成了孤儿）
    const used = this.build.squads.filter(s => s.ship === id);
    const alive = this.shipInService(id);
    if (alive > 0) {
      return reject([
        `还有 ${used.length} 支小队在用这个方案（${alive} 艘在役），拆光之前不能删除`
      ]);
    }

    if (used.length) {
      return reject([`还有 ${used.length} 支小队在用这个方案，先换掉再删`]);
    }
    shipLib.removeShip(this.ships, id);
    this.shipRev++;
    return { ok: true };
  }

  cmdSetShipHull(cmd) {
    const s = this.ships[cmd.shipId];
    if (!s) return reject([`没有这艘舰船 ${cmd.shipId}`]);
    if (!getHull(cmd.hull)) return reject([`未知船体 ${cmd.hull}`]);

    const alive = this.shipInService(cmd.shipId);
    if (alive > 0) {
      return reject([
        `该方案还有 ${alive} 艘在役，换船体会直接改掉它们的属性；拆光或换掉之前不能换`
      ]);
    }

    const next = shipLib.setHull(this.ships, cmd.shipId, cmd.hull, this.time);
    if (!next) return reject(["换船体失败"]);
    this.shipRev++;
    return { ok: true };
  }

  cmdSetShipFit(cmd) {
    const s = this.ships[cmd.shipId];
    if (!s) return reject([`没有这艘舰船 ${cmd.shipId}`]);

    // 锁定：还有活的舰船在役 → 不能改装配
    // （强行改会顺着 syncShipUsage 把这些船的属性一起换掉，所以必须在入口拦住）
    const alive = this.shipInService(cmd.shipId);
    if (alive > 0) {
      return reject([
        `该方案还有 ${alive} 艘在役，改装配会直接改掉它们的属性；拆光或换掉之前不能改`
      ]);
    }

    const oldSig = this.sigOf(cmd.shipId);

    // 装配改了但校验不过 —— 事务式拒绝，库里保持原样
    const r = shipLib.setShipFit(this.ships, cmd.shipId, cmd.slotId, cmd.itemId ?? null, this.time);
    if (!r.ok) return reject(r.reasons);

    this.shipRev++;                    // 先让编译缓存失效，再同步
    // 在役为 0 时这只是兜底：万一还有引用它的编制（只是暂时没船）
    this.syncShipUsage(cmd.shipId, oldSig);
    return { ok: true };
  }

  /**
   * 把某方案的编译结果刷进引用它的编制里、**同型号**的那些船。
   *
   * 这是「强行改方案」的路径：改完之后那些船的属性会变。正常流程靠
   * 命令层的「在役就禁止改」把它挡住（见 cmdSetShipFit / cmdDeleteShip）。
   * 按旧签名挑船，所以混编小队里别的型号不会被误改。
   */
  syncShipUsage(shipId, oldSig) {
    const rt = this.runtimeOf(shipId);
    if (!rt || !oldSig) return 0;

    let n = 0;
    for (const b of this.build.squads) {
      if (b.loose) continue;                     // 池子是混装的，不整队刷
      if (!squadEntries(b).some(e => e.ship === shipId)) continue;
      for (const u of this.units) {
        if (u.squad !== b.id) continue;
        if (unitSignature(u) !== oldSig) continue;
        retrofitUnit(u, rt);
        n++;
      }
      if (b.ship === shipId) applyShipToSquadParams(this.squads[b.id], this.ships[shipId]);
    }
    return n;
  }

  // ------------------------------------------------------------------
  // 生产命令
  // ------------------------------------------------------------------

  /** 某阵营的生产设施 */
  facilityOfFaction(faction) {
    return this.production.find(f => f.faction === faction) || null;
  }

  /** 某个阵营排了多少艘还没造出来 */
  queuedForFaction(faction) {
    let n = 0;
    const fac = this.facilityOfFaction(faction);
    if (fac) for (const line of fac.lines) n += line.queue.length;
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

  /**
   * 排队建造：造出来的船进散兵池。
   *
   * 订单挂在「阵营 + 方案」上，不挂在某个小队上 —— 编制要船的时候是靠
   * 吸收散兵去池子里拿，而不是提前把产量预定给某支队。
   *
   * 也接受 { squadId }：等价于「这个阵营、这个方案」，方便 UI 从选中的小队直接下单。
   */
  cmdQueueShip(cmd) {
    const count = cmd.count ?? 1;
    if (!Number.isInteger(count) || count < 1) return reject(["数量必须是 ≥1 的整数"]);

    let faction = cmd.faction;
    let shipId = cmd.shipId;

    if (cmd.squadId !== undefined) {
      const b = this.build.squads[cmd.squadId];
      if (!b) return reject(["没有这支小队"]);
      if (b.loose) return reject(["散兵池没有编制，不能给池子下单"]);
      faction = b.faction;
      shipId = shipId ?? b.ship;
    }
    if (faction === undefined || faction === null) return reject(["没有指定阵营"]);
    if (!shipId) return reject(["没有指定舰船方案"]);

    const tpl = this.ships[shipId];
    if (!tpl || !tpl.derived.ok) return reject([`方案 ${shipId} 当前不可建造`]);

    const fac = this.facilityOfFaction(faction);
    if (!fac) return reject([`阵营 ${faction} 没有生产设施`]);

    const buildTime = tpl.derived.buildTime;
    for (let i = 0; i < count; i++) {
      enqueue(fac, {
        id: "job" + (this.jobSeq++),
        faction,
        shipId,
        buildTime,
        progress: 0
      });
    }
    return { ok: true, queued: this.queuedForFaction(faction) };
  }

  cmdCancelOrder(cmd) {
    for (const fac of this.production) {
      const job = cancelJob(fac, cmd.jobId);
      if (job) return { ok: true };
    }
    return reject([`没有这条订单 ${cmd.jobId}`]);
  }

  /**
   * 快速建造：花预制模组，一次性把船造出来，进散兵池。
   * 和排队建造的区别只有"要不要等"，出口是同一个。
   */
  cmdInstantBuild(cmd) {
    const count = cmd.count ?? 1;
    if (!Number.isInteger(count) || count < 1) return reject(["数量必须是 ≥1 的整数"]);

    let faction = cmd.faction;
    let shipId = cmd.shipId;

    if (cmd.squadId !== undefined) {
      const b = this.build.squads[cmd.squadId];
      if (!b) return reject(["没有这支小队"]);
      if (b.loose) return reject(["散兵池没有编制，不能给池子下单"]);
      faction = b.faction;
      shipId = shipId ?? b.ship;
    }
    if (faction === undefined || faction === null) return reject(["没有指定阵营"]);
    if (!shipId) return reject(["没有指定舰船方案"]);

    const rt = this.runtimeOf(shipId);
    if (!rt) return reject([`方案 ${shipId} 当前不可建造`]);

    if (count > this.build.modules) {
      return reject([`预制模组不足：需 ${count}，剩 ${Math.floor(this.build.modules)}`]);
    }

    const poolId = this.poolOf(faction);
    if (poolId < 0) return reject([`阵营 ${faction} 没有散兵池`]);

    this.build.modules -= count;

    const sq = this.squads[poolId];
    const cx = sq.cn ? sq.cx : this.width * (faction === 0 ? 0.26 : 0.74);
    const cy = sq.cn ? sq.cy : this.height * 0.5;

    // 先摆位置、再初始化，和旧版的随机数消耗顺序一致
    const fresh = [];
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * 55;
      const u = {
        squad: poolId,
        x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r,
        vx: 0, vy: 0, alpha: 0, cAll: 0
      };
      this.units.push(u);
      fresh.push(u);
    }
    for (const u of fresh) { initUnit(u, rt); this.settleUnit(u); }

    computeCenters(this.units, this.squads);
    this.syncPoolCount(poolId);
    return { ok: true, built: count };
  }

  /**
   * 吸收散兵：从池子里挑「同型号」的船，补进这支小队的编制。
   *
   * 编制可能有多种型号，所以按 entries 逐项补：每型补到它自己的缺口为止。
   * 同型怎么判：属性签名相同（见 defense-system.unitSignature）——
   * 舰船身上没有方案引用，也不需要，属性一样就真的是一样。
   *
   * 无编制小队（template === null）没有编制可补，也不能吸收。
   */
  cmdAbsorb(cmd) {
    const b = this.build.squads[cmd.squadId];
    if (!b) return reject(["没有这支小队"]);
    if (b.loose) return reject(["散兵池本身不能吸收散兵"]);
    if (!b.template) return reject(["无编制小队没有编制，不能吸收散兵"]);

    const entries = squadEntries(b);
    if (!entries.length) return reject(["这支小队没有编制"]);

    const poolId = this.poolOf(b.faction);
    if (poolId < 0) return reject(["这个阵营没有散兵池"]);

    // 每型：编制 n - 场上同签名舰数 = 缺口
    const plan = [];
    let gapAll = 0;
    for (const e of entries) {
      const sig = this.sigOf(e.ship);
      if (!sig) continue;
      const gap = Math.max(0, (e.n | 0) - countBySignature(this.units, b.id, sig));
      if (gap > 0) { plan.push({ ship: e.ship, sig, gap }); gapAll += gap; }
    }
    if (!plan.length) return reject(["这支小队已经满编"]);

    const want = Math.min(gapAll, cmd.count ?? gapAll);
    let left = want;
    let moved = 0;

    for (const p of plan) {
      if (left <= 0) break;
      const take = Math.min(p.gap, left);
      let got = 0;
      for (const u of this.units) {
        if (got >= take) break;
        if (u.squad !== poolId) continue;
        if (unitSignature(u) !== p.sig) continue;
        u.squad = b.id;
        got++; moved++;
      }
      left -= got;
    }

    if (!moved) {
      return reject([
        `散兵池里没有可补的型号（池里 ${countMembers(this.units, poolId)} 艘）`
      ]);
    }


    computeCenters(this.units, this.squads);
    this.syncPoolCount(poolId);
    return { ok: true, moved };
  }

  /**
   * 解散小队：**删除这支小队实例**，舰船全部退回散兵池。
   *
   * 生命周期只有两种状态：存在 / 不存在。没有"已解散但仍记录"这种中间态。
   * 因此这里必须做三件事，缺一件都会留下幽灵数据：
   *   1. 把船移走（否则它们会指向一个不存在的队）
   *   2. 从 `squads` 与 `build.squads` 里**同时**删掉这一项（两者按下标对齐）
   *   3. 重新编号，并把所有引用旧 id 的地方（船的 squad、生产队列的 squadId）改过来
   *
   * 指挥值不归还——船还在，只是没编队。
   */
  cmdDisband(cmd) {
    const id = cmd.squadId;
    const b = this.build.squads[id];
    if (!b) return reject(["没有这支小队"]);
    if (b.loose) return reject(["散兵池不能解散"]);

    const faction = b.faction;
    const poolId = this.poolOf(faction);
    if (poolId < 0) return reject(["这个阵营没有散兵池"]);

    // 1. 船退回池子
    let moved = 0;
    for (const u of this.units) {
      if (u.squad !== id) continue;
      u.squad = poolId;
      moved++;
    }

    // 2 & 3. 删除实例 + 重新编号（池子的下标可能因此变化，所以之后要重新找）
    this.removeSquad(id);

    computeCenters(this.units, this.squads);
    const newPool = this.poolOf(faction);
    if (newPool >= 0) this.syncPoolCount(newPool);
    return { ok: true, moved };
  }

  /**
   * 从两张表里删掉一支小队，并把所有引用旧 id 的位置重编号。
   * `squads[i].id === i` 与 `build.squads[i].id === i` 这两条不变量必须始终成立，
   * 否则 `units[].squad` 的语义就散了。
   */
  removeSquad(id) {
    if (!this.squads[id] || !this.build.squads[id]) return false;
    if (this.squads[id].loose) return false;          // 散兵池永远不删

    this.squads.splice(id, 1);
    this.build.squads.splice(id, 1);

    this.squads.forEach((sq, i) => { sq.id = i; });
    this.build.squads.forEach((b, i) => { b.id = i; });

    for (const u of this.units) {
      if (u.squad > id) u.squad -= 1;
    }
    for (const fac of this.production) {
      for (const line of fac.lines) {
        for (const job of line.queue) {
          if (job.squadId > id) job.squadId -= 1;
        }
      }
    }
    return true;
  }

  // ------------------------------------------------------------------
  // 指挥：命令信标
  // ------------------------------------------------------------------

  /** 命令信标：小队会朝这个点移动（每队一个点，命令力只有一个） */
  cmdSetGoal(cmd) {
    const ids = Array.isArray(cmd.squadIds)
      ? cmd.squadIds
      : (cmd.squadId !== undefined ? [cmd.squadId] : []);

    const x = Number(cmd.x), y = Number(cmd.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return reject(["信标坐标不合法"]);
    if (!ids.length) return reject(["没有选中小队"]);

    let n = 0;
    for (const id of ids) {
      const sq = this.squads[id];
      if (!sq) continue;

      sq.goal = {
        x: Math.max(0, Math.min(this.width, x)),
        y: Math.max(0, Math.min(this.height, y))
      };
      this.enqueueFlow(id);          // 新信标 = 新流场（下一帧补，按队列顺序）
      n++;
    }
    if (!n) return reject(["没有这支小队"]);
    return { ok: true, squads: n };
  }

  /** 取消命令信标：不给 squadIds 就是全部取消 */
  cmdClearGoal(cmd) {
    const ids = Array.isArray(cmd.squadIds)
      ? cmd.squadIds
      : (cmd.squadId !== undefined ? [cmd.squadId] : null);

    let n = 0;
    for (const sq of this.squads) {
      if (!sq.goal) continue;
      if (ids && !ids.includes(sq.id)) continue;
      sq.goal = null;
      sq.flow = null;          // 信标没了，场也没用了
      this.flowQueue = this.flowQueue.filter(x => x !== sq.id);
      n++;
    }
    if (!n) return reject(["没有可取消的命令信标"]);
    return { ok: true, cleared: n };
  }

  // ------------------------------------------------------------------
  // 建造：按编制模板一键建一支小队
  // ------------------------------------------------------------------
  //
  // 消耗「编制总艘数」个预制模组，一次性把船造出来（在母舰旁边成型），
  // 然后建一支引用这个模板的新小队。和「排队建造」的区别只有要不要等。

  cmdBuildFromTemplate(cmd) {
    const tpl = this.squadTemplates[cmd.templateId];
    if (!tpl) return reject([`没有这个编制模板 ${cmd.templateId}`]);

    const faction = cmd.faction ?? 0;
    const poolId = this.poolOf(faction);
    if (poolId < 0) return reject([`阵营 ${faction} 没有散兵池`]);

    const entries = cloneEntries(tpl.entries).filter(e => e.n > 0);
    const ships = entriesCount(entries);
    if (!ships) return reject(["这个编制的船数是 0"]);
    if (ships > MAX_PER_SQUAD) return reject([`单队编制上限 ${MAX_PER_SQUAD} 艘`]);

    for (const e of entries) {
      if (!this.runtimeOf(e.ship)) return reject([`方案 ${e.ship} 当前不可建造`]);
    }

    if (ships > this.build.modules) {
      return reject([`预制模组不足：需 ${ships}，剩 ${Math.floor(this.build.modules)}`]);
    }

    const cost = entriesCost(entries, this.ships);
    const used = this.commandUsedOf(faction);
    if (used + cost > this.build.commandCap) {
      return reject([`超出指挥值：需 ${used + cost}，上限 ${this.build.commandCap}`]);
    }

    // ---- 建队 ----
    const id = this.build.squads.length;
    const sameTpl = this.build.squads.filter(
      b => b.template === tpl.id && b.faction === faction).length;
    const name = sameTpl ? `${tpl.name} ${sameTpl + 1}` : tpl.name;

    const b = {
      id, key: tpl.name, name,
      faction,
      loose: false,
      template: tpl.id,
      entries,
      formations: [...tpl.formations],
      form: tpl.formations[0] || null,
      ship: entries[0].ship,
      count: ships
    };
    this.build.squads.push(b);

    const sq = makeSquad({ key: name, faction }, id, faction);
    this.squads.push(sq);
    sq.p.members = ships;
    applyShipToSquadParams(sq, this.ships[b.ship]);
    if (b.form) applyFormation(sq.p, b.form, this.formations);

    // ---- 造舰：母舰旁边成型 ----
    const cx = this.width * (faction === 0 ? 0.26 : 0.74);
    const cy = this.height * 0.5;
    const fresh = [];
    for (const e of entries) {
      const rt = this.runtimeOf(e.ship);
      for (let k = 0; k < e.n; k++) {
        const a = rand() * Math.PI * 2;
        const r = Math.sqrt(rand()) * SPAWN_SPREAD;
        const u = {
          squad: id,
          x: cx + Math.cos(a) * r,
          y: cy + Math.sin(a) * r,
          vx: 0, vy: 0, alpha: 0, cAll: 0
        };
        this.units.push(u);
        fresh.push({ u, rt });
      }
    }
    for (const it of fresh) { initUnit(it.u, it.rt); this.settleUnit(it.u); }

    this.build.modules -= ships;
    computeCenters(this.units, this.squads);
    this.syncPoolCount(poolId);

    return { ok: true, squadId: id, built: ships };
  }

  /** 某阵营当前占用的指挥值（编队按编制、散兵池按实际舰船） */
  commandUsedOf(faction) {
    let sum = 0;
    for (const b of this.build.squads) {
      if (b.faction !== faction) continue;
      if (b.loose) {
        for (const u of this.units) if (u.squad === b.id) sum += u.command || 0;
      } else {
        sum += entriesCost(squadEntries(b), this.ships);
      }
    }
    return sum;
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
            id: h.id,
            name: h.name,
            class: h.class,
            command: h.command,
            capacity: h.capacity,
            buildTime: h.buildTime,
            armor: { ...h.armor },
            sprite: h.sprite || null,
            slots: {
              weapon: h.slots.weapon.map(w => ({ id: w.id, size: w.size, pos: w.pos || null })),
              plugin: h.slots.plugin.map(p => ({ id: p.id }))
            }
          })),
          weapons: Object.values(WEAPONS)
            .filter(w => w.mountable !== false)
            .map(w => {
              const shots = Math.max(1, w.fire.burst | 0);
              return {
                id: w.id,
                name: w.name,
                size: w.size,
                capacity: w.capacity,
                command: w.command || 0,
                buildTime: w.buildTime || 0,
                delivery: w.delivery,
                dmg: w.impact.dmg,
                cd: w.fire.cd,
                burst: shots,
                maxHits: w.hit.maxHits,
                pierce: !!w.impact.pierceShield,
                blastR: w.impact.blastR || 0,
                range: w.delivery === "hitscan"
                  ? (w.travel.range || 0)
                  : Math.round((w.travel.speed || 0) * (w.travel.lifetime || 0)),
                dps: Math.round(weaponDps(w.id) * 10) / 10
              };
            }),
          plugins: Object.values(PLUGIN_TEMPLATES).map(p => ({
            id: p.id,
            name: p.name,
            desc: p.desc || "",
            capacity: p.capacity,
            command: p.command || 0,
            buildTime: p.buildTime || 0,
            mods: { ...(p.mods || {}) },
            tags: p.tags || [],
            abilities: (p.abilities || []).map(ref => {
              const t = ABILITY_TEMPLATES[ref.id];
              return t ? {
                id: t.id, name: t.name, resource: t.resource,
                radius: t.radius, rate: t.rate, count: ref.count || 1
              } : { id: ref.id, name: ref.id };
            }),
            hasAbility: (p.abilities || []).length > 0
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

function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 某小队里签名匹配的舰数（舰船没有方案引用，型号就是它的属性） */
function countBySignature(units, squadId, sig) {
  let n = 0;
  for (const u of units) {
    if (u.squad === squadId && unitSignature(u) === sig) n++;
  }
  return n;
}

/** 一把武器不加成的理论 DPS（伤害 × 一轮发数 ÷ 一轮总冷却），单体口径 */
export function weaponDps(id) {
  const w = WEAPONS[id];
  if (!w) return 0;
  const shots = Math.max(1, w.fire.burst | 0);
  const cd = (w.fire.cd || 1) + (w.fire.burstDelay || 0) * (shots - 1);
  return (w.impact.dmg * shots) / Math.max(0.001, cd);
}
