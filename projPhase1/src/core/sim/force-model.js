/**
 * 力模型（质量速度模型）
 * -----------------------------------------------------------------
 * 从沙盒 `couzin质量模型-流场寻路-每鸟半径.js` 的 `stepSimulation()` 搬来，
 * 拆成纯函数，方便单测与 A/B。
 *
 * 与旧的「软化 Couzin」的根本区别：
 *   旧：每个力写成 `w · (v_目标 − v)`，w 的单位是 1/s —— 是**速度配平**，内禀带阻尼；
 *   新：每个力写成 `F`，单位是 px/s²，彼此**直接相加**，收敛全靠 `damping`。
 *
 * 三个安全阀（沙盒里只有前两个）：
 *   1. SEP_MAX_WEIGHT  单个邻居的分离权重封顶
 *   2. maxSpeedFactor  速度上限
 *   3. G.mass          力的总缩放（默认 1，迁移本身不改变任何东西）
 */

/** 分离权重的下限间隙：贴到完全重合时权重会爆到无穷 */
export const SEP_MIN_GAP = 1;

/** 单个邻居的分离权重上限（25 对应间隙 = sepRadius/5） */
export const SEP_MAX_WEIGHT = 25;

/**
 * 分离权重：w = (sepRadius / gap)²，封顶 SEP_MAX_WEIGHT。
 *
 * gap 是**表面间隙** d − (r_i + r_j)，不是圆心距。
 * 间隙等于 sepRadius 时 w = 1（刚进入分离区）；
 * 间隙减半时 w = 4（四次方级别的陡升，这是"挤不进去"的来源）。
 */
export function sepWeight(gap, sepRadius) {
  const g = gap >= SEP_MIN_GAP ? gap : SEP_MIN_GAP;
  const w = (sepRadius * sepRadius) / (g * g);
  return w > SEP_MAX_WEIGHT ? SEP_MAX_WEIGHT : w;
}

/** 标准三次平滑插值，与旧模型同一口径（战斗参数组的权重核用） */
export function smoothstep(a, b, x) {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a || 1e-6);
  return t * t * (3 - 2 * t);
}

/**
 * 积分一个单位的速度。
 *
 *   v += (F / mass) · dt
 *   v *= e^(−damping·dt)
 *   |v| 夹到 refSpeed × maxSpeedFactor
 *
 * **只算速度，不算位置** —— 位置由 `wall-collision.moveUnitWithWalls()` 推进，
 * 因为它要沿途处理墙体（子步进 + 推出）。把位置积分留在这里会让两者打架。
 *
 * 注意这里**没有**加速度上限。旧模型靠 `MAX_ACCEL = 430` 兜底，新模型的稳定性来自
 * 阻尼与 `SEP_MAX_WEIGHT`，再夹一次加速度会把"分离力突然变大"这件事吃掉。
 */
export function integrateUnit(u, fx, fy, G, dt, refSpeed) {
  // 有效质量 = 每单位质量 × 全局质量。两者默认都是 1，迁移本身不改变任何东西。
  const um = u.mass > 0 ? u.mass : 1;
  const gm = G.mass > 0 ? G.mass : 1;
  const m = um * gm;

  u.vx += (fx / m) * dt;
  u.vy += (fy / m) * dt;

  const damping = G.damping > 0 ? G.damping : 0;
  if (damping > 0) {
    const damp = Math.exp(-damping * dt);
    u.vx *= damp;
    u.vy *= damp;
  }

  const factor = G.maxSpeedFactor > 0 ? G.maxSpeedFactor : 1;
  const cap = refSpeed * factor;
  const sp = Math.hypot(u.vx, u.vy);
  if (sp > cap && sp > 1e-9) {
    const k = cap / sp;
    u.vx *= k;
    u.vy *= k;
  }
}

/**
 * 更新朝向单位向量（对齐与低速助推都用它，而不是 `atan2(vx, vy)`）。
 * 速度趋零时保留上一次的朝向 —— 这正是"静止的船不会乱转"的来源。
 */
export function updateHeading(u) {
  const sp = Math.hypot(u.vx, u.vy);
  if (sp > 1e-9) {
    u.hx = u.vx / sp;
    u.hy = u.vy / sp;
  } else if (u.hx === undefined) {
    u.hx = 1;
    u.hy = 0;
  }
}

/**
 * 对齐力：目标是"邻居平均朝向"与自身朝向的差，幅值 = alignForce。
 * 返回 [fx, fy]；邻居朝向互相抵消时返回 null（没有共识方向）。
 */
export function alignForce(aliX, aliY, u, alignForceMag) {
  const L = Math.hypot(aliX, aliY);
  if (L <= 1e-9) return null;
  return [
    alignForceMag * (aliX / L - u.hx),
    alignForceMag * (aliY / L - u.hy)
  ];
}

/**
 * 凝聚力：方向归一、**幅值恒定**。
 * 这是"凝聚力与距离无关"的来源 —— 归一化之后 cohForce 就是全部。
 */
export function cohesionForce(cohX, cohY, cohForceMag) {
  const L = Math.hypot(cohX, cohY);
  if (L <= 1e-9) return null;
  return [cohForceMag * (cohX / L), cohForceMag * (cohY / L)];
}
