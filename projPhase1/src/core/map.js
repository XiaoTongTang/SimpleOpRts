/**
 * 地图数据层
 * -----------------------------------------------------------------
 * 职责：只描述"哪里是墙、哪里是地"，以及把世界坐标换算成格子下标。
 * 不做：碰撞求解、寻路、渲染。那三件事都读本层，但都不改它。
 *
 * ## 唯一的口径（设计见 design/261115_1地图相关测试复盘/05-技术设计-格长即比例尺.md）
 *
 * **格数是权威，世界尺寸是派生量。**
 *
 *   width  = cols × cellSize        （px）
 *   height = rows × cellSize        （px）
 *
 * `cellSize` 是"一格等于多少 PX"，也就是**整张地图的比例尺**：
 * 同一张 250×150 的图，格长 8 → 2000×1200 px；格长 24 → 6000×3600 px。
 * 格子数、墙的格子数据、流场要算的格数**一个都不变**，只是每一格变大。
 *
 * PX 仍是全局唯一的长度单位：单位半径、射程、速度、Couzin 半径都不随格长变，
 * 变的只是"这些东西相对地图有多大"。
 */

/**
 * 默认战场的**格数**（不是 px）。
 * 战斗界面与阵型编辑的预览**必须用同一把尺**，否则同一套 Couzin 参数在两个界面里
 * 会因为"每世界像素占多少屏幕像素"不同而看着不一样快。放这里是为了别再各写一份。
 *
 * 250×150 在格长 8 时正好是老的 2000×1200。
 */
export const DEFAULT_WORLD_COLS = 250;
export const DEFAULT_WORLD_ROWS = 150;

/**
 * 地图格长（px / 格）—— **比例尺的唯一开关，改这一个数就行**。
 *
 * 8 → 24 的意思不是"网格变粗"，而是"整张地图等比放大 3 倍"：
 *   格长 8  ：250×150 格 = 2000×1200 px，单张流场约 7 ms
 *   格长 24 ：250×150 格 = 6000×3600 px，单张流场仍然约 7 ms（格数没变）
 *
 * 所以它调的是**尺度**，不是性能：船还是半径 6~23 px、射程还是 250~480 px、
 * 巡航速度还是 96 px/s，但在一片 3 倍大的战场上它们都"变小"了 3 倍。
 *
 * 换格长的唯一方式就是改这个值然后重新启动（运行时没有换格长的入口）。
 */
export const DEFAULT_CELL_SIZE = 24;

/** 格长的合法区间。只是防手滑，不是玩法参数。 */
export const CELL_SIZE_MIN = 4;
export const CELL_SIZE_MAX = 256;

/** 把任意输入夹成合法格长（取整；超范围贴边，垃圾值回默认） */
export function clampCellSize(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_CELL_SIZE;
  return Math.min(CELL_SIZE_MAX, Math.max(CELL_SIZE_MIN, v));
}

/** 地图格数上限（防的是内存与建场耗时，与"世界多宽"无关） */
export const MAX_MAP_COLS = 1024;
export const MAX_MAP_ROWS = 1024;
export const MAX_MAP_CELLS = 200000;

/** 每次造一张新地图就 +1。流场缓存用它做失效键，保证两张不同的图不会撞 key。 */
let REV = 0;

export class MapGrid {
  /**
   * @param {object} o
   * @param {number} o.cols    列数（权威）
   * @param {number} o.rows    行数（权威）
   * @param {number} o.cellSize 格长（px / 格）
   * @param {Uint8Array} o.walls 1 = 墙，0 = 空地
   * @param {string} [o.name]
   */
  constructor({ cols, rows, cellSize, walls, name }) {
    this.cols = cols;
    this.rows = rows;
    this.cellSize = cellSize;
    this.walls = walls;
    this.name = name || "未命名地图";
    this.rev = ++REV;
  }

  /** 世界宽（px）。派生量，不是独立状态 —— 改格长它就跟着变。 */
  get width() { return this.cols * this.cellSize; }

  /** 世界高（px）。派生量。 */
  get height() { return this.rows * this.cellSize; }

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
 * 由**格数**合成一张空图（只有外框，没有内部墙）。
 * 世界尺寸 = cols × cellSize，由 MapGrid 派生。
 */
export function blankMap(cols, rows, cellSize = DEFAULT_CELL_SIZE, name = "空白地图") {
  const c = Math.max(1, Math.round(cols));
  const r = Math.max(1, Math.round(rows));
  const cs = clampCellSize(cellSize);
  return new MapGrid({
    cols: c, rows: r, cellSize: cs,
    walls: new Uint8Array(c * r),
    name
  });
}

/**
 * 解析地图 JSON
 * -----------------------------------------------------------------
 * 文件格式（与沙盒一致）：
 *
 *   { "name"?: string, "width": 250, "height": 150, "grid": [[0,0,-1], ...] }
 *
 *   - `width` / `height` 是**格数**，不是 px，必须与 `grid` 的列数/行数一致。
 *   - **没有 `cellSize` 字段。** 地图多大由引擎的 `DEFAULT_CELL_SIZE` 决定
 *     （`世界宽 = width × cellSize`）。文件里若写了 `cellSize`，一律忽略。
 *   - `walls` 原样搬进 `MapGrid`，**不重采样**：一格就是一格。
 *
 * @returns {{ok:true, map:MapGrid} | {ok:false, reasons:string[]}}
 */
export function parseMapDocument(data, fallbackName = "导入地图") {
  let grid = null;
  let name = fallbackName;

  if (Array.isArray(data)) {
    grid = data;
  } else if (data && typeof data === "object") {
    grid = data.grid;
    if (typeof data.name === "string" && data.name.trim()) name = data.name.trim();
    if (data.cellSize !== undefined) {
      // 旧文件里可能残留这个字段；它不决定任何东西（地图的"多大"是格数决定的）
      // 这里不报错，只是不采纳。
    }
    if (!Array.isArray(grid)) return fail("JSON 缺少 grid 二维数组。");
  } else {
    return fail("地图 JSON 必须是对象或二维数组。");
  }

  const rows = grid.length;
  const cols = rows > 0 && Array.isArray(grid[0]) ? grid[0].length : 0;

  if (cols < 2 || rows < 2) return fail("地图尺寸至少为 2 × 2 格。");
  if (cols > MAX_MAP_COLS || rows > MAX_MAP_ROWS) {
    return fail(`地图格数超过上限 ${MAX_MAP_COLS} × ${MAX_MAP_ROWS}。`);
  }
  if (cols * rows > MAX_MAP_CELLS) {
    return fail(`地图格数超过上限 ${MAX_MAP_CELLS} 格。`);
  }
  if (data && typeof data === "object") {
    if (data.width !== undefined && Number(data.width) !== cols) {
      return fail("width 与 grid 的列数不一致（width 是格数）。");
    }
    if (data.height !== undefined && Number(data.height) !== rows) {
      return fail("height 与 grid 的行数不一致（height 是格数）。");
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
      cols, rows,
      cellSize: DEFAULT_CELL_SIZE,
      walls,
      name
    })
  };

  function fail(msg) { return { ok: false, reasons: [msg] }; }
}
