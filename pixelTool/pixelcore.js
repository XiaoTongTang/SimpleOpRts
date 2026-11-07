/**
 * pixelcore.js —— 像素画文档模型 + 脚本 API
 * -----------------------------------------------------------------
 * 全部能力挂在 window.pixelTool 上，方便通过 CDP / 控制台直接驱动：
 *   pixelTool.newDoc(16, 16)
 *   pixelTool.setColor("#5fa8e8")
 *   pixelTool.drawAscii(["..##..", ".#..#."], { "#": "#5fa8e8" })
 *   pixelTool.preview(12)     // 返回 dataURL，可直接看
 *
 * 数据模型：
 *   doc = { w, h, palette[], frames[] }
 *   frame = { layers[] }
 *   layer = { name, visible, opacity, data: Uint8ClampedArray(w*h*4) }
 *
 * 约定：
 *   · 所有绘制都是**替换**语义（不混合），像素画要的就是这个
 *   · 坐标为整数像素，越界自动裁掉
 *   · 有选区时，绘制被裁到选区内
 */
(function (global) {
  "use strict";

  // ---------------------------------------------------------------
  // 默认调色板（和 design/261107_1画面升级 的规则一致：中性 4 + 蓝 5 + 红 5）
  // ---------------------------------------------------------------
  const DEFAULT_PALETTE = [
    "#0a0f16", "#1d2a38", "#4a5f75", "#dbe6f0",
    "#1b3a5c", "#2f6ea8", "#5fa8e8", "#a8d8ff", "#e8f6ff",
    "#4a1e1e", "#8f3a32", "#e8614f", "#ff9d8a", "#ffe0d8"
  ];

  const S = {
    w: 32, h: 32,
    frames: [],
    frame: 0,
    layer: 0,
    palette: DEFAULT_PALETTE.slice(),
    color: "#5fa8e8",
    sel: null,             // {x,y,w,h} 或 null
    zoom: 10,
    pan: { x: 0, y: 0 },
    grid: true,
    checker: true,
    onion: false,
    dirty: true
  };

  const listeners = [];
  const undoStack = [];
  const redoStack = [];
  const UNDO_MAX = 40;

  // ---------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------
  function hexToRGBA(hex) {
    if (!hex) return [0, 0, 0, 0];
    let s = String(hex).trim().replace(/^#/, "");
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    const r = parseInt(s.slice(0, 2), 16) || 0;
    const g = parseInt(s.slice(2, 4), 16) || 0;
    const b = parseInt(s.slice(4, 6), 16) || 0;
    const a = s.length >= 8 ? (parseInt(s.slice(6, 8), 16) || 0) : 255;
    return [r, g, b, a];
  }

  function rgbaToHex(r, g, b, a) {
    const h = n => n.toString(16).padStart(2, "0");
    return "#" + h(r) + h(g) + h(b) + (a === 255 ? "" : h(a));
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function makeLayer(name, w, h) {
    return { name: name, visible: true, opacity: 1, data: new Uint8ClampedArray(w * h * 4) };
  }

  function cloneData(d) { return new Uint8ClampedArray(d); }

  function curFrame() { return S.frames[S.frame]; }
  function curLayer() { const f = curFrame(); return f ? f.layers[S.layer] : null; }

  function inSel(x, y) {
    const s = S.sel;
    if (!s) return true;
    return x >= s.x && y >= s.y && x < s.x + s.w && y < s.y + s.h;
  }

  // ---------------------------------------------------------------
  // 变更通知 / 历史
  // ---------------------------------------------------------------
  function touch() {
    S.dirty = true;
    for (const fn of listeners) {
      try { fn(); } catch (e) { console.error(e); }
    }
    scheduleSave();
  }

  // ---------------------------------------------------------------
  // 自动存档（localStorage）
  // ---------------------------------------------------------------
  const SAVE_KEY = "pixelTool.doc.v1";
  let saveTimer = 0;
  let loading = false;

  function b64(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i += 8192) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 8192, u8.length)));
    }
    return btoa(s);
  }

  function unb64(str) {
    const bin = atob(str);
    const u8 = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function serialize() {
    return JSON.stringify({
      v: 1, w: S.w, h: S.h, palette: S.palette, color: S.color,
      frame: S.frame, layer: S.layer,
      frames: S.frames.map(f => ({
        layers: f.layers.map(l => ({ name: l.name, visible: l.visible, opacity: l.opacity, data: b64(l.data) }))
      }))
    });
  }

  function scheduleSave() {
    if (loading) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(SAVE_KEY, serialize()); } catch (e) { /* 超配额就放弃 */ }
    }, 600);
  }

  function save() {
    try { localStorage.setItem(SAVE_KEY, serialize()); return true; } catch (e) { return false; }
  }

  function load() {
    let raw;
    try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    try {
      const d = JSON.parse(raw);
      loading = true;
      S.w = d.w; S.h = d.h;
      S.palette = d.palette || S.palette;
      S.color = d.color || S.color;
      S.frames = d.frames.map(f => ({
        layers: f.layers.map(l => ({ name: l.name, visible: l.visible, opacity: l.opacity, data: unb64(l.data) }))
      }));
      S.frame = clamp(d.frame || 0, 0, S.frames.length - 1);
      S.layer = clamp(d.layer || 0, 0, S.frames[S.frame].layers.length - 1);
      S.sel = null;
      undoStack.length = 0; redoStack.length = 0;
      loading = false;
      touch();
      return true;
    } catch (e) {
      loading = false;
      return false;
    }
  }

  function clearSaved() {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
    return api;
  }

  function snapLayer() {
    if (batch > 0) return;          // 批次内只由 beginBatch 快照一次
    snapLayerNow();
  }

  function snapLayerNow() {
    const l = curLayer();
    if (!l) return;
    undoStack.push({ kind: "layer", frame: S.frame, layer: S.layer, data: cloneData(l.data) });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;
  }

  // 批次：把一串绘制合并成一次撤销（笔刷描边、脚本连续画图都用它）
  let batch = 0;
  function beginBatch() {
    if (batch === 0) snapLayerNow();
    batch++;
    return api;
  }
  function endBatch() {
    batch = Math.max(0, batch - 1);
    if (batch === 0) touch();
    return api;
  }

  function snapDoc() {
    undoStack.push({
      kind: "doc",
      doc: {
        w: S.w, h: S.h,
        frame: S.frame, layer: S.layer,
        frames: S.frames.map(f => ({
          layers: f.layers.map(l => ({ name: l.name, visible: l.visible, opacity: l.opacity, data: cloneData(l.data) }))
        }))
      }
    });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;
  }

  function restoreEntry(e) {
    if (e.kind === "layer") {
      const f = S.frames[e.frame];
      if (!f || !f.layers[e.layer]) return;
      f.layers[e.layer].data.set(e.data);
    } else {
      S.w = e.doc.w; S.h = e.doc.h;
      S.frames = e.doc.frames.map(f => ({
        layers: f.layers.map(l => ({ name: l.name, visible: l.visible, opacity: l.opacity, data: cloneData(l.data) }))
      }));
      S.frame = clamp(e.doc.frame, 0, S.frames.length - 1);
      S.layer = clamp(e.doc.layer, 0, curFrame().layers.length - 1);
    }
  }

  function undo() {
    batch = 0;
    const e = undoStack.pop();
    if (!e) return false;
    // 记录当前状态以便 redo
    const l = curLayer();
    if (e.kind === "layer" && l) redoStack.push({ kind: "layer", frame: S.frame, layer: S.layer, data: cloneData(l.data) });
    else redoStack.push({
      kind: "doc",
      doc: {
        w: S.w, h: S.h, frame: S.frame, layer: S.layer,
        frames: S.frames.map(f => ({ layers: f.layers.map(x => ({ name: x.name, visible: x.visible, opacity: x.opacity, data: cloneData(x.data) })) }))
      }
    });
    restoreEntry(e);
    touch();
    return true;
  }

  function redo() {
    const e = redoStack.pop();
    if (!e) return false;
    undoStack.push({
      kind: e.kind === "layer" ? "layer" : "doc",
      ...(e.kind === "layer"
        ? { frame: e.frame, layer: e.layer, data: cloneData(curLayer().data) }
        : { doc: { w: S.w, h: S.h, frame: S.frame, layer: S.layer, frames: S.frames.map(f => ({ layers: f.layers.map(x => ({ name: x.name, visible: x.visible, opacity: x.opacity, data: cloneData(x.data) })) })) } })
    });
    restoreEntry(e);
    touch();
    return true;
  }

  // ---------------------------------------------------------------
  // 绘制原语（写当前层）
  // ---------------------------------------------------------------
  function put(x, y, rgba) {
    const l = curLayer();
    if (!l) return;
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= S.w || y >= S.h) return;
    if (!inSel(x, y)) return;
    const i = (y * S.w + x) * 4;
    l.data[i] = rgba[0]; l.data[i + 1] = rgba[1]; l.data[i + 2] = rgba[2]; l.data[i + 3] = rgba[3];
  }

  function px(x, y, color) {
    snapLayer();
    put(x, y, color ? hexToRGBA(color) : hexToRGBA(S.color));
    touch();
    return api;
  }

  function line(x0, y0, x1, y1, color) {
    snapLayer();
    const c = color ? hexToRGBA(color) : hexToRGBA(S.color);
    bresenham(x0, y0, x1, y1, (x, y) => put(x, y, c));
    touch();
    return api;
  }

  function bresenham(x0, y0, x1, y1, cb) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      cb(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  function rect(x, y, w, h, color, outlineOnly) {
    snapLayer();
    const c = color ? hexToRGBA(color) : hexToRGBA(S.color);
    const x2 = x + w - 1, y2 = y + h - 1;
    for (let yy = y; yy <= y2; yy++) {
      for (let xx = x; xx <= x2; xx++) {
        if (outlineOnly && xx !== x && xx !== x2 && yy !== y && yy !== y2) continue;
        put(xx, yy, c);
      }
    }
    touch();
    return api;
  }

  function ellipse(cx, cy, rx, ry, color, outlineOnly) {
    snapLayer();
    const c = color ? hexToRGBA(color) : hexToRGBA(S.color);
    // 中点椭圆：内外判定用归一化距离
    const r = Math.max(rx, ry);
    for (let yy = Math.floor(cy - ry); yy <= Math.ceil(cy + ry); yy++) {
      for (let xx = Math.floor(cx - rx); xx <= Math.ceil(cx + rx); xx++) {
        const nx = (xx - cx) / (rx || 1), ny = (yy - cy) / (ry || 1);
        const d = nx * nx + ny * ny;
        if (d > 1.0) continue;
        if (outlineOnly && d < 0.55) continue;
        put(xx, yy, c);
      }
    }
    touch();
    return api;
  }

  function poly(pts, color) {
    if (!pts || pts.length < 3) return api;
    snapLayer();
    const c = color ? hexToRGBA(color) : hexToRGBA(S.color);
    // 扫描线填充
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
    minY = Math.max(0, Math.floor(minY)); maxY = Math.min(S.h - 1, Math.ceil(maxY));
    for (let y = minY; y <= maxY; y++) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
          xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
        }
      }
      xs.sort((m, n) => m - n);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++) put(x, y, c);
      }
    }
    touch();
    return api;
  }

  function floodFill(x, y, color) {
    const l = curLayer();
    if (!l) return api;
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= S.w || y >= S.h) return api;
    const target = [l.data[(y * S.w + x) * 4], l.data[(y * S.w + x) * 4 + 1], l.data[(y * S.w + x) * 4 + 2], l.data[(y * S.w + x) * 4 + 3]];
    const c = color ? hexToRGBA(color) : hexToRGBA(S.color);
    if (target[0] === c[0] && target[1] === c[1] && target[2] === c[2] && target[3] === c[3]) return api;

    snapLayer();
    const stack = [[x, y]];
    const seen = new Uint8Array(S.w * S.h);
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (cx < 0 || cy < 0 || cx >= S.w || cy >= S.h) continue;
      if (!inSel(cx, cy)) continue;
      const i = cy * S.w + cx;
      if (seen[i]) continue;
      seen[i] = 1;
      const j = i * 4;
      if (l.data[j] !== target[0] || l.data[j + 1] !== target[1] || l.data[j + 2] !== target[2] || l.data[j + 3] !== target[3]) continue;
      put(cx, cy, c);
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
    touch();
    return api;
  }

  function clearRect(x, y, w, h) {
    snapLayer();
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(xx, yy, [0, 0, 0, 0]);
    touch();
    return api;
  }

  function clearLayer() {
    const l = curLayer();
    if (!l) return api;
    snapLayer();
    l.data.fill(0);
    touch();
    return api;
  }

  // ---------------------------------------------------------------
  // 字符画：一条命令画一整张图（最常用的入口）
  //   drawAscii(["..##", ".##."], { "#": "#5fa8e8", ".": null })
  // ---------------------------------------------------------------
  function drawAscii(rows, map, opts) {
    opts = opts || {};
    const ox = opts.x || 0, oy = opts.y || 0;
    const l = curLayer();
    if (!l) return api;
    snapLayer();
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        let hex;
        if (map && Object.prototype.hasOwnProperty.call(map, ch)) hex = map[ch];
        else if (ch === "." || ch === " ") hex = null;
        else hex = null;
        if (!hex) continue;
        put(ox + x, oy + y, hexToRGBA(hex));
      }
    }
    touch();
    return api;
  }

  // ---------------------------------------------------------------
  // 变换
  // ---------------------------------------------------------------
  function flipH() {
    const l = curLayer(); if (!l) return api;
    snapLayer();
    const d = l.data, w = S.w, h = S.h;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < Math.floor(w / 2); x++) {
        const a = (y * w + x) * 4, b = (y * w + (w - 1 - x)) * 4;
        for (let k = 0; k < 4; k++) { const t = d[a + k]; d[a + k] = d[b + k]; d[b + k] = t; }
      }
    }
    touch();
    return api;
  }

  function flipV() {
    const l = curLayer(); if (!l) return api;
    snapLayer();
    const d = l.data, w = S.w, h = S.h;
    for (let y = 0; y < Math.floor(h / 2); y++) {
      for (let x = 0; x < w; x++) {
        const a = (y * w + x) * 4, b = ((h - 1 - y) * w + x) * 4;
        for (let k = 0; k < 4; k++) { const t = d[a + k]; d[a + k] = d[b + k]; d[b + k] = t; }
      }
    }
    touch();
    return api;
  }

  function rotate(dir) {          // dir: 1 顺时针, -1 逆时针（仅正方形画布）
    if (S.w !== S.h) return { ok: false, error: "旋转只支持正方形画布" };
    const l = curLayer(); if (!l) return api;
    snapLayer();
    const w = S.w, src = cloneData(l.data), out = l.data;
    const turn = (x, y) => dir > 0 ? [w - 1 - y, x] : [y, w - 1 - x];
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const [nx, ny] = turn(x, y);
        const a = (y * w + x) * 4, b = (ny * w + nx) * 4;
        out[b] = src[a]; out[b + 1] = src[a + 1]; out[b + 2] = src[a + 2]; out[b + 3] = src[a + 3];
      }
    }
    touch();
    return api;
  }

  function shift(dx, dy) {
    const l = curLayer(); if (!l) return api;
    snapLayer();
    const w = S.w, h = S.h, src = cloneData(l.data), d = l.data;
    d.fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const a = (y * w + x) * 4, b = (ny * w + nx) * 4;
        d[b] = src[a]; d[b + 1] = src[a + 1]; d[b + 2] = src[a + 2]; d[b + 3] = src[a + 3];
      }
    }
    touch();
    return api;
  }

  /** 给当前层的不透明像素加一圈外描边 */
  function outline(color, opts) {
    const l = curLayer(); if (!l) return api;
    opts = opts || {};
    const c = hexToRGBA(color || "#0a0f16");
    snapLayer();
    const w = S.w, h = S.h, src = cloneData(l.data), d = l.data;
    const opaque = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
      return src[(y * w + x) * 4 + 3] > 0;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (opaque(x, y)) continue;
        if (!opaque(x - 1, y) && !opaque(x + 1, y) && !opaque(x, y - 1) && !opaque(x, y + 1)) continue;
        if (!inSel(x, y)) continue;
        const i = (y * w + x) * 4;
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3];
      }
    }
    touch();
    return api;
  }

  function replaceColor(from, to) {
    const l = curLayer(); if (!l) return api;
    snapLayer();
    const a = hexToRGBA(from), b = hexToRGBA(to);
    const d = l.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === a[0] && d[i + 1] === a[1] && d[i + 2] === a[2] && d[i + 3] === a[3]) {
        d[i] = b[0]; d[i + 1] = b[1]; d[i + 2] = b[2]; d[i + 3] = b[3];
      }
    }
    touch();
    return api;
  }

  /** 逐像素颜色重映射：fn(hex) -> hex | null（null = 置空） */
  function mapColors(fn) {
    const l = curLayer(); if (!l) return api;
    snapLayer();
    const d = l.data;
    const cache = new Map();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const hex = rgbaToHex(d[i], d[i + 1], d[i + 2], d[i + 3]);
      let out;
      if (cache.has(hex)) out = cache.get(hex);
      else { out = fn(hex); cache.set(hex, out); }
      if (out === null || out === undefined) { d[i + 3] = 0; continue; }
      const c = hexToRGBA(out);
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3];
    }
    touch();
    return api;
  }

  // ---------------------------------------------------------------
  // 选区
  // ---------------------------------------------------------------
  const sel = {
    set(x, y, w, h) { S.sel = (w > 0 && h > 0) ? { x: x | 0, y: y | 0, w: w | 0, h: h | 0 } : null; touch(); return api; },
    get() { return S.sel ? { ...S.sel } : null; },
    all() { S.sel = { x: 0, y: 0, w: S.w, h: S.h }; touch(); return api; },
    clear() { S.sel = null; touch(); return api; },
    fill(color) {
      if (!S.sel) return api;
      return rect(S.sel.x, S.sel.y, S.sel.w, S.sel.h, color);
    },
    clearPixels() {
      if (!S.sel) return api;
      return clearRect(S.sel.x, S.sel.y, S.sel.w, S.sel.h);
    }
  };

  // ---------------------------------------------------------------
  // 文档 / 帧 / 层
  // ---------------------------------------------------------------
  function newDoc(w, h, palette) {
    S.w = Math.max(1, w | 0); S.h = Math.max(1, h | 0);
    S.frames = [{ layers: [makeLayer("图层 1", S.w, S.h)] }];
    S.frame = 0; S.layer = 0; S.sel = null;
    if (palette && palette.length) S.palette = palette.slice();
    undoStack.length = 0; redoStack.length = 0;
    touch();
    return api;
  }
  function addFrame(dup) {
    snapDoc();
    const cur = S.frames[S.frame];
    const layers = cur.layers.map(l => ({
      name: l.name, visible: l.visible, opacity: l.opacity,
      data: dup ? cloneData(l.data) : new Uint8ClampedArray(S.w * S.h * 4)
    }));
    S.frames.splice(S.frame + 1, 0, { layers });
    S.frame += 1;
    S.layer = clamp(S.layer, 0, S.frames[S.frame].layers.length - 1);
    touch();
    return api;
  }

  function delFrame(i) {
    if (S.frames.length <= 1) return api;
    snapDoc();
    const idx = i === undefined ? S.frame : i;
    S.frames.splice(idx, 1);
    S.frame = clamp(S.frame, 0, S.frames.length - 1);
    S.layer = clamp(S.layer, 0, S.frames[S.frame].layers.length - 1);
    touch();
    return api;
  }

  function setFrame(i) {
    S.frame = clamp(i | 0, 0, S.frames.length - 1);
    S.layer = clamp(S.layer, 0, S.frames[S.frame].layers.length - 1);
    touch();
    return api;
  }

  function addLayer(name) {
    snapDoc();
    const f = curFrame();
    f.layers.splice(S.layer + 1, 0, makeLayer(name || ("图层 " + (f.layers.length + 1)), S.w, S.h));
    S.layer += 1;
    touch();
    return api;
  }

  function delLayer(i) {
    const f = curFrame();
    if (f.layers.length <= 1) return api;
    snapDoc();
    f.layers.splice(i === undefined ? S.layer : i, 1);
    S.layer = clamp(S.layer, 0, f.layers.length - 1);
    touch();
    return api;
  }

  function setLayer(i) {
    S.layer = clamp(i | 0, 0, curFrame().layers.length - 1);
    touch();
    return api;
  }

  function setLayerVisible(i, v) { curFrame().layers[i].visible = !!v; touch(); return api; }
  function setLayerOpacity(i, o) { curFrame().layers[i].opacity = clamp(+o, 0, 1); touch(); return api; }
  function renameLayer(i, n) { curFrame().layers[i].name = String(n); touch(); return api; }

  function mergeDown() {
    const f = curFrame();
    if (S.layer <= 0) return api;
    snapDoc();
    const top = f.layers[S.layer], below = f.layers[S.layer - 1];
    for (let i = 0; i < top.data.length; i += 4) {
      if (top.data[i + 3] === 0) continue;
      below.data[i] = top.data[i]; below.data[i + 1] = top.data[i + 1];
      below.data[i + 2] = top.data[i + 2]; below.data[i + 3] = top.data[i + 3];
    }
    f.layers.splice(S.layer, 1);
    S.layer -= 1;
    touch();
    return api;
  }

  // ---------------------------------------------------------------
  // 合成（给 UI / 导出用）
  // ---------------------------------------------------------------
  function composite(frameIndex, opts) {
    opts = opts || {};
    const f = S.frames[frameIndex === undefined ? S.frame : frameIndex];
    const out = new Uint8ClampedArray(S.w * S.h * 4);
    if (!f) return out;
    for (const l of f.layers) {
      if (!l.visible && !opts.allLayers) continue;
      const k = opts.allLayers ? 1 : l.opacity;
      for (let i = 0; i < out.length; i += 4) {
        const sa = l.data[i + 3] / 255 * k;
        if (sa <= 0) continue;
        const da = out[i + 3] / 255;
        const oa = sa + da * (1 - sa);
        if (oa <= 0) continue;
        out[i] = (l.data[i] * sa + out[i] * da * (1 - sa)) / oa;
        out[i + 1] = (l.data[i + 1] * sa + out[i + 1] * da * (1 - sa)) / oa;
        out[i + 2] = (l.data[i + 2] * sa + out[i + 2] * da * (1 - sa)) / oa;
        out[i + 3] = oa * 255;
      }
    }
    return out;
  }

  function toCanvas(frameIndex) {
    const c = document.createElement("canvas");
    c.width = S.w; c.height = S.h;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(S.w, S.h);
    img.data.set(composite(frameIndex));
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** 最近邻放大 */
  function scaleCanvas(src, k) {
    const c = document.createElement("canvas");
    c.width = src.width * k; c.height = src.height * k;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  function toPNGDataURL(frameIndex, scale) {
    const c = toCanvas(frameIndex);
    return (scale && scale > 1 ? scaleCanvas(c, scale | 0) : c).toDataURL("image/png");
  }

  /** 所有帧横排成一张图（精灵表） */
  function stripDataURL(scale) {
    const n = S.frames.length;
    const c = document.createElement("canvas");
    c.width = S.w * n; c.height = S.h;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < n; i++) ctx.drawImage(toCanvas(i), i * S.w, 0);
    const out = scale && scale > 1 ? scaleCanvas(c, scale | 0) : c;
    return out.toDataURL("image/png");
  }

  function download(name, scale) {
    const a = document.createElement("a");
    a.href = toPNGDataURL(undefined, scale || 1);
    a.download = name || ("pixel-" + S.w + "x" + S.h + ".png");
    a.click();
    return api;
  }

  function downloadStrip(name, scale) {
    const a = document.createElement("a");
    a.href = stripDataURL(scale || 1);
    a.download = name || "strip.png";
    a.click();
    return api;
  }

  // ---------------------------------------------------------------
  // 视图
  // ---------------------------------------------------------------
  const view = {
    zoom(z) { S.zoom = clamp(+z || 1, 1, 64); touch(); return api; },
    panBy(dx, dy) { S.pan.x += dx; S.pan.y += dy; touch(); return api; },
    grid(v) { S.grid = v === undefined ? !S.grid : !!v; touch(); return api; },
    checker(v) { S.checker = v === undefined ? !S.checker : !!v; touch(); return api; },
    onion(v) { S.onion = v === undefined ? !S.onion : !!v; touch(); return api; }
  };

  function fit(uiSize) {
    // UI 会传入可用区域；没有就按 8 倍
    const box = uiSize || { w: 480, h: 480 };
    const k = Math.max(1, Math.min(
      Math.floor(box.w / S.w), Math.floor(box.h / S.h), 32
    ));
    S.zoom = clamp(k, 1, 64);
    S.pan.x = Math.round((box.w - S.w * S.zoom) / 2);
    S.pan.y = Math.round((box.h - S.h * S.zoom) / 2);
    touch();
    return api;
  }

  // ---------------------------------------------------------------
  // 对外 API
  // ---------------------------------------------------------------
  const api = {
    // —— 状态 ——
    state() {
      return {
        w: S.w, h: S.h, frame: S.frame, layer: S.layer, zoom: S.zoom,
        frames: S.frames.length,
        layers: curFrame().layers.map((l, i) => ({ i, name: l.name, visible: l.visible, opacity: l.opacity })),
        color: S.color, palette: S.palette.slice(), sel: S.sel ? { ...S.sel } : null,
        grid: S.grid, checker: S.checker, onion: S.onion,
        undo: undoStack.length, redo: redoStack.length
      };
    },
    _S: S,

    // —— 文档 ——
    newDoc, size: () => ({ w: S.w, h: S.h }),

    // —— 帧 / 层 ——
    addFrame, dupFrame: () => addFrame(true), delFrame, setFrame,
    addLayer, delLayer, setLayer, setLayerVisible, setLayerOpacity, renameLayer, mergeDown,

    // —— 颜色 ——
    setColor(c) { S.color = String(c); touch(); return api; },
    getColor: () => S.color,
    setPalette(p) { S.palette = (p || []).slice(); touch(); return api; },
    getPalette: () => S.palette.slice(),
    addPaletteColor(c) { if (S.palette.indexOf(c) < 0) S.palette.push(c); touch(); return api; },

    // —— 绘制 ——
    px, line, rect,
    rectLine: (x, y, w, h, c) => rect(x, y, w, h, c, true),
    ellipse,
    ellipseLine: (cx, cy, rx, ry, c) => ellipse(cx, cy, rx, ry, c, true),
    circle: (cx, cy, r, c) => ellipse(cx, cy, r, r, c),
    circleLine: (cx, cy, r, c) => ellipse(cx, cy, r, r, c, true),
    poly, fill: floodFill,
    clearRect, clear: clearLayer, drawAscii,

    // —— 变换 ——
    flipH, flipV,
    rotateCW: () => rotate(1),
    rotateCCW: () => rotate(-1),
    shift, outline, replaceColor, mapColors,

    // —— 选区 ——
    select: (x, y, w, h) => sel.set(x, y, w, h),
    selectAll: () => sel.all(),
    deselect: () => sel.clear(),
    selection: () => sel.get(),
    fillSel: c => sel.fill(c),
    clearSel: () => sel.clearPixels(),

    // —— 历史 ——
    undo, redo,
    beginBatch, endBatch,

    // —— 视图 ——
    zoom: view.zoom, panBy: view.panBy, fit,
    grid: view.grid, checker: view.checker, onion: view.onion,

    // —— 导出 ——
    png: toPNGDataURL,
    strip: stripDataURL,
    preview: (scale) => toPNGDataURL(undefined, scale || 8),
    download, downloadStrip, toCanvas,

    // —— 事件 ——
    onChange(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    _touch: touch,

    // —— 存档 ——
    save, load, clearSaved
  };

  global.pixelTool = api;

  // 启动：有存档就恢复，否则开一张 32×32
  if (!load()) newDoc(32, 32);
})(window);
