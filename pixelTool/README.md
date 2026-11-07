# pixelTool

一个零依赖的像素画编辑器。**所有编辑能力都挂在 `window.pixelTool` 上**，
所以既可以用鼠标画，也可以被脚本（CDP / 控制台）完全驱动。

## 打开

```powershell
node pixelTool/serve.mjs        # → http://127.0.0.1:8124/
```

直接双击 `index.html` 也能用（没有 ES module，file:// 没问题），
但要用脚本（Chrome DevTools）驱动的话建议起服务。

## 快捷键

| 键 | 作用 |
|---|---|
| `B` / `E` / `G` | 画笔 / 橡皮 / 填充 |
| `L` / `R` / `O` | 直线 / 矩形 / 椭圆 |
| `I` / `M` | 取色 / 矩形选区 |
| 空格 + 拖拽 | 平移画布 |
| 滚轮 | 以光标为中心缩放 |
| 右键 | 擦除 |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 / 重做 |
| `Delete` | 清选区（无选区则清空当前层） |
| `Esc` | 取消选区 |

## 脚本 API（`window.pixelTool`）

### 文档
```js
pixelTool.newDoc(16, 16)            // 新画布（会清空历史）
pixelTool.newDoc(16, 16, palette)   // 同时换调色板
pixelTool.size()                    // { w, h }
pixelTool.state()                   // 完整状态：w/h/frame/layer/zoom/layers/color/sel/undo...
```

### 帧与图层
```js
pixelTool.addFrame()                // 当前帧后面插一帧空白
pixelTool.dupFrame()                // 复制当前帧
pixelTool.delFrame(i?)              // 删帧（默认当前帧）
pixelTool.setFrame(i)

pixelTool.addLayer(name?)           // 当前层上方插一层
pixelTool.delLayer(i?)
pixelTool.setLayer(i)
pixelTool.setLayerVisible(i, bool)
pixelTool.setLayerOpacity(i, 0..1)
pixelTool.renameLayer(i, name)
pixelTool.mergeDown()               // 向下合并
```

### 颜色
```js
pixelTool.setColor("#5fa8e8")
pixelTool.getColor()
pixelTool.setPalette(["#0a0f16", ...])
pixelTool.getPalette()
pixelTool.addPaletteColor("#ff9d8a")
```

### 绘制（写当前帧的当前层）
```js
pixelTool.px(x, y[, color])                 // 单像素
pixelTool.line(x0, y0, x1, y1[, color])     // Bresenham
pixelTool.rect(x, y, w, h[, color])         // 实心矩形
pixelTool.rectLine(x, y, w, h[, color])     // 矩形框
pixelTool.ellipse(cx, cy, rx, ry[, color])  // 实心椭圆
pixelTool.ellipseLine(cx, cy, rx, ry[, c])  // 椭圆框
pixelTool.circle(cx, cy, r[, color])        // 实心圆
pixelTool.circleLine(cx, cy, r[, color])    // 圆环
pixelTool.poly(points[, color])             // 扫描线填充多边形
pixelTool.fill(x, y[, color])               // 油漆桶
pixelTool.clearRect(x, y, w, h)
pixelTool.clear()                           // 清空当前层
pixelTool.drawAscii(rows, map[, {x, y}])    // 字符画（见下）
```

颜色参数省略时用当前色。**所有绘制都是替换语义**（不混合），并在有选区时裁到选区内。

`drawAscii` 是最常用的入口：

```js
pixelTool.drawAscii([
  "..##..",
  ".#..#.",
  "######"
], { "#": "#5fa8e8", ".": null });
```

未在 `map` 里声明的字符、`.` 和空格都当作"跳过"。

### 变换
```js
pixelTool.flipH() / flipV()
pixelTool.rotateCW() / rotateCCW()   // 仅正方形画布
pixelTool.shift(dx, dy)
pixelTool.outline(color)             // 给不透明像素加一圈外描边
pixelTool.replaceColor(from, to)
pixelTool.mapColors(hex => hex)      // 逐色重映射，返回 null = 变透明
```

### 选区
```js
pixelTool.select(x, y, w, h)
pixelTool.selectAll()
pixelTool.deselect()
pixelTool.selection()                // {x,y,w,h} 或 null
pixelTool.fillSel(color)
pixelTool.clearSel()
```

### 历史（批量）
```js
pixelTool.beginBatch()   // 之后的绘制合并成一次撤销
...多次绘制...
pixelTool.endBatch()
pixelTool.undo() / redo()
```

### 视图
```js
pixelTool.zoom(n)                    // 1..64
pixelTool.panBy(dx, dy)
pixelTool.fit({ w, h })              // 适应给定区域并居中
pixelTool.grid(bool) / checker(bool) / onion(bool)
```

### 导出
```js
pixelTool.png(frame?, scale?)        // dataURL，单帧
pixelTool.preview(8)                 // 放大 8 倍的 dataURL，适合直接看
pixelTool.strip(scale?)              // 所有帧横排成一张精灵表 dataURL
pixelTool.download(name?, scale?)    // 触发浏览器下载
pixelTool.downloadStrip(name?)
```

### 事件与存档
```js
pixelTool.onChange(fn)               // 任何改动后回调，返回取消函数
pixelTool._touch()                   // 手动触发重绘

pixelTool.save()                     // 立刻写 localStorage
pixelTool.load()                     // 读回（返回是否成功）
pixelTool.clearSaved()               // 清掉存档
```

改动后 0.6 秒会自动存一次（`localStorage` 键名 `pixelTool.doc.v1`），
刷新页面会自动恢复。要一张干净的新画布就按「新建」，或先 `clearSaved()`。

### UI 层的小钩子（`window.pixelUI`）
```js
pixelUI.setTool("pen")               // pen / eraser / fill / line / rect / rectLine /
                                     // ellipse / ellipseLine / picker / select
pixelUI.setColor("#5fa8e8")
pixelUI.redraw()                     // 强制重画 + 刷新面板
pixelUI.refresh()
```

## 用脚本画一艘 16×16 的船

```js
const P = window.pixelTool;
P.newDoc(16, 16);
P.setPalette(["#0a0f16","#1d2a38","#4a5f75","#dbe6f0",
              "#1b3a5c","#2f6ea8","#5fa8e8","#a8d8ff","#e8f6ff"]);

P.beginBatch();
// 1) 主体
P.drawAscii([
  "................",
  ".......##.......",
  "......####......",
  ".....######.....",
  ".....######.....",
  "....########....",
  "...##########...",
  "..############..",
  "..############..",
  ".##.########.##.",
  ".##....##....##.",
  ".......##.......",
  "................",
  "................",
  "................",
  "................"
], { "#": "#2f6ea8" });
// 2) 高光
P.line(6, 4, 9, 4, "#5fa8e8");
P.line(5, 5, 10, 5, "#5fa8e8");
// 3) 描边
P.outline("#0a0f16");
P.endBatch();

window.pixelUI.redraw();
console.log(P.preview(12));   // dataURL，可直接查看
```

## 已知限制

- 选区内绘制会裁剪，但**变换类操作（flip/rotate/outline…）作用于整层**
- 撤销是整层快照，画布很大（>128×128）时历史会占内存，上限 40 步
- 没有文字工具、没有图层混合模式、不能读回外部 PNG
- 导出只有 PNG（单帧 / 横排精灵表），不做切图 JSON
