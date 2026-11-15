#!/usr/bin/env node
/**
 * 量贴图图集，产出同名 JSON（sprite-atlas sidecar）
 * -----------------------------------------------------------------
 * 用法：
 *   node tools/measure-sprites.mjs public/imgs/frigate2.png
 *   node tools/measure-sprites.mjs public/imgs            # 目录，批量处理 *.png
 *
 * 产出：<同名>.json —— 每格的不透明包围盒。
 *
 * 为什么要离线量、而不是运行时量：
 *   1. 运行时量要在 loadShipAtlas() 里做一次离屏 canvas 往返，还和提亮拷贝混在一起；
 *   2. 度量是**素材的属性**，素材改了重跑工具即可，游戏代码不用动；
 *   3. 运行时零成本，直接读字段。
 *
 * 为什么不用第三方库：项目里没有 PNG 解码依赖，而 Node 自带 zlib，
 * 8 bit RGBA 非交错这一档的 PNG 手写解码只要 80 行。遇到别的格式直接报错。
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join, extname, basename, dirname } from "node:path";

/** 判定"不透明"的 alpha 阈值（和渲染层看齐：>24 才算有内容） */
const ALPHA_THRESHOLD = 24;

export function parseArgs(argv) {
  const out = { paths: [], help: false };
  for (const a of argv) {
    if (a === "-h" || a === "--help") out.help = true;
    else out.paths.push(a);
  }
  return out;
}

/**
 * 解 PNG → { width, height, data: Uint8Array(RGBA) }
 * 只支持 8 bit、colorType 6（RGBA）、非交错。其余明确报错。
 */
export function decodePng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error("不是 PNG 文件");
  }

  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;

    if (type === "IHDR") {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
    } else if (type === "IDAT") {
      idat.push(buf.subarray(dataStart, dataStart + length));
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + length + 4;      // + CRC
  }

  if (bitDepth !== 8) throw new Error(`只支持 8 bit，这张是 ${bitDepth}`);
  if (colorType !== 6) throw new Error(`只支持 RGBA（colorType 6），这张是 ${colorType}`);
  if (interlace !== 0) throw new Error("不支持交错 PNG");

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = new Uint8Array(width * height * bpp);

  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = y * (stride + 1) + 1;
    const rowOut = y * stride;
    const prevOut = rowOut - stride;

    for (let x = 0; x < stride; x++) {
      const cur = raw[rowIn + x];
      const a = x >= bpp ? out[rowOut + x - bpp] : 0;
      const b = y > 0 ? out[prevOut + x] : 0;
      const c = (x >= bpp && y > 0) ? out[prevOut + x - bpp] : 0;

      let v;
      switch (filter) {
        case 0: v = cur; break;
        case 1: v = cur + a; break;
        case 2: v = cur + b; break;
        case 3: v = cur + ((a + b) >> 1); break;
        case 4: v = cur + paeth(a, b, c); break;
        default: throw new Error(`未知的行过滤器 ${filter}`);
      }
      out[rowOut + x] = v & 0xff;
    }
  }

  return { width, height, data: out };
}

/**
 * 按 cell 切格，量每格的不透明包围盒。
 * @param {object} png decodePng 的结果
 * @param {number} cellSize 格边长
 * @param {number} cols
 * @param {number} rows
 */
