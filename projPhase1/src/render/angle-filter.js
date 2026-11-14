/**
 * 朝向低通滤波（IIR）
 * -----------------------------------------------------------------
 * 只做一件事：把"每帧的速度方向"这条噪声很大的信号，压成一条看着顺眼的曲线。
 * **只在渲染层用**，不回写任何模拟状态，所以不影响战斗结果、不破坏确定性。
 *
 * 为什么是一阶 IIR 而不是 1€：
 *   1€ 的截止频率随 |ω| 自适应，理论上更聪明，但它的 3 个参数互相耦合，
 *   在"鸟群这种低频大信号"上容易自激（把抖动当转向、于是放开平滑）。
 *   上一轮实测结论是「效果不行」，已废弃（见 design/261108_…/舰船朝向平滑-1euro滤波（不采用）.md）。
 *
 *   一阶 IIR 只有一个参数，稳态延迟可以解析算出来：
 *
 *       α = 1 − e^(−2π·fc·dt)
 *       稳态滞后 ≈ ω / (2π·fc)   （弧度）
 *
 *   fc = 3 Hz 时 τ = 53 ms，以 180°/s 转向的滞后约 9.5°，肉眼几乎看不出来。
 *
 * 两个必须做对的地方：
 *   1. **先解卷绕**：直接对 atan2 的结果做 EMA，跨 ±π 时会画出一整圈的错误旋转
 *   2. **α 用指数形式**，不用固定系数：这样 60/144/掉帧到 30 Hz 的平滑强度一致
 */

const TAU = Math.PI * 2;

/** 默认截止频率（Hz）。0.8 = 沙盒里实测最平衡的一档 */
export const DEFAULT_CUTOFF_HZ = 0.8;

/** 角度差压到 (−π, π] */
export function wrapAngle(d) {
  return Math.atan2(Math.sin(d), Math.cos(d));
}

export class IirAngle {
  /**
   * @param {number} cutoffHz 截止频率（Hz）
   */
  constructor(cutoffHz = DEFAULT_CUTOFF_HZ) {
    this.init = false;
    this.last = 0;        // 上一帧的原始角度（未展开）
    this.unwrapped = 0;   // 累计展开角
    this.out = 0;         // 滤波结果（展开坐标系下的角度）
    this.setCutoff(cutoffHz);
  }

  setCutoff(hz) {
    const safe = Number.isFinite(hz) && hz > 0 ? hz : DEFAULT_CUTOFF_HZ;
    this.k = TAU * safe;
  }

  /** 丢掉历史，下一帧重新从原始角度起步 */
  reset(angle) {
    this.init = false;
    if (Number.isFinite(angle)) this.prime(angle);
    return this.out;
  }

  prime(angle) {
    this.init = true;
    this.last = angle;
    this.unwrapped = angle;
    this.out = angle;
    return this.out;
  }

  /**
   * 喂一帧样本。
   * @param {number} angle 原始角度（弧度，atan2 的结果）
   * @param {number} dt    这一帧的**真实**时长（秒）
   * @returns {number} 滤波后的展开角（可以跨多圈，调用方直接拿去旋转）
   */
  update(angle, dt) {
    if (!Number.isFinite(angle)) return this.out;
    if (!this.init) return this.prime(angle);

    // 1) 解卷绕：把 ±π 的跳变变成连续增量
    this.unwrapped += wrapAngle(angle - this.last);
    this.last = angle;

    // 2) 一阶低通（指数 α，天然与帧率无关）
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const alpha = 1 - Math.exp(-this.k * step);
    this.out += (this.unwrapped - this.out) * alpha;

    return this.out;
  }
}

/**
 * 按单位对象存滤波状态。
 *
 * 存在**单位**上而不是精灵上：精灵池是按顺序复用的，船死了之后新船会顶替同一个精灵，
 * 把状态挂在精灵上会让新船继承一艘死船的朝向（阶段一的老 bug）。
 */
export class AngleFilterBank {
  constructor(cutoffHz = DEFAULT_CUTOFF_HZ) {
    this.cutoffHz = cutoffHz;
    this.map = new WeakMap();
    this.enabled = true;
  }

  /** 某个单位的滤波器（懒创建） */
  of(unit) {
    let f = this.map.get(unit);
    if (!f) {
      f = new IirAngle(this.cutoffHz);
      this.map.set(unit, f);
    }
    return f;
  }

  /**
   * 取这一帧该用的朝向。
   * @param {object} unit
   * @param {number} rawAngle 原始朝向（atan2 的结果）
   * @param {number} dt
   */
  filter(unit, rawAngle, dt) {
    if (!this.enabled) return rawAngle;
    return this.of(unit).update(rawAngle, dt);
  }

  setCutoff(hz) {
    this.cutoffHz = hz;
    this.map = new WeakMap();          // 换频率就重来，免得新旧状态混在一起
  }
}
