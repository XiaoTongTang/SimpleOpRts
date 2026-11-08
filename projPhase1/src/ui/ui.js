/**
 * 战斗指挥界面（游戏内）
 * -----------------------------------------------------------------
 * 样式与信息层级对照 design/261107_2机制改进/UI原型-1-战斗指挥.html，
 * 交互意图对照同目录《新的游戏界面设计.md》：
 *
 *   左栏：阵营切换 / 指挥信息 / 生产线 / 小队模板（一键建造）/ 构筑入口
 *   中间：战场（Pixi 画的），上面浮着小队标识与命令信标
 *   右栏：小队状态（名字 + 当前/编制 + 阵型切换 + 自动/受到命令），
 *         底部一个「取消当前选中小队命令信标」
 *
 * 纪律：
 *   1. 面板只读 store 的 snapshot（10 Hz），不读 core
 *   2. 任何写入都走 bridge.run(cmd)，UI 不自己判断合不合法
 *   3. 唯一例外是 `syncBattlefield(view)`：战场标识要跟 60 帧的位置走，
 *      所以主循环直接把只读投影递过来。它只挪 DOM，不改任何游戏状态。
 */

/** 阵型短名：只用于按钮上的字 */
const FORM_SHORT = {
  "form.standard": "标准",
  "form.guerrilla": "游击",
  "form.dense": "密集",
  "form.wide": "大间距"
};

