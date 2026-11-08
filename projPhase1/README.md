# Phase 1 · 分层骨架

> 这是新架构的第一块地基：**core 是唯一真相源，渲染与 UI 都是它的消费者。**
> 设计依据见 [`../design/261107_2机制改进/状态管理与分层边界.md`](../design/261107_2机制改进/状态管理与分层边界.md)

## 跑起来

```bash
pnpm install
pnpm test          # core 冒烟测试（无浏览器，23 项）
pnpm dev           # dev server → http://127.0.0.1:8100/
pnpm build         # 产出 dist/
pnpm preview       # 预览 dist/
pnpm start         # 跑 dist/（先 build）→ 同一个 8100（serve.mjs 有 dist 就用 dist）
```

游戏内操作：

| 操作 | 作用 |
|---|---|
| 左键拖拽 | 框选小队（坐标按相机换算，缩放后一样准） |
| 单击地面 | 给选中的小队下达命令信标 |
| `Shift` + 点击 | 追加选择 |
| 滚轮 | 缩放相机（以鼠标位置为锚点） |
| 中键拖拽 | 平移相机 |
| 右栏顶部小地图 | 点/拖移动视角，双击回到全图 |

> 地图是**固定大小**（2000×1200）的，不跟窗口走；窗口只决定「相机能看到多少」。


标准 Vite CLI，配置只有一份 `vite.config.js`（React 插件 + 多入口 + 端口 8100）。

> **一个环境前提**：Vite 在 Windows 上第一次解析真实路径时会 `exec("net use")` 探测网络盘，
> 受限沙箱禁止起子进程，所以 `vite` 必须在不做进程限制的模式下运行。
> 这与项目配置无关，是宿主环境的事——遇到 `spawn EPERM` 就是跑在了受限模式里。

---

## 目录与职责

```
projPhase1/
├─ index.html                  世界层 <canvas id="c"> + UI 挂载点 <div id="ui-root">
├─ serve.mjs                   40 行静态服务器（无依赖）
├─ src/
│  ├─ main.js                  【组装】唯一主循环：core.step → renderer.draw → bridge.tick
│  ├─ bridge.js                core ⇄ store 的唯一通道（节流快照 / 命令转发）
│  ├─ core/
│  │  ├─ core.js               GameCore：状态 + step + getView + snapshot + command
│  │  ├─ state.js              构筑状态定义（船体、指挥值、模组、校验用的纯函数）
│  │  └─ sim/                  L1/L2 模拟模块（从 prototype/js 原样搬来，零 DOM 依赖）
│  │     ├─ group-layer.js     集群移动
│  │     ├─ squad-layer.js     小队编成 / 重心 / 统一寻敌
│  │     ├─ spatial.js         空间索引 + 扫掠圆命中
│  │     ├─ weapon-system.js   武器系统
│  │     ├─ weapons.js         武器参数表
│  │     ├─ defense-system.js  血量 / 回血 / 护盾充能
│  │     └─ templates.js       阵营模板
│  ├─ render/
│  │  ├─ renderer.js           WorldRenderer 接口（"画什么 vs 用什么画"）
│  │  ├─ render-canvas2d.js    当前唯一实现
│  │  ├─ render-units.js       单位 / 弹丸
│  │  ├─ render-fx.js          特效
│  │  └─ render-structures.js  空间站 / 防御塔（阶段一未使用）
│  ├─ store/
│  │  ├─ createStore.js        极小 store，接口与 Zustand 一致
│  │  └─ gameStore.js          UI 侧数据（只有快照 + 选中项 + 提示）
│  └─ ui/
│     ├─ ui.js                 原生 DOM 面板（将来整体换 React）
│     └─ style.css
└─ test/
   └─ core.smoke.mjs           证明「core 先于 React 存在」
```

---

## 三条纪律（在代码里怎么体现）

### 1. core 不碰任何浏览器 API

`src/core/**` 里搜不到 `document`、`window`、`canvas`、`ctx`、`requestAnimationFrame`。
所以 `test/core.smoke.mjs` 能用 `node` 直接跑完整一局。

### 2. 写入只有一个入口

```js
core.command({ type: "setLoadout", squadId: 0, count: 26 });
// → { ok: true }
// → { ok: false, reasons: ["超出指挥值：需 912，上限 900（超 12）"] }
```

UI 拿到 `reasons` 原样显示，**不自己判断合法性**。因为"超指挥值 / 缺模组"是游戏规则，
复制到 UI 里就等于规则有两份。

### 3. 每帧数据不进 UI

