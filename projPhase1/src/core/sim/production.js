/**
 * 生产系统
 * -----------------------------------------------------------------
 * 设计见 design/261107_2机制改进/构筑机制设计.md「舰船建造机制」。
 *
 * 模型只有三个概念：
 *   设施 facility  一个阵营的产能来源（母舰 / 造船厂），带「生产线数量」和「生产效率总和」
 *   生产线 line    一条产线有一条队列；队首那艘在造，队尾是排着的
 *   任务 job       一艘待建的船：{ id, squadId, shipId, buildTime, progress }
 *
 * 效率的单位是「工时/分钟」：
 *   一条线分到 10 点效率 = 每分钟干 10 个工时 = 每秒 10/60 工时
 *   所以一艘 10.4 工时的船，在 10 点效率下要 10.4 / (10/60) = 62.4 秒
 *   分到 30 点就是 20.8 秒 —— 这就是设计文档里那个例子的来历
 *
 * 效率总和是硬上限：几条线的分配加起来不能超过它。
 * 这样「多开线并行」和「单线高速」是同一个预算的两种花法，不能白嫖。
 */

/** 一条产线分到多少效率；总和受 facility.efficiencyTotal 限制 */
export function createFacility(faction, { lines = 3, efficiency = 30 } = {}) {
  const n = Math.max(1, lines | 0);
  const total = Math.max(0, Number(efficiency) || 0);
  const each = Math.round((total / n) * 10) / 10;
  const list = [];
  for (let i = 0; i < n; i++) list.push({ alloc: each, queue: [] });
  return { faction, efficiencyTotal: total, lines: list };
}

/** 当前分出去多少效率 */
export function allocatedEff(fac) {
  let s = 0;
  for (const l of fac.lines) s += l.alloc;
  return Math.round(s * 10) / 10;
}

/** 某条产线还要多久造完队首（秒）；空队列返回 0 */
export function lineRemaining(line) {
  const job = line.queue[0];
  if (!job) return 0;
  if (!(line.alloc > 0)) return Infinity;
  return Math.max(0, (job.buildTime - job.progress) / (line.alloc / 60));
}

/** 排队总数 */
export function queuedCount(fac) {
  let n = 0;
  for (const l of fac.lines) n += l.queue.length;
  return n;
}

/**
 * 选一条最短的队列入队。全一样长时选编号最小的，保证确定性。
 * @returns {{line:number, index:number}}
 */
export function enqueue(fac, job) {
  let best = 0, bestLen = Infinity;
  for (let i = 0; i < fac.lines.length; i++) {
    const len = fac.lines[i].queue.length;
    if (len < bestLen) { bestLen = len; best = i; }
  }
  fac.lines[best].queue.push(job);
  return { line: best, index: fac.lines[best].queue.length - 1 };
}

/** 从所有产线里移除某个任务；返回被移除的 job 或 null */
export function cancelJob(fac, jobId) {
  for (const l of fac.lines) {
    const i = l.queue.findIndex(j => j.id === jobId);
    if (i >= 0) return l.queue.splice(i, 1)[0];
  }
  return null;
}

/**
 * 推进一帧。
 * @param onComplete (job) => void  造完一艘时回调（由 core 负责把船放进小队）
 */
export function stepFacility(fac, dt, onComplete) {
  if (!(dt > 0)) return;
  for (const line of fac.lines) {
    const job = line.queue[0];
    if (!job) continue;
    if (!(line.alloc > 0)) continue;

    job.progress += (line.alloc / 60) * dt;

    // 一帧只交付一艘：进度溢出不带入下一艘，避免掉帧时凭空多出几条船
    if (job.progress >= job.buildTime) {
      line.queue.shift();
      if (onComplete) onComplete(job);
    }
  }
}
