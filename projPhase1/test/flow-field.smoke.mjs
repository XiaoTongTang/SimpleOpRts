/**
 * 流场寻路自检
 *   node test/flow-field.smoke.mjs
 *
 * 验的是"这张场对不对"：
 *   1. 空地上方向大致指向目标（8 邻域量化，误差 ≤ 22.5°）
 *   2. 目标落在墙里 → 自动挪到最近空地
 *   3. 有墙 → 方向沿墙绕，不指进墙里
 *   4. 被围死的死角 → 没有方向（cost = Infinity）
 *   5. 不许斜穿墙角
 *   6. 确定性：同一张图两次算出完全一样的场
 *   7. FlowCache 按目标格共享 + LRU 淘汰
 *   8. 端到端：下达信标后下一帧就有场；两队同点只算一张
 */

import { MapGrid } from "../src/core/map.js";
import {
  buildFlowField, directionAt, canStep, cellIndexAt, targetCellOf, FlowCache
} from "../src/core/sim/flow-field.js";
import { GameCore } from "../src/core/core.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
                          : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));

const C = 8;

function makeMap(cols, rows, cells) {
  const walls = new Uint8Array(cols * rows);
  for (const [x, y] of cells) walls[y * cols + x] = 1;
  return new MapGrid({ width: cols * C, height: rows * C, cols, rows, cellSize: C, walls });
}
const block = (x0, y0, w, h) => {
  const a = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) a.push([x, y]);
  return a;
};
const angleBetween = (ax, ay, bx, by) =>
  Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1))));

console.log("\n[1] 空地：方向指向目标");
{
  const m = makeMap(40, 30, []);
  const tx = 20 * C + 4, ty = 15 * C + 4;
  const f = buildFlowField(m, tx, ty);
  ok("场就绪", !!f && f.ready);
  ok("可达格数 > 90%", f.reachable > m.cellCount * 0.9,
    `${f.reachable}/${m.cellCount}`);

  // 从左上角看：方向应当指向右下
  const d = directionAt(f, m, 2 * C, 2 * C);
  ok("有方向", !!d);
  const want = { x: tx - 2 * C, y: ty - 2 * C };
  const ang = angleBetween(d.x, d.y, want.x, want.y) * 180 / Math.PI;
  ok("与真实方向夹角 ≤ 23°（8 邻域量化）", ang <= 23, `${ang.toFixed(1)}°`);
}

console.log("\n[2] 目标落在墙里 → 挪到最近空地");
{
  const m = makeMap(40, 30, block(20, 15, 4, 4));
  const f = buildFlowField(m, 21 * C + 4, 16 * C + 4);   // 正打在墙里
  ok("场仍然建出来了", !!f);
  ok("目标格被挪到空地", f && !m.isWall(f.targetCellX, f.targetCellY),
    f ? `${f.targetCellX},${f.targetCellY}` : "-");

  const cell = targetCellOf(m, 21 * C + 4, 16 * C + 4);
  ok("targetCellOf 与建场时用的是同一格",
    cell && f && cell.cellX === f.targetCellX && cell.cellY === f.targetCellY);

  // 全图都是墙 → 建不出来
  const allWall = makeMap(6, 6, block(0, 0, 6, 6));
  ok("全图都是墙时返回 null", buildFlowField(allWall, 10, 10) === null);
}

console.log("\n[3] 有墙：沿墙绕，不指进墙里");
{
  // 中间一堵竖墙，只有下面留缺口
  const cells = [];
  for (let y = 0; y < 22; y++) cells.push([20, y]);
  const m = makeMap(40, 30, cells);
  const f = buildFlowField(m, 34 * C, 4 * C);        // 目标在右上

  // 墙左边的格子：方向必须"不是纯向右"（否则会撞墙）
  const left = directionAt(f, m, 18 * C, 4 * C);
  ok("墙左侧有方向", !!left);
  const hitsWall = (() => {
    const nx = 18 + left.x, ny = 4 + left.y;
    return m.isWall(Math.round(nx), Math.round(ny));
  })();
  ok("方向不会直接指进墙里", !hitsWall, left ? `${left.x.toFixed(2)},${left.y.toFixed(2)}` : "-");

  // 缺口下方应当有格子向上走（绕过去）
  const below = directionAt(f, m, 20 * C, 25 * C);
  ok("缺口下方有方向", !!below);
}