`core.snapshot()` 里没有 `units`、没有 `projectiles`、没有 `fx`。
bridge 以 10 Hz 把快照推给 store；Pixi/Canvas 渲染器则每帧直接读 `core.getView()`，不经过 store。

```
core.getView()  ──每帧──▶  渲染器          （60~240 Hz，不经过 React）
core.snapshot() ──10Hz──▶  store ──▶ UI    （只含 UI 要显示的数字）
UI 操作 ──command──▶ core                   （唯一写入方向）
```

---

## 阶段一已实现

- [x] **命令式写入 + 服务端校验**：超指挥值 / 超模组 / 超单队上限都会被 core 拒绝，并给出可读理由
- [x] **差量应用**：改编制不重建全场，存活单位保留位置与**战损比**（改配置不会满血复活）
- [x] **两档编辑**：`setParam`（改参数，下一帧生效）与 `setLoadout`（改实体，事务式）
- [x] **单一主循环**：rAF 只在 `main.js` 里注册一次，UI 不注册自己的循环
- [x] **存储分层**：store 里只有 `snap / selectedId / fps / msg`
- [x] **无 UI 可运行**：`node test/core.smoke.mjs` 全绿

## 阶段一**没有**做（有意留白）

| 缺口 | 原因 / 何时补 |
|---|---|
| 基地、防御塔、落球机出兵的逻辑 | 属于内容，不属于分层。等架构验证完再搬 |
| Pixi 渲染器 | 依赖已就位（已冒烟验证）；下一步写 `render-pixi.js` |
| React + Zustand 真身接进主应用 | 依赖已就位；下一步换 `ui/` 与 `store/` |
| `fx` 语义化（S2） | 模拟仍在 `fx.push({type:"beam",...})`，这条债留着 |
| 确定性随机（seeded RNG） | 13 处 `Math.random()` 未替换，回放/存档的前置 |

---

## 依赖与工具链

依赖已装好并验证可用：

| 包 | 版本 | 状态 |
|---|---|---|
| react / react-dom | 19.3.1 | ✅ 已装，冒烟页跑通 |
| zustand | 5.1.0 | ✅ 已装，`getState()` 在组件外可读 |
| pixi.js | 8.22.0 | ✅ 已装，WebGL 渲染器可用 |
| vite | 8.3.6 | ✅ 构建 / dev 均通过（需非受限进程模式） |
| @vitejs/plugin-react | 6.2.1 | ✅ JSX 转译正常（oxc，进程内） |

**冒烟页**：`smoke.html` → `http://127.0.0.1:8100/dist/smoke.html`
一个 React 面板 + 一块 Pixi 画布共读同一个 Zustand store，点按钮两边同时变。
它验证的正是正式架构的数据流，验证完可以删。

两个踩过的坑，写在这里省得再踩：

1. **pnpm 的 isolated 布局 + Windows junction 会让 Vite 找不到 `rolldown`。**
   修法：`pnpm-workspace.yaml` 里写 `nodeLinker: hoisted`。
2. **Pixi v8 的 `Color` 不要喂 `"hsl(353,72%,58%)"` 这种 CSS 字符串**——
   解析失败不会报错，只会静默画成黑色。颜色统一用数字 hex（`0x4fa3e8`）。
3. **Vite 需要能起子进程的环境**（见上面"一个环境前提"）。报 `spawn EPERM` 就是跑在了受限模式里，与项目配置无关。

## 为什么主应用现在还是零构建

`index.html → src/main.js` 这条链路是纯 ES 模块，没有 JSX，所以 `pnpm start`
（静态服务）就能跑。Vite 目前只用于 `smoke.html` 的 JSX/依赖打包。

等 UI 换成 React 之后，`pnpm dev` 会成为唯一的启动方式。

| 目标依赖 | 现在的替身 | 替换成本 |
|---|---|---|
| Zustand | `store/createStore.js`（同样 `getState/setState/subscribe`） | 换一行 import |
| React | `ui/ui.js`（原生 DOM） | 整体替换该文件 |
| PixiJS | `render/render-canvas2d.js` | 新增 `render-pixi.js`，`main.js` 换一行 |

三个替身都是按真身接口写的，所以替换是机械动作。

---

## 下一步

1. **换真身**：`store/gameStore.js` → zustand，`ui/ui.js` → React 组件树
2. **写 `render-pixi.js`**：实现同一个 `WorldRenderer`，与 Canvas2D 并存、开关切换
3. **S2**：把 `fx` 从"渲染数据"改成"语义事件"，`RAY_AIM / RAY_FLY` 搬进渲染层
4. 把基地 / 防御塔 / 落球机搬进 core（内容补齐，不动分层）
5. seeded RNG + `RunState` 序列化
