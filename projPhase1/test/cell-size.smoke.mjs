/**
 * 格长 / 比例尺自检
 *   node test/cell-size.smoke.mjs
 *
 * 口径（见 design/261115_1地图相关测试复盘/05-技术设计-格长即比例尺.md）：
 *
 *   **格数是权威，世界尺寸 = 格数 × 格长（派生）。**
 *   格长 8 → 24 不是"网格变粗"，而是把整张地图等比放大 3 倍：
 *   格子数、墙的格子数据、流场要算的格数全都不变。
 *
 * 验的是：
 *   1. 派生关系：width = cols × cell，改格长世界跟着放大，格数不动
 *   2. 唯一的比例尺来源是 DEFAULT_CELL_SIZE（构造时可显式覆盖，用于测试）
 *   3. 导入地图：width/height 是**格数**，文件里的 cellSize 不参与任何计算
 *   4. 地图层面没有运行时换格长的入口（命令已删除）
 */

import { GameCore } from "../src/core/core.js";
import {
  MapGrid, blankMap, parseMapDocument, clampCellSize,
  DEFAULT_CELL_SIZE, DEFAULT_WORLD_COLS, DEFAULT_WORLD_ROWS
} from "../src/core/map.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
  : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));
const eq = (n, a, b) => ok(n, a === b, `期望 ${b}，实际 ${a}`);

/** 一张 cols×rows 的图，带一堵 4 格宽的竖墙 */
function gridWithWall(cols, rows, x0 = Math.floor(cols / 2), w = 4) {
  const g = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let y = 0; y < rows; y++) for (let x = x0; x < x0 + w && x < cols; x++) g[y][x] = -1;
  return g;
}

console.log("\n[1] 派生关系：世界尺寸 = 格数 × 格长");
{
  const C = DEFAULT_CELL_SIZE;
  const m = blankMap(DEFAULT_WORLD_COLS, DEFAULT_WORLD_ROWS, C);
  eq("列数就是给的格数", m.cols, DEFAULT_WORLD_COLS);
  eq("行数就是给的格数", m.rows, DEFAULT_WORLD_ROWS);
  eq("世界宽 = 格数 × 格长", m.width, DEFAULT_WORLD_COLS * C);
  eq("世界高 = 格数 × 格长", m.height, DEFAULT_WORLD_ROWS * C);

  // 同一张 250×150 的图，格长 ×3 → 世界 ×3、格数一位不变
  const m24 = blankMap(DEFAULT_WORLD_COLS, DEFAULT_WORLD_ROWS, 24);
  eq("换格长后格数不变（列）", m24.cols, m.cols);
  eq("换格长后格数不变（行）", m24.rows, m.rows);
  eq("世界宽按比例放大", m24.width, DEFAULT_WORLD_COLS * 24);
  eq("世界高按比例放大", m24.height, DEFAULT_WORLD_ROWS * 24);
  ok("世界确实变大了", m24.width > m.width);

  eq("格坐标换算跟着格长", m24.cellXOf(24 * 3 + 5), 3);
}

console.log("\n[2] 比例尺来源：DEFAULT_CELL_SIZE（构造可覆盖，仅测试用）");
{
  const core = new GameCore({
    cols: DEFAULT_WORLD_COLS, rows: DEFAULT_WORLD_ROWS, seed: 1
  });
  eq("默认格长", core.map.cellSize, DEFAULT_CELL_SIZE);
  eq("默认世界宽", core.width, DEFAULT_WORLD_COLS * DEFAULT_CELL_SIZE);

  const wide = new GameCore({
    cols: DEFAULT_WORLD_COLS, rows: DEFAULT_WORLD_ROWS, cell: 24
  });
  eq("显式格长生效", wide.map.cellSize, 24);
  eq("世界跟着放大", wide.width, DEFAULT_WORLD_COLS * 24);
  eq("另一个 core 不受影响", core.map.cellSize, DEFAULT_CELL_SIZE);

  core.command({ type: "reset" });
  eq("reset 不改格长", core.map.cellSize, DEFAULT_CELL_SIZE);
  eq("reset 不改世界尺寸", core.width, DEFAULT_WORLD_COLS * DEFAULT_CELL_SIZE);

  // 快照里的元信息是自洽的（格数 × 格长 = 世界尺寸）
  const s1 = core.snapshot().map;
  eq("快照 宽 = 格数 × 格长", s1.width, s1.cols * s1.cell);
  eq("快照 高 = 格数 × 格长", s1.height, s1.rows * s1.cell);
}

