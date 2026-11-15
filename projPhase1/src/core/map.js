/**
 * 地图数据层
 * -----------------------------------------------------------------
 * 职责：只描述"哪里是墙、哪里是地"，以及把世界坐标换算成格子下标。
 * 不做：碰撞求解、寻路、渲染。那三件事都读本层，但都不改它。
 *
 * 设计见 design/261114_1鸟群算法迁移/迁移设计.md §3.5。
 *
 * 一条关键约定：
 *   **世界尺寸由地图派生**，但 `width/height` 不强制等于 `cols × cellSize`。
 *   由像素尺寸合成的空图会向上取整格数（cols = ceil(width / cellSize)），
 *   而 `width` 仍保持调用方给的值。这样 `new GameCore({ width: 1000, height: 700 })`
 *   在迁入地图层之后**世界大小一位都不变**（700 不是 8 的倍数，强行取整会变成 704）。
 *   外部 JSON 地图则相反：cols/rows 是权威，width = cols × cellSize。
 */

/**
 * 默认世界尺寸（px）。
 * 战斗界面与阵型编辑的预览**必须用同一把尺**，否则同一套 Couzin 参数在两个界面里
 * 会因为"每世界像素占多少屏幕像素"不同而看着不一样快。放这里是为了别再各写一份。
 */
export const DEFAULT_WORLD_W = 2000;
export const DEFAULT_WORLD_H = 1200;

/** 默认格长（px）。8 是流场代价与碰撞精度的折中，实测见迁移设计 §3.4.4。 */
export const DEFAULT_CELL_SIZE = 8;

/** 地图尺寸上限（防止导入一张离谱的图把内存打爆） */
export const MAX_MAP_COLS = 1024;
export const MAX_MAP_ROWS = 1024;
export const MAX_MAP_CELLS = 200000;

/** 每次造一张新地图就 +1。流场缓存用它做失效键，保证两张不同的图不会撞 key。 */
let REV = 0;

export class MapGrid {
  /**
   * @param {object} o
   * @param {number} o.width   世界宽（px）
   * @param {number} o.height  世界高（px）
   * @param {number} o.cols    列数
   * @param {number} o.rows    行数
   * @param {number} o.cellSize 格长（px）
   * @param {Uint8Array} o.walls 1 = 墙，0 = 空地
   * @param {string} [o.name]
   */
  constructor({ width, height, cols, rows, cellSize, walls, name }) {
    this.width = width;
    this.height = height;
    this.cols = cols;
    this.rows = rows;
    this.cellSize = cellSize;
    this.walls = walls;
    this.name = name || "未命名地图";
    this.rev = ++REV;
  }

  get cellCount() { return this.cols * this.rows; }

  /** 格坐标 → 一维下标（调用方须先保证在界内） */
  index(cx, cy) { return cy * this.cols + cx; }

  /** 世界坐标 → 格坐标（可能越界，调用方自己判断） */
  cellXOf(x) { return Math.floor(x / this.cellSize); }
  cellYOf(y) { return Math.floor(y / this.cellSize); }

  /** 是否墙。**越界一律算墙**，于是"图外"与"墙里"走同一条路径。 */
  isWall(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return true;
    return this.walls[cy * this.cols + cx] === 1;
  }

  isFloor(cx, cy) { return !this.isWall(cx, cy); }

  /** 世界坐标处是不是墙 */
  isWallAt(x, y) { return this.isWall(this.cellXOf(x), this.cellYOf(y)); }

  /** 空地格数 */
  floorCount() {
    let n = 0;
    for (let i = 0; i < this.walls.length; i++) if (this.walls[i] === 0) n++;
    return n;
  }

  /** 找离 (cx,cy) 最近的空地格（BFS 环形扩张），找不到返回 null */
  nearestFloor(cx, cy, maxRadius = 256) {
    if (this.isFloor(cx, cy)) return { cellX: cx, cellY: cy };
    for (let r = 1; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          // 只走这一圈（里圈上一轮已经查过）
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
          if (this.walls[ny * this.cols + nx] === 0) return { cellX: nx, cellY: ny };
        }
      }
    }
    return null;
  }
}