export function mountUI({ store, bridge }) {
  const root = document.getElementById("ui-root");

  root.innerHTML = `
    <div class="stage">

      <aside class="col left">
        <div class="faction-bar">
          <span class="lbl">阵营</span>
          <button class="fbtn on" data-f="0">蓝方</button>
          <button class="fbtn" data-f="1">红方</button>
        </div>

        <div class="ccard">
          <div class="panel-head">指挥信息</div>
          <div class="sec">
            <div class="cmdval">
              <div class="lbl">指挥值</div>
              <div class="big"><b id="t-cmd">0</b><em id="t-cap">/ 900</em></div>
              <div class="bar"><i id="cmd-bar" style="width:0%"></i></div>
            </div>
            <div class="kv"><span>预制模组</span><b id="t-mod">0</b></div>
            <div class="kv"><span>舰船</span><b id="t-units">0</b></div>
          </div>
        </div>

        <div class="ccard">
          <div class="panel-head">生产线 <span class="n" id="t-lines"></span></div>
          <div class="sec" id="lines"></div>
        </div>

        <div class="ccard tplcard">
          <div class="panel-head">小队模板 <span class="n" id="tpl-n"></span></div>
          <div class="tpl-grid" id="tpl-grid"></div>
        </div>

        <div class="ccard navcard">
          <div class="panel-head">构筑</div>
          <div class="sec">
            <button class="navbtn" data-nav="ship">设计舰船<span>›</span></button>
            <button class="navbtn" data-nav="squad">构筑小队<span>›</span></button>
            <button class="navbtn" data-nav="form">阵型编辑<span>›</span></button>
          </div>
        </div>

        <div class="foot">
          <button class="btn" id="btn-pause">暂停</button>
          <button class="btn" id="btn-reset">重开</button>
        </div>
      </aside>

      <div class="field" id="field">
        <div class="field-label">战场 · SECTOR 7</div>
        <div class="field-hint">
          <span><kbd>拖拽</kbd> 框选</span>
          <span><kbd>单击地面</kbd> 下达命令信标</span>
          <span><kbd>Shift</kbd> 追加</span>
          <span><kbd>Esc</kbd> 取消选择</span>
        </div>
        <svg class="beacon-links" id="beacon-links"></svg>
        <div id="markers"></div>
        <div id="beacons"></div>
        <div class="marquee" id="marquee"></div>
      </div>

      <aside class="col right">
        <div class="panel-head">小队 <span class="n" id="sq-count"></span></div>
        <div class="scroll" id="squad-list"></div>
        <div class="cmd">
          <div class="sel-title">
            已选 <b id="sel-count">0</b> 队
            <span id="sel-cost" style="margin-left:auto"></span>
          </div>
          <button class="btn danger" id="cmd-clear-beacon" style="width:100%" disabled>
            取消当前选中小队命令信标
          </button>
        </div>
      </aside>
    </div>
    <div id="screen-root"></div>
    <div id="msg"></div>
  `;

  const el = id => document.getElementById(id);
  const listEl = el("squad-list");
  const fieldEl = el("field");
  const markersEl = el("markers");
  const beaconsEl = el("beacons");
  const linksEl = el("beacon-links");
  const marqueeEl = el("marquee");
  const msgEl = el("msg");

  // ---- 纯 UI 状态 ----
  let faction = 0;                 // 当前查看/指挥的阵营
  const selected = new Set();      // 选中的小队 id
  let lastView = null;             // 最近一帧的只读投影（只用来摆 DOM）
  let drag = null;                 // 框选
  let lastSig = { list: "", lines: "", tpls: "", top: "" };

  // ----------------------------------------------------------------
  // 交互工具
  // ----------------------------------------------------------------

  // 已解散的队伍也留在列表里（标记「解」），否则解散了就再也吸收不回来
  const mySquads = snap => (snap?.squads || []).filter(s => s.faction === faction);

  function pick(id, additive) {
    if (additive) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
    } else if (selected.has(id) && selected.size === 1) {
      selected.clear();
    } else {
      selected.clear();
      selected.add(id);
    }
    render();
  }

  function squadName(s) {
    return s.loose ? "散兵" : s.name || s.key;
  }

  // ---- 阵营切换 ----
  root.querySelectorAll(".fbtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const f = Number(btn.dataset.f);
      if (f === faction) return;
      faction = f;
      selected.clear();             // 不带跨阵营的选择
      lastSig = { list: "", lines: "", tpls: "", top: "" };
      render();
    });
  });

  // ---- 全局按钮 ----
  el("btn-pause").addEventListener("click", () => {
    const s = store.getState();
    bridge.run({ type: "setPaused", value: !(s.snap && s.snap.paused) });
  });
  el("btn-reset").addEventListener("click", () => {
    selected.clear();
    bridge.run({ type: "reset" });
  });

  // ---- 构筑入口：切换到舰船设计 / 小队构筑 ----
  // 这一段用动态 import，避免战斗界面白白加载两个构筑界面的代码
  let screen = null;             // { kind, api }
  let pausedBefore = null;

  async function openScreen(kind) {
    if (screen && screen.kind === kind) return;
    closeScreen();

    const snap = store.getState().snap;
    pausedBefore = snap ? snap.paused : null;

    let mod;
    if (kind === "ship") mod = await import("./screens/ship-design.js");
    else if (kind === "squad") mod = await import("./screens/squad-build.js");
    else return;

    const catalog = bridge.query({ type: "catalog" }) || { hulls: [], weapons: [], plugins: [] };
    const host = el("screen-root");
    host.innerHTML = "";
    document.querySelector(".stage").style.display = "none";

    if (!pausedBefore) bridge.run({ type: "setPaused", value: true });

    screen = {
      kind,
      api: mod[kind === "ship" ? "mountShipDesign" : "mountSquadBuild"](
        host, { store, bridge, catalog, onBack: closeScreen })
    };
  }

  function closeScreen() {
    if (!screen) return;
    screen.api?.destroy?.();
    screen = null;
    el("screen-root").innerHTML = "";
    document.querySelector(".stage").style.display = "";
    if (pausedBefore === false) bridge.run({ type: "setPaused", value: false });
    pausedBefore = null;
    lastSig = { list: "", lines: "", tpls: "", top: "" };
    render();
  }

  root.querySelectorAll("[data-nav]").forEach(btn => {
    btn.addEventListener("click", () => openScreen(btn.dataset.nav));
  });

  // ---- 命令信标：点地面 ----
  el("cmd-clear-beacon").addEventListener("click", () => {
    const ids = [...selected];
    if (!ids.length) return;
    bridge.run({ type: "clearGoal", squadIds: ids });
  });

  // ---- 框选 / 点击地面 ----
  fieldEl.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    if (e.target.closest(".marker")) return;
    const r = fieldEl.getBoundingClientRect();
    drag = { x0: e.clientX - r.left, y0: e.clientY - r.top, r, moved: false };
    marqueeEl.style.display = "block";
    marqueeEl.style.left = drag.x0 + "px";
    marqueeEl.style.top = drag.y0 + "px";
    marqueeEl.style.width = "0px";
    marqueeEl.style.height = "0px";
  });

  fieldEl.addEventListener("mousemove", e => {
    if (!drag) return;
    const r = drag.r;
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const left = Math.min(x, drag.x0), top = Math.min(y, drag.y0);
    const w = Math.abs(x - drag.x0), h = Math.abs(y - drag.y0);
    if (w > 4 || h > 4) drag.moved = true;
    marqueeEl.style.left = left + "px";
    marqueeEl.style.top = top + "px";
    marqueeEl.style.width = w + "px";
    marqueeEl.style.height = h + "px";
    drag.box = { left, top, w, h };
  });

  window.addEventListener("mouseup", e => {
    if (!drag) return;
    marqueeEl.style.display = "none";
    const d = drag;
    drag = null;
    if (d.moved && d.box) {
      // 框选：把质心落在框里的小队选上（世界坐标 = 屏幕坐标，相机是 1:1）
      const box = d.box;
      const snap = store.getState().snap;
      const hit = mySquads(snap).filter(s => {
        const x = s.x - d.r.left, y = s.y - d.r.top;
        return x >= box.left && x <= box.left + box.w && y >= box.top && y <= box.top + box.h;
      });
      selected.clear();
      for (const s of hit) selected.add(s.id);
      render();
      return;
    }

    // 单击地面：坐标换算回世界，给选中的小队下命令信标
    if (!selected.size) return;
    const cam = (lastView && lastView.camera) || { ox: 0, oy: 0, zoom: 1 };
    const wx = (e.clientX - cam.ox) / cam.zoom;
    const wy = (e.clientY - cam.oy) / cam.zoom;
    bridge.run({ type: "setGoal", squadIds: [...selected], x: wx, y: wy });
  });

  // Esc：取消选择
  window.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    selected.clear();
    render();
  });

  // ----------------------------------------------------------------
  // 面板渲染（跟着 snapshot，10 Hz）
  // ----------------------------------------------------------------

  function render() {
    const { snap, msg } = store.getState();
    if (!snap) return;

    const fstat = (snap.factions || []).find(x => x.faction === faction) || {
      commandUsed: 0, commandCap: snap.commandCap, ships: 0, squads: 0
    };

    // ---- 顶部：指挥信息 ----
    const topSig = [faction, fstat.commandUsed, fstat.commandCap, snap.modules, fstat.ships].join("|");
    if (topSig !== lastSig.top) {
      lastSig.top = topSig;
      el("t-cmd").textContent = fstat.commandUsed;
      el("t-cap").textContent = `/ ${fstat.commandCap}`;
      el("t-cmd").className = fstat.commandUsed > fstat.commandCap ? "warn" : "";
      el("cmd-bar").style.width = Math.min(100, fstat.commandUsed / fstat.commandCap * 100) + "%";
      el("cmd-bar").style.background = fstat.commandUsed > fstat.commandCap ? "#e8564f" : "";
      el("t-mod").textContent = snap.modules;
      el("t-units").textContent = fstat.ships;
      root.querySelectorAll(".fbtn").forEach(b =>
        b.classList.toggle("on", Number(b.dataset.f) === faction));
    }

    // ---- 生产线 ----
    const fac = (snap.production || []).find(p => p.faction === faction);
    const linesSig = fac
      ? fac.lines.map(l => `${l.alloc}:${l.job ? l.job.id + ":" + l.job.pct.toFixed(2) : "-"}`).join("|")
        + "|" + snap.modules + "/" + snap.moduleCap
      : "none";
    if (linesSig !== lastSig.lines) {
      lastSig.lines = linesSig;
      if (!fac) {
        el("lines").innerHTML = `<div class="note">这个阵营没有生产线</div>`;
      } else {
        el("t-lines").textContent = `${fac.lines.length} 条 · 效率 ${fac.efficiencyTotal}`;
        el("lines").innerHTML = fac.lines.map((l, i) => {
          const no = String(i + 1).padStart(2, "0");
          if (!l.job) {
            return `
              <div class="line">
                <div class="top">
                  <span class="no">${no}</span>
                  <span class="st idle">空闲</span>
                  <span class="nm">生产预制模组</span>
                  <span class="pct">${snap.modules}/${snap.moduleCap}</span>
                </div>
                <div class="bar mod"><i style="width:${Math.min(100, snap.modules / snap.moduleCap * 100)}%"></i></div>
                <div class="note">生产线闲置时自动产出预制模组</div>
              </div>`;
          }
          return `
            <div class="line">
              <div class="top">
                <span class="no">${no}</span>
                <span class="st build">建造中</span>
                <span class="nm">${l.job.name}</span>
                <span class="pct">${Math.round(l.job.pct * 100)}%</span>
              </div>
              <div class="bar"><i style="width:${(l.job.pct * 100).toFixed(1)}%"></i></div>
            </div>`;
        }).join("");
      }
    }

    // ---- 小队模板（一键建造） ----
    const tpls = snap.templates || [];
    const tplSig = tpls.map(t => `${t.id}:${t.entries.reduce((n, e) => n + e.n, 0)}:${t.usedBy}`).join("|")
      + "|" + snap.modules;
    if (tplSig !== lastSig.tpls) {
      lastSig.tpls = tplSig;
      el("tpl-n").textContent = tpls.length;
      el("tpl-grid").innerHTML = tpls.map(t => {
        const ships = t.entries.reduce((n, e) => n + e.n, 0);
        const cost = ships;                       // 1 模组 / 艘
        const lack = snap.modules < cost;
        return `
          <div class="tpl-card">
            <div class="tn" title="${t.desc || t.name}">${t.name}</div>
            <div class="tm">${ships} 舰 · ${cost} 模组</div>
            <button class="tbtn${lack ? " lack" : ""}" data-tpl="${t.id}">一键建造</button>
          </div>`;
      }).join("");

      el("tpl-grid").querySelectorAll("[data-tpl]").forEach(btn => {
        btn.addEventListener("click", () => {
          const r = bridge.run({ type: "buildFromTemplate", templateId: btn.dataset.tpl, faction });
          if (r.ok) {
            btn.textContent = "✓ 已建造";
            btn.classList.add("done");
            setTimeout(() => render(), 900);
          }
        });
      });
    }

    // ---- 右侧：小队列表 ----
    const mine = mySquads(snap);
    const listSig = mine.map(s =>
      [s.id, s.name, s.alive, s.count, s.form, s.formations.join(","),
       s.goal ? "g" : "-", s.active === false ? "d" : "", selected.has(s.id) ? "s" : ""].join(":")
    ).join("|");
    if (listSig !== lastSig.list) {
      lastSig.list = listSig;
      listEl.innerHTML = mine.map(s => {
        const sel = selected.has(s.id) ? " sel" : "";
        const num = s.loose ? `${s.alive}` : `${s.alive}<em>/${s.count}</em>`;
        const chips = (s.formations || []).map(f => `
          <button class="fchip${f === s.form ? " on" : ""}" data-key="${s.id}" data-form="${f}"
                  title="${FORM_SHORT[f] || f}">${FORM_SHORT[f] || f}</button>`).join("");
        const pool = s.loose;
        return `
          <div class="squad-row${sel}${s.alive === 0 || s.active === false ? " dead" : ""}"
               data-key="${s.id}"${s.active === false ? ' data-dead="1"' : ""}>
            <span class="nm">${squadName(s)}${s.active === false ? " · 解" : ""}</span>
            <span class="alive">${num}</span>
            <div class="forms-row">
              <span class="status-chip${s.goal ? " ord" : ""}">${s.goal ? "受到命令" : "自动状态"}</span>
              ${s.goal ? `<button class="cancel-cmd" data-cancel="${s.id}">取消命令</button>` : ""}
              <span class="spacer"></span>
              ${pool ? "" : `<i>阵型</i>${chips}`}
            </div>
            <div class="acts-row">
              ${pool ? "" : `<button class="sbtn warn" data-disband="${s.id}">解散小队</button>`}
              <button class="sbtn${pool || !s.template ? " dis" : ""}" data-absorb="${s.id}"
                      ${pool || !s.template ? "disabled" : ""}
                      title="${pool ? "散兵池不能吸收" : !s.template ? "无编制小队不能吸收" : "从散兵池补满编制"}">吸收散兵补充编制</button>
              <span class="spacer"></span>
            </div>
          </div>`;
      }).join("");

      listEl.querySelectorAll(".squad-row").forEach(row => {
        row.addEventListener("click", e => pick(Number(row.dataset.key), e.shiftKey));
      });
      listEl.querySelectorAll(".fchip").forEach(chip => {
        chip.addEventListener("click", e => {
          e.stopPropagation();
          bridge.run({ type: "setFormation", squadId: Number(chip.dataset.key), form: chip.dataset.form });
        });
      });
      listEl.querySelectorAll("[data-cancel]").forEach(btn => {
        btn.addEventListener("click", e => {
          e.stopPropagation();
          bridge.run({ type: "clearGoal", squadId: Number(btn.dataset.cancel) });
        });
      });
      listEl.querySelectorAll("[data-disband]").forEach(btn => {
        btn.addEventListener("click", e => {
          e.stopPropagation();
          const id = Number(btn.dataset.disband);
          const s = mine.find(x => x.id === id);
          if (s && confirm(`解散「${squadName(s)}」？舰船会退回散兵池。`)) {
            bridge.run({ type: "disband", squadId: id });
          }
        });
      });
      listEl.querySelectorAll("[data-absorb]").forEach(btn => {
        btn.addEventListener("click", e => {
          e.stopPropagation();
          if (btn.classList.contains("dis")) return;
          bridge.run({ type: "absorb", squadId: Number(btn.dataset.absorb) });
        });
      });

      // 同步战场标识（名字/数字/选中态）与右侧数量
      el("sq-count").textContent = `${mine.length} 队`;
      syncMarkers(snap);
    }

    // ---- 底部：选择摘要 ----
    const chosen = mine.filter(s => selected.has(s.id));
    let units = 0, max = 0, cost = 0, beacons = 0;
    for (const s of chosen) {
      units += s.alive;
      max += s.loose ? s.alive : s.count;
      cost += s.cost || 0;
      if (s.goal) beacons++;
    }
    el("sel-count").textContent = chosen.length;
    el("sel-cost").innerHTML = chosen.length
      ? `<span style="font-family:var(--mono)">${units}/${max} 舰 · ${cost} 指挥值</span>`
      : "";
    const clearBtn = el("cmd-clear-beacon");
    clearBtn.disabled = beacons === 0;
    clearBtn.textContent = beacons
      ? `取消当前选中小队命令信标（${beacons}）`
      : "取消当前选中小队命令信标";

    // ---- 提示 ----
    if (msg && Date.now() - msg.at < 2600) {
      msgEl.className = msg.kind;
      msgEl.textContent = (msg.kind === "error" ? "✕ " : "✓ ") + msg.text;
    } else {
      msgEl.className = "";
      msgEl.textContent = "";
    }

    el("btn-pause").textContent = snap.paused ? "继续" : "暂停";

    // 战场标识跟着最新快照重建一次（数量/状态变了）
    syncMarkers(snap);
  }

  // ----------------------------------------------------------------
  // 战场标识与信标
  // ----------------------------------------------------------------

  /** 按快照重建标识（只在数量/文字/选择变化时调用） */
  function syncMarkers(snap) {
    const mine = mySquads(snap);
    // 场上没船（被打光 / 已解散）的队伍不画标识，否则会全堆在左上角
    const live = mine.filter(s => s.alive > 0);
    const want = new Set(live.map(s => s.id));

    // 删掉不在本阵营/没船的
    for (const node of [...markersEl.children]) {
      if (!want.has(Number(node.dataset.key))) node.remove();
    }

    for (const s of live) {
      let node = markersEl.querySelector(`[data-key="${s.id}"]`);
      if (!node) {
        node = document.createElement("div");
        node.className = "marker";
        node.dataset.key = s.id;
        node.innerHTML = `<span class="nm"></span><span class="cnt"></span>`;
        node.addEventListener("click", e => {
          e.stopPropagation();
          pick(s.id, e.shiftKey);
        });
        markersEl.appendChild(node);
      }
      node.classList.toggle("sel", selected.has(s.id));
      node.classList.toggle("dead", s.active === false);
      node.querySelector(".nm").textContent = squadName(s);
      node.querySelector(".cnt").textContent = s.loose
        ? `${s.alive}` : `${s.alive}/${s.count}`;
    }
  }

  /** 每帧：把标识/信标挪到最新位置（世界坐标 → 战场内的 px） */
  function syncBattlefield(view) {
    if (screen) return;            // 打开构筑界面时战场不可见，不用摆标识
    lastView = view;
    const r = fieldEl.getBoundingClientRect();
    const cam = view.camera || { ox: 0, oy: 0, zoom: 1 };
    const sx = x => x * cam.zoom + cam.ox - r.left;
    const sy = y => y * cam.zoom + cam.oy - r.top;

    for (const sq of view.squads) {
      const node = markersEl.querySelector(`[data-key="${sq.id}"]`);
      if (!node) continue;
      // 贴边的小队把标识夹在战场内，别让名字被切掉
      const x = Math.min(Math.max(sx(sq.cx), 56), r.width - 56);
      const y = Math.min(Math.max(sy(sq.cy), 16), r.height - 16);
      node.style.left = x + "px";
      node.style.top = y + "px";
    }

    // 信标 + 连线：只画当前阵营、且有 goal 的队伍
    const mine = view.squads.filter(s => s.faction === faction && s.goal);
    linksEl.setAttribute("viewBox", `0 0 ${r.width} ${r.height}`);
    linksEl.setAttribute("preserveAspectRatio", "none");

    // 复用节点：按 squad id 建
    const seen = new Set();
    for (const sq of mine) {
      seen.add(sq.id);
      let line = linksEl.querySelector(`[data-line="${sq.id}"]`);
      if (!line) {
        line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.dataset.line = sq.id;
        line.setAttribute("class", "beacon-line");
        linksEl.appendChild(line);
      }
      line.setAttribute("x1", sx(sq.cx));
      line.setAttribute("y1", sy(sq.cy));
      line.setAttribute("x2", sx(sq.goal.x));
      line.setAttribute("y2", sy(sq.goal.y));
      line.classList.toggle("on", selected.has(sq.id));

      let b = beaconsEl.querySelector(`[data-beacon="${sq.id}"]`);
      if (!b) {
        b = document.createElement("div");
        b.className = "beacon";
        b.dataset.beacon = sq.id;
        b.innerHTML = "<i></i>";
        beaconsEl.appendChild(b);
      }
      b.style.left = sx(sq.goal.x) + "px";
      b.style.top = sy(sq.goal.y) + "px";
      b.classList.toggle("on", selected.has(sq.id));
    }
    for (const node of [...linksEl.children]) {
      if (!seen.has(Number(node.dataset.line))) node.remove();
    }
    for (const node of [...beaconsEl.children]) {
      if (!seen.has(Number(node.dataset.beacon))) node.remove();
    }
  }

  store.subscribe(render);
  render();

  return { syncBattlefield };
}
