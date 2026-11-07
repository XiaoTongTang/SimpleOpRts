/**
 * ui.js —— pixelTool 的界面层
 * 只负责：画到屏幕、把鼠标映射成像素操作、面板控件。
 * 所有编辑能力都在 window.pixelTool（pixelcore.js）里。
 */
(function () {
  "use strict";
  const P = window.pixelTool;
  const S = P._S;

  const wrap = document.getElementById("canvasWrap");
  const cvs = document.getElementById("board");
  const ctx = cvs.getContext("2d");
  const status = document.getElementById("status");

  let W = 0, H = 0;
  let tool = "pen";
  let drawing = false;
  let panning = false;
  let last = null;           // 上一个像素
  let start = null;          // 形状起点
  let hover = null;          // 当前悬停像素
  let panStart = null;

  // ---------------------------------------------------------------
  // 尺寸 / 渲染
  // ---------------------------------------------------------------
  function resize() {
    const r = wrap.getBoundingClientRect();
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    W = Math.round(r.width); H = Math.round(r.height);
    cvs.width = Math.round(W * dpr);
    cvs.height = Math.round(H * dpr);
    cvs.style.width = W + "px";
    cvs.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    draw();
  }

  function checker() {
    const z = S.zoom;
    const x0 = S.pan.x, y0 = S.pan.y, w = S.w * z, h = S.h * z;
    const cell = Math.max(4, Math.min(12, Math.round(z / 2) || 4));
    if (!S.checker) {
      ctx.fillStyle = "#151c24";
      ctx.fillRect(x0, y0, w, h);
      return;
    }
    ctx.fillStyle = "#1a222c";
    ctx.fillRect(x0, y0, w, h);
    ctx.fillStyle = "#12181f";
    for (let y = 0; y < h; y += cell) {
      for (let x = 0; x < w; x += cell) {
        if (((x / cell) | 0) % 2 === ((y / cell) | 0) % 2) continue;
        ctx.fillRect(x0 + x, y0 + y, Math.min(cell, w - x), Math.min(cell, h - y));
      }
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const z = S.zoom;
    const x0 = S.pan.x, y0 = S.pan.y;

    checker();

    // 洋葱皮：上一帧
    if (S.onion && S.frame > 0) {
      ctx.globalAlpha = 0.28;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(P.toCanvas(S.frame - 1), x0, y0, S.w * z, S.h * z);
      ctx.globalAlpha = 1;
    }

    // 当前帧
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(P.toCanvas(), x0, y0, S.w * z, S.h * z);

    // 网格
    if (S.grid && z >= 6) {
      ctx.save();
      ctx.strokeStyle = "rgba(140,180,220,.10)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= S.w; x++) {
        const px = Math.round(x0 + x * z) + 0.5;
        ctx.moveTo(px, y0); ctx.lineTo(px, y0 + S.h * z);
      }
      for (let y = 0; y <= S.h; y++) {
        const py = Math.round(y0 + y * z) + 0.5;
        ctx.moveTo(x0, py); ctx.lineTo(x0 + S.w * z, py);
      }
      ctx.stroke();
      ctx.restore();
    }

    // 画布边框
    ctx.strokeStyle = "rgba(120,160,200,.45)";
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x0) - 0.5, Math.round(y0) - 0.5, S.w * z + 1, S.h * z + 1);

    // 选区
    if (S.sel) {
      const s = S.sel;
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = "#7fd7ff";
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + s.x * z + 0.5, y0 + s.y * z + 0.5, s.w * z - 1, s.h * z - 1);
      ctx.restore();
    }

    // 形状预览
    if (drawing && start && hover && isShape(tool)) {
      const a = start, b = hover;
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x) + 1, h = Math.abs(b.y - a.y) + 1;
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "rgba(255,255,255,.75)";
      ctx.lineWidth = 1;
      if (tool === "ellipse" || tool === "ellipseLine") {
        const cx = (x + w / 2) * z + x0, cy = (y + h / 2) * z + y0;
        ctx.beginPath();
        ctx.ellipse(cx, cy, (w / 2) * z, (h / 2) * z, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.strokeRect(x0 + x * z + 0.5, y0 + y * z + 0.5, w * z - 1, h * z - 1);
      }
      ctx.restore();
    }

    // 悬停像素
    if (hover && hover.x >= 0 && hover.y >= 0 && hover.x < S.w && hover.y < S.h) {
      ctx.strokeStyle = "rgba(255,255,255,.55)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + hover.x * z + 0.5, y0 + hover.y * z + 0.5, z - 1, z - 1);
    }
  }

  function isShape(t) { return t === "line" || t === "rect" || t === "rectLine" || t === "ellipse" || t === "ellipseLine"; }

  // ---------------------------------------------------------------
  // 坐标
  // ---------------------------------------------------------------
  function toPix(e) {
    const r = cvs.getBoundingClientRect();
    return {
      x: Math.floor((e.clientX - r.left - S.pan.x) / S.zoom),
      y: Math.floor((e.clientY - r.top - S.pan.y) / S.zoom)
    };
  }

  function pickColor(x, y) {
    if (x < 0 || y < 0 || x >= S.w || y >= S.h) return null;
    const data = P.toCanvas().getContext("2d").getImageData(x, y, 1, 1).data;
    if (data[3] === 0) return null;
    const h = n => n.toString(16).padStart(2, "0");
    return "#" + h(data[0]) + h(data[1]) + h(data[2]);
  }

  // ---------------------------------------------------------------
  // 鼠标
  // ---------------------------------------------------------------
  function paint(x, y, erase) {
    const color = erase ? "#00000000" : S.color;
    if (last && !erase) {
      P.line(last.x, last.y, x, y, color);
    } else {
      P.px(x, y, color);
    }
  }

  cvs.addEventListener("pointerdown", e => {
    cvs.setPointerCapture(e.pointerId);
    const p = toPix(e);

    if (e.button === 1 || spaceDown) {
      panning = true;
      panStart = { x: e.clientX - S.pan.x, y: e.clientY - S.pan.y };
      return;
    }
    if (e.altKey || tool === "picker") {
      const c = pickColor(p.x, p.y);
      if (c) { P.setColor(c); refreshPanels(); }
      return;
    }

    drawing = true;
    start = p; last = p; hover = p;

    if (tool === "select") { draw(); return; }

    P.beginBatch();
    if (tool === "pen") paint(p.x, p.y, e.button === 2);
    else if (tool === "eraser") paint(p.x, p.y, true);
    else if (tool === "fill") P.fill(p.x, p.y, S.color);
    draw();
  });

  cvs.addEventListener("pointermove", e => {
    const p = toPix(e);
    hover = p;
    if (panning && panStart) {
      S.pan.x = e.clientX - panStart.x;
      S.pan.y = e.clientY - panStart.y;
      P._touch();
    } else if (drawing) {
      if (tool === "pen") paint(p.x, p.y, e.buttons === 2);
      else if (tool === "eraser") paint(p.x, p.y, true);
      last = p;
    }
    if (!drawing && !panning) P._touch();
    showStatus(p);
  });

  cvs.addEventListener("pointerup", e => {
    const p = toPix(e);
    if (panning) { panning = false; return; }
    if (!drawing) return;

    if (tool === "select") {
      const x = Math.min(start.x, p.x), y = Math.min(start.y, p.y);
      const w = Math.abs(p.x - start.x) + 1, h = Math.abs(p.y - start.y) + 1;
      P.select(x, y, w, h);
    } else if (isShape(tool)) {
      const a = start, b = p;
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x) + 1, h = Math.abs(b.y - a.y) + 1;
      P.beginBatch();
      if (tool === "line") P.line(a.x, a.y, b.x, b.y, S.color);
      if (tool === "rect") P.rect(x, y, w, h, S.color);
      if (tool === "rectLine") P.rectLine(x, y, w, h, S.color);
      if (tool === "ellipse") P.ellipse(x + w / 2 - 0.5, y + h / 2 - 0.5, w / 2, h / 2, S.color);
      if (tool === "ellipseLine") P.ellipseLine(x + w / 2 - 0.5, y + h / 2 - 0.5, w / 2, h / 2, S.color);
      P.endBatch();
    } else {
      P.endBatch();
    }
    drawing = false; start = null; last = null;
    draw();
    refreshPanels();
  });

  cvs.addEventListener("contextmenu", e => e.preventDefault());

  cvs.addEventListener("wheel", e => {
    e.preventDefault();
    const r = cvs.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const before = { x: (mx - S.pan.x) / S.zoom, y: (my - S.pan.y) / S.zoom };
    const dir = e.deltaY > 0 ? -1 : 1;
    const nz = Math.max(1, Math.min(48, S.zoom + dir));
    S.zoom = nz;
    S.pan.x = Math.round(mx - before.x * nz);
    S.pan.y = Math.round(my - before.y * nz);
    P._touch();
  }, { passive: false });

  // ---------------------------------------------------------------
  // 键盘
  // ---------------------------------------------------------------
  let spaceDown = false;
  window.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT") return;
    const k = e.key.toLowerCase();
    if (k === " ") { spaceDown = true; e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "z") {
      e.preventDefault();
      e.shiftKey ? P.redo() : P.undo();
      draw(); refreshPanels();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); P.redo(); draw(); refreshPanels(); return; }
    const map = { b: "pen", e: "eraser", g: "fill", l: "line", r: "rect", o: "ellipse", i: "picker", m: "select" };
    if (map[k]) { setTool(map[k]); return; }
    if (k === "escape") { P.deselect(); draw(); }
    if (k === "delete" || k === "backspace") { e.preventDefault(); if (S.sel) { P.clearSel(); } else { P.clear(); } draw(); refreshPanels(); }
    if (k === "+" || k === "=") { S.zoom = Math.min(48, S.zoom + 1); P._touch(); }
    if (k === "-") { S.zoom = Math.max(1, S.zoom - 1); P._touch(); }
  });
  window.addEventListener("keyup", e => { if (e.key === " ") spaceDown = false; });

  // ---------------------------------------------------------------
  // 面板
  // ---------------------------------------------------------------
  const TOOLS = [
    ["pen", "画笔", "B"], ["eraser", "橡皮", "E"], ["fill", "填充", "G"],
    ["line", "直线", "L"], ["rect", "实心矩形", "R"], ["rectLine", "矩形框", ""],
    ["ellipse", "实心椭圆", "O"], ["ellipseLine", "椭圆框", ""],
    ["picker", "取色", "I"], ["select", "选区", "M"]
  ];

  const toolBox = document.getElementById("tools");
  TOOLS.forEach(([id, label, key]) => {
    const b = document.createElement("button");
    b.dataset.tool = id;
    b.className = "tool";
    b.title = label + (key ? " (" + key + ")" : "");
    b.textContent = label;
    b.addEventListener("click", () => setTool(id));
    toolBox.appendChild(b);
  });

  function setTool(t) {
    tool = t;
    [...toolBox.children].forEach(b => b.classList.toggle("on", b.dataset.tool === t));
    showStatus(hover);
  }

  const palBox = document.getElementById("palette");
  function refreshPalette() {
    palBox.innerHTML = "";
    for (const c of S.palette) {
      const d = document.createElement("button");
      d.className = "swatch" + (c.toLowerCase() === S.color.toLowerCase() ? " on" : "");
      d.style.background = c;
      d.title = c;
      d.addEventListener("click", () => { P.setColor(c); refreshPalette(); });
      palBox.appendChild(d);
    }
  }

  const layerBox = document.getElementById("layers");
  function refreshLayers() {
    layerBox.innerHTML = "";
    const layers = S.frames[S.frame].layers;
    // 顶层在上：倒序显示
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      const row = document.createElement("div");
      row.className = "row" + (i === S.layer ? " on" : "");
      const eye = document.createElement("button");
      eye.className = "eye" + (l.visible ? "" : " off");
      eye.textContent = l.visible ? "●" : "○";
      eye.title = "显示/隐藏";
      eye.addEventListener("click", ev => { ev.stopPropagation(); P.setLayerVisible(i, !l.visible); });
      const name = document.createElement("span");
      name.textContent = l.name;
      name.addEventListener("click", () => { P.setLayer(i); refreshPanels(); });
      row.appendChild(eye); row.appendChild(name);
      layerBox.appendChild(row);
    }
  }

  const frameBox = document.getElementById("frames");
  function refreshFrames() {
    frameBox.innerHTML = "";
    for (let i = 0; i < S.frames.length; i++) {
      const b = document.createElement("button");
      b.className = "frame" + (i === S.frame ? " on" : "");
      b.textContent = i + 1;
      b.addEventListener("click", () => { P.setFrame(i); refreshPanels(); });
      frameBox.appendChild(b);
    }
  }

  function refreshPanels() {
    refreshLayers();
    refreshFrames();
    refreshPalette();
    const st = P.state();
    document.getElementById("zoomLabel").textContent = Math.round(S.zoom * 100) + "%";
    document.getElementById("sizeLabel").textContent = st.w + " × " + st.h + "  ·  " + st.frames + " 帧";
    const dw = document.getElementById("docW"), dh = document.getElementById("docH");
    if (document.activeElement !== dw) dw.value = st.w;
    if (document.activeElement !== dh) dh.value = st.h;
  }

  function showStatus(p) {
    if (!p || p.x < 0 || p.y < 0 || p.x >= S.w || p.y >= S.h) {
      status.textContent = tool;
      return;
    }
    const c = pickColor(p.x, p.y);
    status.textContent = p.x + ", " + p.y + (c ? "  " + c : "  —") + "   [" + tool + "]";
  }

  // ---------------------------------------------------------------
  // 顶部 / 侧栏按钮
  // ---------------------------------------------------------------
  document.getElementById("btnNew").addEventListener("click", () => {
    const w = parseInt(document.getElementById("docW").value, 10) || 32;
    const h = parseInt(document.getElementById("docH").value, 10) || 32;
    P.newDoc(w, h);
    P.fit({ w: W - 24, h: H - 24 });
    refreshPanels(); draw();
  });
  document.getElementById("btnFit").addEventListener("click", () => {
    P.fit({ w: W - 24, h: H - 24 }); refreshPanels(); draw();
  });
  document.getElementById("btnZoomIn").addEventListener("click", () => { S.zoom = Math.min(48, S.zoom + 1); P._touch(); refreshPanels(); });
  document.getElementById("btnZoomOut").addEventListener("click", () => { S.zoom = Math.max(1, S.zoom - 1); P._touch(); refreshPanels(); });
  document.getElementById("btnUndo").addEventListener("click", () => { P.undo(); draw(); refreshPanels(); });
  document.getElementById("btnRedo").addEventListener("click", () => { P.redo(); draw(); refreshPanels(); });

  document.getElementById("tglGrid").addEventListener("change", e => { P.grid(e.target.checked); draw(); });
  document.getElementById("tglCheck").addEventListener("change", e => { P.checker(e.target.checked); draw(); });
  document.getElementById("tglOnion").addEventListener("change", e => { P.onion(e.target.checked); draw(); });

  document.getElementById("colorInput").addEventListener("input", e => { P.setColor(e.target.value); refreshPalette(); });
  document.getElementById("colorInput").value = S.color;

  document.getElementById("btnAddFrame").addEventListener("click", () => { P.addFrame(); refreshPanels(); draw(); });
  document.getElementById("btnDupFrame").addEventListener("click", () => { P.dupFrame(); refreshPanels(); draw(); });
  document.getElementById("btnDelFrame").addEventListener("click", () => { P.delFrame(); refreshPanels(); draw(); });
  document.getElementById("btnAddLayer").addEventListener("click", () => { P.addLayer(); refreshPanels(); });
  document.getElementById("btnDelLayer").addEventListener("click", () => { P.delLayer(); refreshPanels(); draw(); });
  document.getElementById("btnMerge").addEventListener("click", () => { P.mergeDown(); refreshPanels(); draw(); });
  document.getElementById("btnExport").addEventListener("click", () => P.download());
  document.getElementById("btnExportStrip").addEventListener("click", () => P.downloadStrip());

  // 核心变更 → 重画；画布尺寸变了就自动适应窗口
  let lastW = 0, lastH = 0;
  P.onChange(() => {
    if (S.w !== lastW || S.h !== lastH) {
      lastW = S.w; lastH = S.h;
      P.fit({ w: W - 24, h: H - 24 });
      refreshPanels();
    }
    draw();
  });

  // ---------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------
  window.addEventListener("resize", resize);
  resize();
  // 首帧布局还没稳定，下一帧再算「适应窗口」
  requestAnimationFrame(() => {
    resize();
    P.fit({ w: W - 24, h: H - 24 });
    setTool("pen");
    refreshPanels();
    draw();
  });

  // 给外部脚本用的小钩子
  window.pixelUI = {
    setTool,
    redraw() { draw(); refreshPanels(); },
    setColor(c) { P.setColor(c); refreshPalette(); document.getElementById("colorInput").value = c; },
    refresh: refreshPanels
  };
})();
