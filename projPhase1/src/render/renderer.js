/**
 * 渲染层接口（世界层）
 * -----------------------------------------------------------------
 * 目标：把「战场画什么」和「用什么画」分开。将来换成 PixiJS / WebGL
 * 只需要再写一个继承 WorldRenderer 的实现，模拟层、UI 层一行不用动。
 *
 * 三条硬规矩（和空间索引层是同一个思路）：
 *   1. **只读 view** —— 渲染器不许回写任何游戏状态，也不许保存对数组的引用
 *      （下一帧这些数组可能被就地增删，UI 层只做投影，不做真相源）
 *   2. **不碰 ctx** —— 接口里没有 CanvasRenderingContext2D 字样，
 *      Pixi 实现自己管 GL 上下文
 *   3. **不读配置** —— 色相、半径这些都由调用方写进数据对象里
 *      （基地/塔自带 hue 和 radius），渲染器不需要 import 游戏参数表
 *
 * view 的形状见下方 RenderView。战场坐标系：单位坐标原点是战场左上角，
 * 屏幕 = 世界 * camera.zoom + camera.o{x,y}。
 *
 * 注意：UI 层（侧栏、战况行、按钮、胜负提示）**不在**这层里。
 * 它现在画在另一张 canvas 上，将来会变成 React + DOM。
 */

/**
 * @typedef {Object} RenderView
 * @property {number} width   屏幕宽（CSS px）
 * @property {number} height  屏幕高（CSS px）
 * @property {{ox:number, oy:number, zoom:number}} camera   世界→屏幕
 * @property {{w:number, h:number}} world                   战场世界尺寸（画边框）
 * @property {Array}  bases        [{ faction, hue, radius, x, y, hp, maxHp, dead, pulse }]
 * @property {Array}  towers       [{ faction, hue, radius, x, y, hp, maxHp, dead, pulse }]
 * @property {Array}  units        全部单位（只读）
 * @property {Array}  squads       小队表（只读）
 * @property {Array}  fx           特效（只读）
 * @property {Array}  projectiles  飞行弹（只读）
 */

/** 渲染器基类：所有实现都继承它，方便类型收敛与集中文档 */
export class WorldRenderer {
  /** 屏幕尺寸变化（CSS px）。实现方自己负责画布尺寸 / 后处理缓冲 */
  resize(width, height) {          // eslint-disable-line no-unused-vars
    throw new Error("WorldRenderer.resize 未实现");
  }

  /** 画一帧战场。view 只读 */
  draw(view) {                     // eslint-disable-line no-unused-vars
    throw new Error("WorldRenderer.draw 未实现");
  }

  /** 释放资源（Pixi 实现要 destroy 掉 renderer / 纹理引用） */
  destroy() {}
}
