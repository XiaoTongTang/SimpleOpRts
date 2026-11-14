/**
 * 阵型编辑界面
 * -----------------------------------------------------------------
 * 布局对齐 design/261107_2机制改进/UI原型-4-阵型编辑.html，但**参数是现在的 13 个**：
 * 旧原型的 wSep / rRep / wThreat 那一套已经在质量速度模型迁移里换掉了。
 *
 *   左栏：阵型库（内置 / 自建），新建 · 复制 · 改名 · 删除
 *   中间：一块**真的战场** —— 一个独立的预览 core 在跑，可以导入地图
 *   右栏：Couzin 参数（按"影响什么"分四组），改完保存才落到 core
 *
 * 三种数据各归各的：
 *   阵型库       core.formations（设计数据，跨局保留）
 *   预览战场     screen 自己 new 的 GameCore，只在本界面存在
 *   参数草稿     draft，保存前不写 core
 */

import { paint, fmtNum } from "./util.js";

/** 预览里用的两种船：轻（矛隼）与重（重锤） */
const SHIP_LIGHT = "ship.std_falcon";
const SHIP_HEAVY = "ship.std_hammer";

const COUNT_OPTIONS = [6, 12, 18, 24];

export function mountFormation(root, { store, bridge, catalog, onBack }) {
  const snap = () => store.getState().snap;
  const lib = () => snap()?.formationList || [];
  const shipName = id => (snap()?.shipList || []).find(s => s.id === id)?.name || id;

  // ---------------- 状态 ----------------
  let curId = null;             // 选中的阵型
  let draft = null;             // 右栏草稿（保存前不动 core）
  let dirty = false;
  let side = 0;                 // 0 = 指挥我方，1 = 指挥对手
  let mineShip = SHIP_LIGHT;
  let mineCount = 12;
  let oppOn = true;
  let oppShip = SHIP_LIGHT;
  let oppCount = 12;

  // 全局参数草稿（与阵型参数分开保存）
  let globalDraft = null;

  // 预览用的一切
  let sim = null;
  let simRenderer = null;
  let raf = 0;
  let running = true;
  let ro = null;

  // ---------------- 外壳 ----------------
  root.innerHTML = `
    <div class="screen">
      <div class="screen-head">
        <button class="btn" id="fm-back">← 返回战场</button>
        <span class="screen-title">阵型编辑</span>
        <span class="screen-hint">改参数 → 看中间那块战场 → 保存才生效</span>
      </div>

      <div class="fm-body">
        <div class="fm-left">
          <div class="panel-head">阵型库 <span class="n" id="fm-lib-n">0</span></div>
          <div class="scroll" id="fm-lib"></div>
          <div class="btns">
            <button class="btn" id="fm-new">新建</button>
            <button class="btn" id="fm-dup">复制</button>
            <button class="btn" id="fm-rename">改名</button>
          </div>
          <div class="foot">
            <button class="btn" id="fm-del">删除</button>
          </div>
        </div>

        <div class="fm-stage" id="fm-stage">
          <div class="panel-head">
            预览战场
            <span class="n" id="fm-stage-note">我方 12 艘</span>
          </div>
          <div class="fm-canvas-wrap">
            <canvas id="fm-canvas"></canvas>
            <div class="fm-beacon" id="fm-beacon" hidden></div>
            <div class="fm-tip" id="fm-tip">左键下达命令 · 右键取消 · 滚轮缩放 · 中键平移</div>
          </div>
          <div class="fm-hud">
            <label class="fm-pick"><span>我方</span>
              <select id="fm-mine-ship"></select>
              <select id="fm-mine-n"></select>
            </label>
            <label class="fm-pick"><span>对手</span>
              <select id="fm-opp">
                <option value="">无</option>
                <option value="1">红方小队</option>
              </select>
              <select id="fm-opp-ship"></select>
              <select id="fm-opp-n"></select>
            </label>
            <div class="fm-acts">
              <button class="btn ghost" id="fm-pause">暂停</button>
              <button class="btn ghost" id="fm-reset">重置</button>
              <button class="btn ghost" id="fm-side">指挥权：我方</button>
              <button class="btn ghost" id="fm-map">导入地图</button>
              <input type="file" id="fm-map-file" accept=".json,application/json" hidden />
            </div>
          </div>
        </div>

        <div class="fm-right">
          <div class="panel-head">Couzin 参数 <span class="n" id="fm-p-name">—</span></div>
          <div class="scroll">
            <!-- 全局参数：与阵型参数是两套东西，各自独立保存 -->
            <div class="fm-card">
              <div class="fm-card-head">全局参数<span class="hint">所有小队共用 · 群体与寻路</span></div>
              <div id="fm-global"></div>
              <div class="fm-card-foot">
                <span class="fm-state" id="fm-g-state">已保存</span>
                <button class="btn ghost" id="fm-g-revert" disabled>还原</button>
                <button class="btn primary" id="fm-g-save" disabled>保存全局</button>
              </div>
            </div>
            <div class="fm-params" id="fm-params"></div>
          </div>
          <div class="fm-save">
            <div class="fm-state" id="fm-state">已保存</div>
            <button class="btn ghost" id="fm-revert" disabled>还原</button>
            <button class="btn primary" id="fm-save" disabled>保存阵型</button>
          </div>
        </div>
      </div>
    </div>`;

  const el = id => root.querySelector("#" + id);

  // ---------------- 快照读取 ----------------
  const paramGroups = () => snap()?.formationParams || [];
  const curForm = () => lib().find(f => f.id === curId) || null;

  // ---------------- 左栏：阵型库 ----------------
  function renderLib() {
    const list = lib();
    const sig = list.map(f => `${f.id}:${f.name}:${f.builtin ? 1 : 0}:${f.usedBy}`).join("|") + "#" + curId;
    paint(el("fm-lib"), sig, () => list.map(f => {
      const sub = `分离 ${fmtNum(f.p.sepRadius)} · 对齐 ${fmtNum(f.p.alignRadius)} · 凝聚 ${fmtNum(f.p.cohRadius)}`;
      return `
        <div class="frow${f.id === curId ? " sel" : ""}" data-form="${f.id}">
          <div class="frow-main">
            <div class="nm">
              <span>${f.name}</span>
              <i class="badge${f.builtin ? "" : " mine"}">${f.builtin ? "内置" : "自建"}</i>
              ${f.usedBy ? `<i class="badge used">用 ${f.usedBy}</i>` : ""}
            </div>
            <div class="sub">${sub}</div>
          </div>
          ${f.builtin ? "" : `<button class="delx" data-del="${f.id}" title="删除">✕</button>`}
        </div>`;
    }).join(""));

    el("fm-lib-n").textContent = list.length;

    el("fm-lib").querySelectorAll("[data-form]").forEach(n => {
      n.addEventListener("click", () => select(n.dataset.form));
    });
    el("fm-lib").querySelectorAll("[data-del]").forEach(b => {
      b.addEventListener("click", e => {
        e.stopPropagation();
        const r = bridge.run({ type: "deleteFormation", formId: b.dataset.del });
        if (r.ok && b.dataset.del === curId) curId = null;
        afterChange();
      });
    });
  }

  // ---------------- 右栏：参数 ----------------
  function renderParams() {
    const f = curForm();
    if (!f) {
      el("fm-params").innerHTML = `<div class="fm-empty">左侧选一个阵型</div>`;
      el("fm-p-name").textContent = "—";
      el("fm-save").disabled = true;
      el("fm-revert").disabled = true;
      el("fm-state").textContent = "";
      return;
    }
    if (!draft) draft = { ...f.p };
    el("fm-p-name").textContent = f.name;

    const groups = paramGroups();
    const sig = groups.map(g => g.items.map(i => `${i.k}=${draft[i.k]}`).join(",")).join("|");
    paint(el("fm-params"), sig, () => groups.map(g => `
      <div class="param-group">
        <div class="pgroup-title">${g.title}<span class="hint">${g.hint}</span><span class="n">${g.items.length} 项</span></div>
        ${g.items.map(it => paramRow(it, f)).join("")}
      </div>`).join(""));

    bindParams();
    updateSaveState();
  }

  function paramRow(it, f) {
    const v = draft[it.k];
    const changed = Math.abs(Number(v) - Number(f.p[it.k])) > 1e-9;
    return `
      <div class="param${changed ? " touched" : ""}" data-k="${it.k}">
        <div class="ptop">
          <span class="pk">${it.k}</span>
          <span class="pn">${it.name}</span>
          <span class="pv">${fmtNum(v)}</span>
        </div>
        <input type="range" class="prange" data-range="${it.k}"
               min="${it.min}" max="${it.max}" step="${it.step}" value="${v}" />
        <div class="pdesc">${it.desc}</div>
      </div>`;
  }

  function bindParams() {
    el("fm-params").querySelectorAll("[data-range]").forEach(inp => {
      inp.addEventListener("input", () => {
        const k = inp.dataset.range;
        const meta = paramMeta(k);
        draft[k] = Number(Number(inp.value).toFixed(meta ? meta.dec : 2));
        const row = inp.closest(".param");
        row.querySelector(".pv").textContent = fmtNum(draft[k]);
        const f = curForm();
        row.classList.toggle("touched", f && Math.abs(draft[k] - f.p[k]) > 1e-9);
        pushPreview();
        updateSaveState();
      });
    });
  }

  function paramMeta(k) {
    for (const g of paramGroups()) for (const i of g.items) if (i.k === k) return i;
    return null;
  }

  function draftDirty() {
    const f = curForm();
    if (!f || !draft) return false;
    return Object.keys(draft).some(k => Math.abs(Number(draft[k]) - Number(f.p[k])) > 1e-9);
  }

  function updateSaveState() {
    dirty = draftDirty();
    el("fm-save").disabled = !dirty;
    el("fm-revert").disabled = !dirty;
    el("fm-state").textContent = dirty ? "未保存的改动" : "已保存";
    el("fm-state").classList.toggle("dirty", dirty);
  }

  // ---------------- 全局参数（独立保存） ----------------
  function globalDefs() { return snap()?.globalParams || []; }

  function renderGlobal() {
    const g = snap()?.G;
    if (!g) return;
    if (!globalDraft) globalDraft = { ...g };

    const defs = globalDefs();
    const sig = defs.map(d => `${d.k}=${globalDraft[d.k]}`).join(",");
    paint(el("fm-global"), sig, () => defs.map(d => paramRowGeneric(d, globalDraft, g)).join(""));

    el("fm-global").querySelectorAll("[data-grange]").forEach(inp => {
      inp.addEventListener("input", () => {
        const k = inp.dataset.grange;
        const def = globalDefs().find(x => x.k === k);
        globalDraft[k] = Number(Number(inp.value).toFixed(def ? def.dec : 2));
        const row = inp.closest(".param");
        row.querySelector(".pv").textContent = fmtNum(globalDraft[k]);
        row.classList.toggle("touched", Math.abs(globalDraft[k] - g[k]) > 1e-9);
        updateGlobalState();
        pushPreview();
      });
    });

    updateGlobalState();
  }

  /** 全局参数与阵型参数长得一样，但键不同、保存按钮也不同 */
  function paramRowGeneric(def, draft, base) {
    const v = draft[def.k];
    const changed = Math.abs(Number(v) - Number(base[def.k])) > 1e-9;
    return `
      <div class="param${changed ? " touched" : ""}" data-k="${def.k}">
        <div class="ptop">
          <span class="pk">${def.k}</span>
          <span class="pn">${def.name}</span>
          <span class="pv">${fmtNum(v)}</span>
        </div>
        <input type="range" class="prange" data-grange="${def.k}"
               min="${def.min}" max="${def.max}" step="${def.step}" value="${v}" />
        <div class="pdesc">${def.desc}</div>
      </div>`;
  }

  function updateGlobalState() {
    const g = snap()?.G;
    const isDirty = !!g && !!globalDraft &&
      Object.keys(globalDraft).some(k => Math.abs(Number(globalDraft[k]) - Number(g[k])) > 1e-9);
    el("fm-g-save").disabled = !isDirty;
    el("fm-g-revert").disabled = !isDirty;
    el("fm-g-state").textContent = isDirty ? "未保存的改动" : "已保存";
    el("fm-g-state").classList.toggle("dirty", isDirty);
  }

  // ---------------- 预览战场 ----------------
  let panning = null;

  function onPanMove(ev) {
    if (!panning || !sim) return;
    const cam = sim.cameraView();
    const dx = (ev.clientX - panning.x) / cam.zoom;
    const dy = (ev.clientY - panning.y) / cam.zoom;
    sim.command({ type: "setCamera", x: panning.cx - dx, y: panning.cy - dy });
  }

  function onPanUp() { panning = null; }

  async function startPreview() {
    const { GameCore } = await import("../../core/core.js");
    const { createPixiRenderer } = await import("../../render/render-pixi.js");

    const canvas = el("fm-canvas");
    simRenderer = await createPixiRenderer(canvas);
    sim = new GameCore({
      map: null,
      build: previewBuild(),
      seed: 7
    });

    const stage = el("fm-stage");
    ro = new ResizeObserver(() => layout());
    ro.observe(stage);
    layout();

    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (running && sim) {
        for (let i = 0; i < 1; i++) sim.step(1 / 60);
      }
      if (sim && simRenderer) {
        simRenderer.draw(sim.getView(), 1 / 60);
        syncBeacon();
      }
    };
    raf = requestAnimationFrame(loop);
  }

  /** 命令信标是渲染层之外的东西，用一个 DOM 点跟着相机走 */
  function syncBeacon() {
    const dot = el("fm-beacon");
    if (!dot || !sim) return;
    const g = sim.squads[side]?.goal;
    if (!g) { dot.hidden = true; return; }
    const cam = sim.cameraView();
    dot.hidden = false;
    dot.style.left = (cam.ox + g.x * cam.zoom) + "px";
    dot.style.top = (cam.oy + g.y * cam.zoom) + "px";
  }

  function layout() {
    const cvs = el("fm-canvas");
    if (!cvs || !simRenderer) return;
    const r = cvs.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    simRenderer.resize(r.width, r.height);
    sim.setViewport(r.width, r.height);
    sim.command({ type: "setCamera", fit: true });
  }
  function previewBuild() {
    const squads = [
      mkSquadDef(0, "我方", 0, mineShip, mineCount, curId || "form.default")
    ];
    if (oppOn) squads.push(mkSquadDef(1, "对手", 1, oppShip, oppCount, "form.default"));
    return { squads, modules: 0, commandCap: 9000 };
  }

  function mkSquadDef(id, name, faction, shipId, count, form) {
    return {
      id, key: name, name, faction,
      loose: false,
      template: null,
      entries: [{ ship: shipId, n: count }],
      formations: [form],
      form,
      ship: shipId,
      count
    };
  }

  /** 把右栏草稿实时压到预览小队上（预览 core 不共享阵型库，直接写 sq.p） */
  function pushPreview() {
    if (!sim) return;
    if (draft) {
      const sq = sim.squads[side];
      if (sq) for (const k of Object.keys(draft)) sq.p[k] = draft[k];
    }
    if (globalDraft) Object.assign(sim.G, globalDraft);
  }

  function rebuildPreview() {
    if (!sim) return;
    sim.reset({ build: previewBuild(), seed: sim.seed });
    sim.setViewport(...sim.viewportSize());
    sim.command({ type: "setCamera", fit: true });
    if (draft) pushPreview();
    el("fm-stage-note").textContent = oppOn
      ? `我方 ${mineCount} 艘 · 对手 ${oppCount} 艘`
      : `我方 ${mineCount} 艘`;
  }

  // ---------------- 选择 / 变更 ----------------
  function select(id) {
    curId = id;
    draft = null;
    renderLib();
    renderParams();
    pushPreview();
  }

  function afterChange() {
    renderLib();
    const f = curForm();
    if (f) draft = { ...f.p };
    renderParams();
  }

  // ---------------- 控件 ----------------
  function fillSelects() {
    const shipOpts = [
      `<option value="${SHIP_LIGHT}">${shipName(SHIP_LIGHT)}</option>`,
      `<option value="${SHIP_HEAVY}">${shipName(SHIP_HEAVY)}</option>`
    ].join("");
    el("fm-mine-ship").innerHTML = shipOpts;
    el("fm-opp-ship").innerHTML = shipOpts;

    const countOpts = COUNT_OPTIONS.map(n => `<option value="${n}">${n} 艘</option>`).join("");
    el("fm-mine-n").innerHTML = countOpts;
    el("fm-opp-n").innerHTML = countOpts;

    el("fm-mine-ship").value = mineShip;
    el("fm-opp-ship").value = oppShip;
    el("fm-mine-n").value = String(mineCount);
    el("fm-opp-n").value = String(oppCount);
    el("fm-opp").value = oppOn ? "1" : "";

    el("fm-mine-ship").addEventListener("change", e => { mineShip = e.target.value; rebuildPreview(); });
    el("fm-opp-ship").addEventListener("change", e => { oppShip = e.target.value; rebuildPreview(); });
    el("fm-mine-n").addEventListener("change", e => { mineCount = Number(e.target.value); rebuildPreview(); });
    el("fm-opp-n").addEventListener("change", e => { oppCount = Number(e.target.value); rebuildPreview(); });
    el("fm-opp").addEventListener("change", e => {
      oppOn = !!e.target.value;
      rebuildPreview();
    });
  }

  el("fm-back").addEventListener("click", () => onBack());

  el("fm-new").addEventListener("click", () => {
    const r = bridge.run({ type: "createFormation", name: "新阵型", from: curId || "form.default" });
    if (r.ok) { afterChange(); select(r.formId); }
  });

  el("fm-dup").addEventListener("click", () => {
    if (!curId) return;
    const r = bridge.run({ type: "duplicateFormation", formId: curId });
    if (r.ok) { afterChange(); select(r.formId); }
  });

  el("fm-rename").addEventListener("click", () => {
    const f = curForm();
    if (!f) return;
    const name = window.prompt("阵型改名", f.name);
    if (!name) return;
    bridge.run({ type: "renameFormation", formId: f.id, name });
    afterChange();
  });

  el("fm-del").addEventListener("click", () => {
    if (!curId) return;
    const r = bridge.run({ type: "deleteFormation", formId: curId });
    if (r.ok) { curId = null; draft = null; afterChange(); }
  });

  el("fm-save").addEventListener("click", () => {
    if (!curId || !draft) return;
    const r = bridge.run({ type: "editFormationBatch", formId: curId, p: draft });
    if (r.ok) afterChange();
  });

  el("fm-revert").addEventListener("click", () => {
    draft = null;
    renderParams();
    pushPreview();
  });

  el("fm-pause").addEventListener("click", () => {
    running = !running;
    el("fm-pause").textContent = running ? "暂停" : "继续";
  });

  el("fm-reset").addEventListener("click", () => rebuildPreview());

  el("fm-side").addEventListener("click", () => {
    side = side === 0 ? 1 : 0;
    el("fm-side").textContent = `指挥权：${side === 0 ? "我方" : "对手"}`;
    pushPreview();
  });

  // ---- 全局参数：独立保存 ----
  el("fm-g-save").addEventListener("click", () => {
    if (!globalDraft) return;
    const r = bridge.run({ type: "setGlobalParams", p: globalDraft });
    if (r.ok) {
      globalDraft = null;
      renderGlobal();
      pushPreview();
    }
  });

  el("fm-g-revert").addEventListener("click", () => {
    globalDraft = null;
    renderGlobal();
    pushPreview();
  });

  // ---- 战场交互：命令信标 / 缩放 / 平移 ----
  const toWorld = ev => {
    const cvs = el("fm-canvas");
    const r = cvs.getBoundingClientRect();
    const cam = sim.cameraView();
    const ax = ev.clientX - r.left;
    const ay = ev.clientY - r.top;
    return { x: (ax - cam.ox) / cam.zoom, y: (ay - cam.oy) / cam.zoom, ax, ay };
  };

  el("fm-canvas").addEventListener("contextmenu", ev => ev.preventDefault());

  el("fm-canvas").addEventListener("mousedown", ev => {
    if (!sim) return;
    // 中键：开始平移
    if (ev.button === 1) {
      ev.preventDefault();
      panning = { x: ev.clientX, y: ev.clientY, cx: sim.cameraView().x, cy: sim.cameraView().y };
      return;
    }
    // 右键：取消命令信标
    if (ev.button === 2) {
      ev.preventDefault();
      sim.squads[side].goal = null;
      return;
    }
  });

  // 左键单击 = 下达命令信标（拖动过就不算）
  let downAt = null;
  el("fm-canvas").addEventListener("pointerdown", ev => {
    if (ev.button === 0) downAt = { x: ev.clientX, y: ev.clientY };
  });
  el("fm-canvas").addEventListener("pointerup", ev => {
    if (!sim || ev.button !== 0 || !downAt) return;
    const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
    downAt = null;
    if (moved > 4) return;                       // 当成拖拽，不下命令
    const w = toWorld(ev);
    if (w.x < 0 || w.y < 0 || w.x > sim.width || w.y > sim.height) return;
    sim.command({ type: "setGoal", squadId: side, x: w.x, y: w.y });
  });

  el("fm-canvas").addEventListener("wheel", ev => {
    if (!sim) return;
    ev.preventDefault();
    const w = toWorld(ev);
    sim.command({ type: "setCamera", factor: ev.deltaY < 0 ? 1.12 : 1 / 1.12, ax: w.ax, ay: w.ay });
  }, { passive: false });

  // 中键平移
  window.addEventListener("mousemove", onPanMove);
  window.addEventListener("mouseup", onPanUp);

  // 导入地图：UI 只把文件读成 JSON，能不能用由 core 判定
  el("fm-map").addEventListener("click", () => el("fm-map-file").click());
  el("fm-map-file").addEventListener("change", async ev => {
    const input = ev.target;
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      store.getState().actions.message("error", "JSON 解析失败：" + err.message);
      return;
    }
    const r = sim.command({ type: "importMap", data, name: file.name });
    if (!r.ok) store.getState().actions.message("error", (r.reasons || []).join("；"));
    else store.getState().actions.message("ok", "预览地图已导入");
    if (draft) pushPreview();
  });

  // ---------------- 订阅快照 ----------------
  let lastSnap = null;
  let selectsReady = false;
  const unsub = store.subscribe(() => {
    const s = store.getState().snap;
    if (!s || s === lastSnap) return;
    lastSnap = s;

    // 船名要等第一份快照（shipList），所以下拉框晚一步填
    if (!selectsReady && (s.shipList || []).length) {
      fillSelects();
      selectsReady = true;
    }

    if (!curId && s.formationList && s.formationList.length) {
      curId = s.formationList[0].id;
      draft = null;
    }
    renderLib();
    renderParams();
    renderGlobal();
  });

  // ---------------- 启动 ----------------
  const first = lib()[0];
  if (first) { curId = first.id; draft = { ...first.p }; }
  renderLib();
  renderParams();
  renderGlobal();
  if ((snap()?.shipList || []).length) { fillSelects(); selectsReady = true; }

  startPreview().then(() => {
    rebuildPreview();
  }).catch(err => {
    console.error(err);
    el("fm-stage-note").textContent = "预览初始化失败";
  });

  return {
    destroy() {
      unsub();
      if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      window.removeEventListener("mousemove", onPanMove);
      window.removeEventListener("mouseup", onPanUp);
      try { simRenderer?.app?.destroy(true, { children: true }); } catch { /* 忽略 */ }
      sim = null; simRenderer = null;
    }
  };
}