console.log("\n[4] 死角：没有方向");
{
  // 把 (5,5) 用四面墙围死
  const cells = [[4, 5], [6, 5], [5, 4], [5, 6]];
  const m = makeMap(20, 20, cells);
  const f = buildFlowField(m, 15 * C, 15 * C);
  const f2 = f;
  const idx = 5 * m.cols + 5;
  ok("死角 cost 是 Infinity", !Number.isFinite(f2.cost[idx]), String(f2.cost[idx]));
  ok("死角没有方向", f2.dirX[idx] === 0 && f2.dirY[idx] === 0);
  ok("directionAt 返回 null", directionAt(f2, m, 5 * C + 4, 5 * C + 4) === null);
}

console.log("\n[5] 不许斜穿墙角");
{
  // (5,5) 空地，右边和下面各一格墙 → 右下那个斜方向不能走
  const m = makeMap(20, 20, [[6, 5], [5, 6]]);
  ok("斜穿墙角被禁止", canStep(m, 5, 5, [1, 1]) === false);
  ok("空地斜走允许", canStep(m, 10, 10, [1, 1]) === true);
  ok("贴边外的格子不通", canStep(m, 0, 0, [-1, 0]) === false);
}

console.log("\n[6] 确定性");
{
  const m = makeMap(40, 30, block(18, 10, 6, 12));
  const a = buildFlowField(m, 30 * C, 20 * C);
  const b = buildFlowField(m, 30 * C, 20 * C);
  let same = a.dirX.length === b.dirX.length && a.reachable === b.reachable;
  for (let i = 0; same && i < a.dirX.length; i++) {
    if (a.dirX[i] !== b.dirX[i] || a.dirY[i] !== b.dirY[i]) same = false;
  }
  ok("两次建场逐格相同", same);
}

console.log("\n[7] FlowCache：按目标格共享 + LRU");
{
  const m = makeMap(20, 20, []);
  const cache = new FlowCache(3);
  const k1 = FlowCache.keyOf(m, 1, 1);
  cache.set(k1, { tag: 1 });
  ok("能取回", cache.get(k1).tag === 1);
  ok("size = 1", cache.size === 1);

  cache.set(FlowCache.keyOf(m, 2, 2), { tag: 2 });
  cache.set(FlowCache.keyOf(m, 3, 3), { tag: 3 });
  cache.get(FlowCache.keyOf(m, 1, 1));          // 把 1 提到最近使用
  cache.set(FlowCache.keyOf(m, 4, 4), { tag: 4 }); // 触发淘汰
  ok("上限 3", cache.size === 3, String(cache.size));
  ok("最近用过的没被淘汰", cache.has(FlowCache.keyOf(m, 1, 1)));
  ok("最久没用的被淘汰", !cache.has(FlowCache.keyOf(m, 2, 2)));

  const m2 = new MapGrid({ width: 160, height: 160, cols: 20, rows: 20, cellSize: 8, walls: m.walls });
  ok("换图之后 key 不同（rev 变了）", m2.rev !== m.rev);
}