export function measureFrames(png, cellSize, cols, rows) {
  const { width, height, data } = png;
  const frames = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = c * cellSize, y0 = r * cellSize;
      let minX = cellSize, minY = cellSize, maxX = -1, maxY = -1;
      let opaque = 0;

      for (let y = 0; y < cellSize; y++) {
        const py = y0 + y;
        if (py >= height) break;
        for (let x = 0; x < cellSize; x++) {
          const px = x0 + x;
          if (px >= width) break;
          const alpha = data[((py * width) + px) * 4 + 3];
          if (alpha > ALPHA_THRESHOLD) {
            opaque++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (maxX < 0) {
        frames.push({ index: frames.length, bbox: null, w: 0, h: 0, cx: 0, cy: 0, fill: 0 });
        continue;
      }

      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      const mid = (cellSize - 1) / 2;
      frames.push({
        index: frames.length,
        bbox: [minX, minY, maxX, maxY],
        w, h,
        // 包围盒中心相对"格中心"的偏移，将来做视觉居中要用
        cx: Math.round(((minX + maxX) / 2 - mid) * 100) / 100,
        cy: Math.round(((minY + maxY) / 2 - mid) * 100) / 100,
        fill: Math.round((opaque / (cellSize * cellSize)) * 10000) / 10000
      });
    }
  }

  return frames;
}

/** 一张图 → sidecar 对象 */
export function measureSheet(file, opts = {}) {
  const png = decodePng(readFileSync(file));
  const cellSize = opts.cell ?? 32;

  if (png.width % cellSize !== 0 || png.height % cellSize !== 0) {
    throw new Error(`尺寸 ${png.width}×${png.height} 不是 ${cellSize} 的整数倍`);
  }

  const cols = png.width / cellSize;
  const rows = png.height / cellSize;

  return {
    schema: "sprite-atlas/1",
    image: basename(file),
    width: png.width,
    height: png.height,
    cell: { w: cellSize, h: cellSize, cols, rows },
    alphaThreshold: ALPHA_THRESHOLD,
    frames: measureFrames(png, cellSize, cols, rows)
  };
}

/** 收集一个目录下的所有 png */
function collect(dir) {
  return readdirSync(dir)
    .filter(f => extname(f).toLowerCase() === ".png")
    .map(f => join(dir, f));
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.paths.length === 0) {
    console.log(`量贴图图集，产出同名 JSON

用法：
  node tools/measure-sprites.mjs <png 或目录> [--cell=32]

说明：
  · 只处理 8 bit / RGBA / 非交错 的 PNG，其余会明确报错
  · 输出文件名 = 输入文件名把扩展名换成 .json
  · --cell 默认 32；母舰图集是 128，要显式给`);
    return 1;
  }

  const cellArg = args.paths.find(p => p.startsWith("--cell="));
  const cell = cellArg ? Number(cellArg.split("=")[1]) : 32;
  const targets = args.paths.filter(p => !p.startsWith("--cell="));

  let ok = 0, bad = 0;
  for (const target of targets) {
    let files;
    try {
      files = statSync(target).isDirectory() ? collect(target) : [target];
    } catch (err) {
      console.error(`✗ ${target}：${err.message}`);
      bad++;
      continue;
    }

    for (const file of files) {
      try {
        const doc = measureSheet(file, { cell });
        const out = join(dirname(file), basename(file, extname(file)) + ".json");
        writeFileSync(out, JSON.stringify(doc, null, 2) + "\n", "utf8");

        const used = doc.frames.filter(f => f.w > 0);
        const ws = used.map(f => f.w).sort((a, b) => a - b);
        const empty = doc.frames.length - used.length;
        console.log(
          `✓ ${basename(file)} → ${basename(out)}  ` +
          `${doc.cell.cols}×${doc.cell.rows} 格（空 ${empty}）  ` +
          `bbox 宽 中位 ${ws[ws.length >> 1] ?? 0} / 区间 ${ws[0] ?? 0}~${ws[ws.length - 1] ?? 0}`
        );
        ok++;
      } catch (err) {
        console.error(`✗ ${basename(file)}：${err.message}`);
        bad++;
      }
    }
  }

  console.log(`\n完成：${ok} 张成功${bad ? `，${bad} 张失败` : ""}`);
  return bad === 0 ? 0 : 1;
}

// 只有直接运行时才执行 main（被 import 时只导出函数，方便单测）
if (process.argv[1] && process.argv[1].endsWith("measure-sprites.mjs")) {
  process.exit(main());
}