/**
 * 由像素尺寸合成一张空图（只有外框，没有内部墙）。
 * `width/height` 保持调用方给的值；格数向上取整，所以网格可能比世界大不到一格。
 */
export function blankMap(width, height, cellSize = DEFAULT_CELL_SIZE, name = "空白地图") {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const cs = Math.max(1, Math.round(cellSize));
  const cols = Math.max(1, Math.ceil(w / cs));
  const rows = Math.max(1, Math.ceil(h / cs));
  return new MapGrid({
    width: w, height: h, cols, rows, cellSize: cs,
    walls: new Uint8Array(cols * rows),
    name
  });
}

/**
 * 解析地图 JSON
 * -----------------------------------------------------------------
 * 接受两种写法（与沙盒 `parseMapDocument` 一致，沙盒里做过的图可以直接复用）：
 *   1. 二维数组：[[0,0,-1],[0,0,0]]
 *   2. 对象：{ name?, cellSize?, width?, height?, grid: [[...]] }
 * 值只允许 0（空地）或 -1（墙）。
 *
 * @returns {{ok:true, map:MapGrid} | {ok:false, reasons:string[]}}
 */
export function parseMapDocument(data, fallbackName = "导入地图") {
  let grid = null;
  let rows = 0, cols = 0;
  let cellSize = DEFAULT_CELL_SIZE;
  let name = fallbackName;

  if (Array.isArray(data)) {
    grid = data;
  } else if (data && typeof data === "object") {
    grid = data.grid;
    if (typeof data.name === "string" && data.name.trim()) name = data.name.trim();
    if (data.cellSize !== undefined) {
      const cs = Number(data.cellSize);
      if (!Number.isFinite(cs) || cs <= 0) {
        return fail("cellSize 必须是正数。");
      }
      cellSize = Math.round(cs);
    }
    if (!Array.isArray(grid)) return fail("JSON 缺少 grid 二维数组。");
  } else {
    return fail("地图 JSON 必须是对象或二维数组。");
  }

  rows = grid.length;
  cols = rows > 0 && Array.isArray(grid[0]) ? grid[0].length : 0;

  if (cols < 2 || rows < 2) return fail("地图尺寸至少为 2 × 2。");
  if (cols > MAX_MAP_COLS || rows > MAX_MAP_ROWS) {
    return fail(`地图尺寸超过上限 ${MAX_MAP_COLS} × ${MAX_MAP_ROWS}。`);
  }
  if (cols * rows > MAX_MAP_CELLS) {
    return fail(`地图格数超过上限 ${MAX_MAP_CELLS}。`);
  }
  if (data && typeof data === "object") {
    if (data.width !== undefined && Number(data.width) !== cols) {
      return fail("width 与 grid 的列数不一致。");
    }
    if (data.height !== undefined && Number(data.height) !== rows) {
      return fail("height 与 grid 的行数不一致。");
    }
  }

  const walls = new Uint8Array(cols * rows);
  let floors = 0;

  for (let y = 0; y < rows; y++) {
    if (!Array.isArray(grid[y]) || grid[y].length !== cols) {
      return fail(`第 ${y + 1} 行长度与地图列数不一致。`);
    }
    for (let x = 0; x < cols; x++) {
      const v = Number(grid[y][x]);
      if (v === -1) walls[y * cols + x] = 1;
      else if (v === 0) floors++;
      else return fail(`格 (${x}, ${y}) 的值是 ${grid[y][x]}，只允许 0（空地）或 -1（墙）。`);
    }
  }

  if (floors === 0) return fail("地图没有任何空地。");

  return {
    ok: true,
    map: new MapGrid({
      width: cols * cellSize,
      height: rows * cellSize,
      cols, rows, cellSize, walls, name
    })
  };

  function fail(msg) { return { ok: false, reasons: [msg] }; }
}