console.log("\n[8] 端到端：下达信标 → 下一帧有场");
{
  const core = new GameCore({ width: 1600, height: 960, seed: 4 });
  const pool = core.poolOf(0);
  const a = core.build.squads.findIndex(b => !b.loose && b.faction === 0);
  const bIdx = core.build.squads.findIndex((b, i) => !b.loose && b.faction === 0 && i !== a);

  ok("一开始没有场", core.squads[a].flow === null);

  core.command({ type: "setGoal", squadIds: [a, bIdx], x: 800, y: 480 });
  ok("信标下完还没算（排队中）", core.flowQueue.length === 2, String(core.flowQueue.length));

  core.step(1 / 60);
  ok("一帧只算一张（定数调度）", core.flowCache.size === 1, String(core.flowCache.size));
  ok("第一支队伍拿到场了", !!core.squads[a].flow || !!core.squads[bIdx].flow);

  core.step(1 / 60);
  ok("两帧之后两支都有场", !!core.squads[a].flow && !!core.squads[bIdx].flow);
  ok("同目标只缓存了一张", core.flowCache.size === 1, String(core.flowCache.size));

  core.command({ type: "clearGoal", squadIds: [a] });
  ok("清信标后场被丢掉", core.squads[a].flow === null);

  // 空图上的场应当与直线方向一致（没有墙就没有绕行）
  const f = core.squads[bIdx].flow;
  const d = directionAt(f, core.map, 200, 200);
  ok("空图上有方向", !!d);
  ok(`场地规模正确（${core.map.cols}×${core.map.rows}）`,
    f.cols === core.map.cols && f.rows === core.map.rows);
  ok("池子不参与（没有信标）", core.squads[pool].flow === null);
}

console.log("\n[9] 端到端：绕进「开口朝上的口袋」（有流场明显更快）");
{
  const cols = 80, rows = 60;              // 640×480，格长 8
  // 口袋：左壁 + 右壁 + 底封闭，**开口朝上**。
  // 为什么不用普通 U 形（开口朝下）：开口朝下时，船贴墙滑行 + 无命令游走
  // 会在 20 秒内自己蹭出去，测不出流场的作用。开口朝上时擦墙只会卡进拐角。
  const cells = [];
  for (let y = 18; y <= 42; y++) { cells.push([56, y]); cells.push([70, y]); }
  for (let x = 56; x <= 70; x++) cells.push([x, 42]);

  const build = {
    modules: 0, commandCap: 9000,
    squads: [{
      id: 0, key: "A", name: "试验队", faction: 0, loose: false,
      template: null,
      entries: [{ ship: "ship.std_falcon", n: 8 }],
      formations: ["form.default"], form: "form.default",
      ship: "ship.std_falcon", count: 8
    }]
  };

  const goalX = 63 * 8 + 4, goalY = 30 * 8 + 4;

  const run = (useFlow, cap = 2400) => {
    const c = new GameCore({ map: makeMap(cols, rows, cells), build, seed: 9 });
    let k = 0;
    for (const u of c.units) {              // 摆在口袋左边
      u.x = 60 + (k % 3) * 16;
      u.y = 250 + Math.floor(k / 3) * 16;
      k++;
    }
    c.command({ type: "setGoal", squadId: 0, x: goalX, y: goalY });

    let best = Infinity;
    for (let f = 0; f < cap; f++) {
      if (!useFlow) c.squads[0].flow = null;   // 每帧掐掉 = 模拟"没有流场"
      c.step(1 / 60);
      const d = Math.hypot(c.squads[0].cx - goalX, c.squads[0].cy - goalY);
      if (d < best) best = d;
      if (d < 40) return { frames: f + 1, best };
    }
    return { frames: null, best };
  };

  const withFlow = run(true);
  const noFlow = run(false);

  ok("有流场：能绕进朝上的口袋里", withFlow.frames !== null,
    withFlow.frames === null ? `最近 ${withFlow.best.toFixed(0)}px` : `${withFlow.frames} 帧`);
  ok("有流场在 15 秒内到达", withFlow.frames !== null && withFlow.frames < 900,
    String(withFlow.frames));
  ok("无流场明显更慢（耗时至少 1.4 倍）",
    noFlow.frames === null || withFlow.frames * 1.4 < noFlow.frames,
    `有流场 ${withFlow.frames} / 无流场 ${noFlow.frames === null ? "超时" : noFlow.frames} 帧`);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
