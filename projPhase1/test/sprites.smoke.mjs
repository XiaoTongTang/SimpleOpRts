/**
 * 贴图尺度自检（D1 / D2）
 *   node test/sprites.smoke.mjs
 *
 * 两件事：
 *   1. **sidecar 必须和素材一致** —— 换了 png 却没重跑 `pnpm sprites` 时，这条会红。
 *   2. `shipDrawSize` 的公式：贴图里船体的可见宽度必须正好等于 2 × radius
 *      （墙边不穿模、船与船之间的视觉间隙等于 sepRadius，全靠这一条）。
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { measureSheet, decodePng } from "../tools/measure-sprites.mjs";
import { SPRITE_SHEETS, shipDrawSize, FALLBACK_ASPECT } from "../src/core/data/sprite-atlas.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
                          : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const HERE = dirname(fileURLToPath(import.meta.url));
const IMG_DIR = join(HERE, "..", "public", "imgs");

console.log("\n[1] sidecar 存在且与素材一致");
{
  for (const [key, def] of Object.entries(SPRITE_SHEETS)) {
    const png = join(IMG_DIR, def.file);
    const json = join(IMG_DIR, def.file.replace(/\.png$/i, ".json"));

    ok(`${def.file} 存在`, existsSync(png));
    ok(`${key} 的 sidecar 存在`, existsSync(json), json);
    if (!existsSync(json)) continue;

    const doc = JSON.parse(readFileSync(json, "utf8"));
    ok(`${key} sidecar 版本正确`, doc.schema === "sprite-atlas/1", String(doc.schema));
    ok(`${key} 图集尺寸与配置一致`, doc.cell.w === def.cell && doc.cell.cols === def.cols && doc.cell.rows === def.rows,
      `${doc.cell.w}/${doc.cell.cols}×${doc.cell.rows} vs ${def.cell}/${def.cols}×${def.rows}`);
    ok(`${key} 帧数对得上`, doc.frames.length === def.cols * def.rows, String(doc.frames.length));

    // 关键：重新量一遍，必须和提交的 json 一模一样。
    // 换了 png 忘了跑 pnpm sprites 时，这条会红。
    const fresh = measureSheet(png, { cell: def.cell });
    let diff = 0;
    for (let i = 0; i < fresh.frames.length; i++) {
      const a = fresh.frames[i], b = doc.frames[i];
      if (a.w !== b.w || a.h !== b.h) diff++;
    }
    ok(`${key} 的 json 没有过期（重新量结果相同）`, diff === 0, `${diff} 格不一致`);

    // 图片本身的头部尺寸也要和 doc 对上
    const head = decodePng(readFileSync(png));
    ok(`${key} 尺寸 = cell × 行列`,
      head.width === doc.cell.w * doc.cell.cols && head.height === doc.cell.h * doc.cell.rows,
      `${head.width}×${head.height}`);
  }
}

console.log("\n[2] shipDrawSize：可见宽度必须等于 2 × radius");
{
  // 每种情况都用真实 bbox 反推：可见宽度 = size × bboxW / cellW
  const cases = [
    { name: "矛隼 r=6（bbox 18）", r: 6, cellW: 32, bboxW: 18, want: 12 },
    { name: "重锤 r=9（bbox 18）", r: 9, cellW: 32, bboxW: 18, want: 18 },
    { name: "细长帧 r=6（bbox 14）", r: 6, cellW: 32, bboxW: 14, want: 12 },
    { name: "宽帧 r=6（bbox 21）", r: 6, cellW: 32, bboxW: 21, want: 12 },
    { name: "母舰 r=40（cell 128 / bbox 96）", r: 40, cellW: 128, bboxW: 96, want: 80 }
  ];

  for (const c of cases) {
    const size = shipDrawSize(c.r, c.cellW, c.bboxW);
    const visible = size * (c.bboxW / c.cellW);
    ok(`${c.name}：可见宽度 = 2r = ${c.want}`, near(visible, c.want, 1e-6),
      `size=${size.toFixed(2)} 可见=${visible.toFixed(2)}`);
  }
}

console.log("\n[3] 没有 sidecar 时的兜底");
{
  const withMeta = shipDrawSize(6, 32, 18);
  const without = shipDrawSize(6, 32, 0);
  ok("缺 bbox 时退回中位系数", near(without, 2 * 6 * FALLBACK_ASPECT, 1e-9), String(without));
  ok("兜底值与有 bbox 时接近（差 < 5%）", Math.abs(without - withMeta) / withMeta < 0.05,
    `${withMeta.toFixed(2)} vs ${without.toFixed(2)}`);

  ok("缺 cellW 时按 32 算", near(shipDrawSize(6, 0, 18), shipDrawSize(6, 32, 18)));
  ok("hitR 缺失时按 6 算", shipDrawSize(undefined, 32, 18) === shipDrawSize(6, 32, 18));
  ok("不会返回 0 或 NaN", shipDrawSize(6, 32, 18) > 0 && Number.isFinite(shipDrawSize(6, 32, 18)));
}

console.log("\n[4] 尺度对比：新公式 vs 旧的 14 + r×2.6");
{
  const rows = [
    ["矛隼", 6, 18],
    ["壁垒", 6.5, 18],
    ["重锤", 9, 18],
    ["堡垒", 13, 18]
  ];
  const oldSize = r => Math.max(22, Math.min(64, 14 + r * 2.6));
  for (const [name, r, bboxW] of rows) {
    const now = shipDrawSize(r, 32, bboxW);
    const before = oldSize(r);
    const grow = (now / before - 1) * 100;
    ok(`${name}：新 ${now.toFixed(1)}px（旧 ${before.toFixed(1)}px，${grow.toFixed(0)}%）`,
      now > 0 && Number.isFinite(grow));
  }
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
