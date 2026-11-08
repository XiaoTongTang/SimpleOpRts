/**
 * 确定性自检
 *   node test/determinism.smoke.mjs
 *
 * 目的：保证「同一粒种子 → 同一场战斗」。
 * 这条不成立的话，之后所有平衡调整都只能靠肉眼，改坏了也看不出来。
 */

import { GameCore } from "../src/core/core.js";
import { seedRng, rand } from "../src/core/sim/rng.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => c ? (pass++, console.log(`  ok   ${n}`))
                          : (fail++, console.log(`  FAIL ${n}${e ? "  → " + e : ""}`));

/** 抓一个能代表整局状态的指纹：单位数 + 所有位置/血量的定点化和 */
function fingerprint(core) {
  let h = 0;
  for (const u of core.units) {
    h += Math.round(u.x * 1000) + Math.round(u.y * 1000) * 3
       + Math.round((u.hp || 0) * 1000) * 7 + Math.round((u.shield || 0) * 1000) * 11;
  }
  return {
    n: core.units.length,
    proj: core.projectiles.length,
    hash: h,
    t: Math.round(core.time * 1000)
  };
}

function run(seed, frames = 600) {
  const c = new GameCore({ width: 1280, height: 720, seed });
  for (let i = 0; i < frames; i++) c.step(1 / 60);
  return c;
}

console.log("\n[1] 序列本身");
seedRng(1234);
const a = [rand(), rand(), rand()];
seedRng(1234);
const b = [rand(), rand(), rand()];
ok("同种子同序列", a.join(",") === b.join(","), a + " vs " + b);

seedRng(1235);
const c2 = [rand(), rand(), rand()];
ok("不同种子不同序列", a.join(",") !== c2.join(","));

seedRng(0);
const e1 = rand();
seedRng(0);
ok("种子 0 不退化（仍可复现）", e1 === rand(), String(e1));

console.log("\n[2] 同种子跑 600 帧（10 秒战斗）");
const f1 = fingerprint(run(7));
const f2 = fingerprint(run(7));
ok("单位数一致", f1.n === f2.n, `${f1.n} vs ${f2.n}`);
ok("弹丸数一致", f1.proj === f2.proj, `${f1.proj} vs ${f2.proj}`);
ok("位置与血量哈希一致", f1.hash === f2.hash, `${f1.hash} vs ${f2.hash}`);

console.log("\n[3] 不同种子应当跑出不同结果");
const f3 = fingerprint(run(8));
ok("与 seed=7 不同", f3.hash !== f1.hash, `${f3.hash} vs ${f1.hash}`);

console.log("\n[4] reset 复用种子 → 完全复现");
const core = new GameCore({ width: 1280, height: 720, seed: 99 });
for (let i = 0; i < 300; i++) core.step(1 / 60);
const before = fingerprint(core);
core.reset();
for (let i = 0; i < 300; i++) core.step(1 / 60);
const after = fingerprint(core);
ok("reset 后哈希一致", before.hash === after.hash, `${before.hash} vs ${after.hash}`);
ok("reset 保留 seed", core.seed === 99, String(core.seed));

console.log("\n[5] 换种子后 reset 走出另一条线");
core.reset({ seed: 100 });
for (let i = 0; i < 300; i++) core.step(1 / 60);
ok("与原种子结果不同", fingerprint(core).hash !== before.hash);

console.log("\n[6] sim 层不该再有裸 Math.random");
const { readFileSync, readdirSync } = await import("node:fs");
const dir = new URL("../src/core/", import.meta.url);
let hits = [];
for (const f of readdirSync(dir, { recursive: true })) {
  const p = String(f).replace(/\\/g, "/");
  if (!p.endsWith(".js")) continue;
  const txt = readFileSync(new URL(p, dir), "utf8");
  txt.split("\n").forEach((line, i) => {
    if (line.includes("Math.random") && !line.trim().startsWith("*")) {
      hits.push(`${p}:${i + 1}`);
    }
  });
}
ok("core/ 下无 Math.random", hits.length === 0, hits.join(" "));

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