console.log("\n[3] 换格长不动格子数据");
{
  const C = 8;
  const cols = 40, rows = 30;
  const walls = new Uint8Array(cols * rows);
  for (let y = 5; y < 25; y++) for (let x = 18; x < 22; x++) walls[y * cols + x] = 1;  // 4 格宽竖墙

  const m8 = new MapGrid({ cols, rows, cellSize: C, walls, name: "t" });
  const m24 = new MapGrid({ cols, rows, cellSize: 24, walls, name: "t" });

  eq("格数相同", m24.cols, m8.cols);
  eq("墙数组是同一份（没有重采样）", m24.walls === m8.walls, true);
  eq("同一个格坐标还是墙", m24.isWall(18, 10), m8.isWall(18, 10));
  eq("墙在格空间的位置不变", m24.isWall(21, 10), true);
  eq("墙外的格仍然不是墙", m24.isWall(30, 10), false);
  eq("世界坐标换算按新格长", m24.isWallAt(18 * 24 + 5, 10 * 24 + 5), true);
  eq("旧格长下的世界坐标不再是同一格", m8.isWallAt(18 * 8 + 5, 10 * 8 + 5), true);
  ok("世界尺寸 ×3", m24.width === m8.width * 3);
}

console.log("\n[4] 导入地图：width/height 是格数，文件里的 cellSize 不被采纳");
{
  const doc = { name: "老图", width: 250, height: 150, grid: gridWithWall(250, 150) };
  const r = parseMapDocument(doc);
  eq("解析成功", r.ok, true);
  eq("列数 = 文件的 width", r.map.cols, 250);
  eq("行数 = 文件的 height", r.map.rows, 150);
  eq("格长取引擎的 DEFAULT_CELL_SIZE", r.map.cellSize, DEFAULT_CELL_SIZE);
  eq("世界宽 = 格数 × 格长", r.map.width, 250 * DEFAULT_CELL_SIZE);
  ok("墙没被丢光", r.map.walls.some(v => v === 1));
  eq("墙数组长度 = 格数", r.map.walls.length, 250 * 150);

  // 文件里写了 cellSize 也没用：它不参与任何计算
  const withCell = parseMapDocument({
    width: 60, height: 40, cellSize: 999, grid: gridWithWall(60, 40)
  });
  eq("文件写 cellSize 也不采纳", withCell.map.cellSize, DEFAULT_CELL_SIZE);
  eq("世界宽仍由格数 × 格长决定", withCell.map.width, 60 * DEFAULT_CELL_SIZE);

  // 走真实命令路径
  const core = new GameCore({ cols: 10, rows: 10, seed: 3 });
  const cmd = core.command({ type: "importMap", data: doc, name: "老图" });
  eq("导入命令成功", cmd.ok, true);
  eq("导入后格数 = 文件格数", core.map.cols, 250);
  eq("导入后世界宽 = 格数 × 格长", core.width, 250 * DEFAULT_CELL_SIZE);
  eq("导入后格长没被文件顶掉", core.map.cellSize, DEFAULT_CELL_SIZE);

  // width/height 与 grid 不一致时要拒绝（它们是格数，必须相等）
  const bad = parseMapDocument({ width: 99, height: 40, grid: gridWithWall(60, 40) });
  eq("width 与 grid 列数不一致 → 拒绝", bad.ok, false);
}

console.log("\n[5] 地图层没有运行时换格长的入口");
{
  const core = new GameCore({ cols: 20, rows: 20, seed: 2 });
  const r = core.command({ type: "setCellSize", cell: 24 });
  eq("setCellSize 命令已不存在（被拒）", r.ok, false);
  eq("格长没变", core.map.cellSize, DEFAULT_CELL_SIZE);
}

console.log("\n[6] 夹值");
{
  eq("合法值原样返回", clampCellSize(16), 16);
  eq("太小贴下限", clampCellSize(1), 4);
  eq("太大贴上限", clampCellSize(99999), 256);
  eq("小数取整", clampCellSize(12.6), 13);
  eq("垃圾输入回默认", clampCellSize("abc"), DEFAULT_CELL_SIZE);
  eq("0 回默认", clampCellSize(0), DEFAULT_CELL_SIZE);
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
