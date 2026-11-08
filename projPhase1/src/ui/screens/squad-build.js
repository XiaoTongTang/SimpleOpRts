/**
 * 小队构筑界面
 * -----------------------------------------------------------------
 * 对照 design/261107_2机制改进/UI原型-3-小队构筑.html 与《新的游戏界面设计.md》：
 *   左：所有编制模板
 *   中：这个编制里有哪些船（一型一张卡）
 *   右：本队总数值（血/盾/总 DPS/人口）+ 编制（加减数量、删条目）
 *       底部「添加舰船」→ 左侧滑出舰船方案选择，选中后按「确认」加入编制
 *
 * 注意：改编制是**追溯**的 —— 引用了这个模板的小队会立刻剔除多出来的船。
 */

import { spriteCell, applySprite, paint, fmtNum } from "./util.js";

export function mountSquadBuild(root, { store, bridge, catalog, onBack }) {
  const hulls = catalog.hulls || [];

  let selTplId = null;
  let addOpen = false;        // 添加舰船面板
  let pickedShip = null;      // 面板里选中的方案

  root.innerHTML = `
    <div class="screen">
      <div class="screen-head">
        <button class="btn" data-act="back">← 返回战场</button>
        <span class="screen-title">小队构筑</span>
        <span class="screen-hint">改编制会追溯：引用它的小队立刻剔除多出来的船，阵型重置为默认</span>
      </div>
      <div class="sb-body">
        <aside class="sb-left">
          <div class="panel-head">编制模板 <span class="n" id="sb-count"></span></div>
          <div class="scroll" id="sb-list"></div>
          <div class="btns sb-btns">
            <button class="btn" data-act="newtpl">新建编制</button>
            <button class="btn" data-act="deltpl">删除</button>
          </div>
        </aside>

        <div class="sb-stage">
          <div class="panel-head">编制内容 <span class="n" id="sb-fleet-n"></span></div>
          <div class="fleet" id="sb-fleet"></div>
        </div>

        <aside class="sb-right">
          <div class="panel-head">本队信息</div>
          <div class="sec" id="sb-stats"></div>

          <div class="panel-head">编制 <span class="n" id="sb-entries-n"></span></div>
          <div class="scroll sb-entries" id="sb-entries"></div>
          <div class="btns sb-btns">
            <button class="btn primary" data-act="add">添加舰船</button>
          </div>

          <div class="panel-head">默认阵型</div>
          <div class="sec" id="sb-forms"></div>
        </aside>
      </div>

      <div class="ship-picker" id="sb-picker" hidden>
        <div class="picker-head">
          <span>选择舰船方案</span>
          <button class="mini-x" data-close>✕</button>
        </div>
        <div class="scroll picker-list" id="sb-picker-list"></div>
        <div class="picker-foot">
          <button class="btn primary" data-act="confirm" disabled>确认加入编制</button>
        </div>
      </div>
    </div>
  `;

  const el = id => root.querySelector("#" + id);
  const $ = sel => root.querySelector(sel);

  // ----------------------------------------------------------------

  function templates() { return store.getState().snap?.templates || []; }
  function ships() { return store.getState().snap?.shipList || []; }
  function curTpl() { return templates().find(t => t.id === selTplId) || null; }

  function editEntries(entries) {
    const t = curTpl();
    if (!t) return;
    bridge.run({ type: "editSquadTemplate", templateId: t.id, entries });
  }

  function entriesWith(t, shipId, delta) {
    const list = t.entries.map(e => ({ ship: e.ship, n: e.n }));
    const hit = list.find(e => e.ship === shipId);
    if (hit) hit.n += delta;
    else if (delta > 0) list.push({ ship: shipId, n: delta });
    return list.filter(e => e.n > 0);
  }

  // ---- 顶部按钮 ----
  $('[data-act="back"]').addEventListener("click", onBack);

  $('[data-act="newtpl"]').addEventListener("click", () => {
    const r = bridge.run({ type: "createSquadTemplate", name: "新编制" });
    if (r.ok && r.id) { selTplId = r.id; addOpen = false; render(); }
  });

  $('[data-act="deltpl"]').addEventListener("click", () => {
    const t = curTpl();
    if (!t) return;
    if (!confirm(`删除编制「${t.name}」？`)) return;
    const r = bridge.run({ type: "deleteSquadTemplate", templateId: t.id });
    if (r.ok) { selTplId = null; render(); }
  });

  $('[data-act="add"]').addEventListener("click", () => {
    if (!curTpl()) return;
    addOpen = true;
    pickedShip = null;
    render();
  });

  el("sb-picker").addEventListener("click", e => e.stopPropagation());
  $('[data-close]').addEventListener("click", () => {
    addOpen = false;
    render();
  });
  $('[data-act="confirm"]').addEventListener("click", () => {
    const t = curTpl();
    if (!t || !pickedShip) return;
    editEntries(entriesWith(t, pickedShip, 1));
    addOpen = false;
    pickedShip = null;
    render();
  });

  // ----------------------------------------------------------------
  // 绘制
  // ----------------------------------------------------------------

  function render() {
    const { snap } = store.getState();
    if (!snap) return;
    const list = templates();
    if (!selTplId || !list.some(t => t.id === selTplId)) selTplId = list[0]?.id || null;

    const t = curTpl();
    el("sb-count").textContent = list.length;

    paintList(list, t);
    paintFleet(t);
    paintStats(t);
    paintEntries(t);
    paintForms(t);
    paintPicker(t);
  }

  function paintList(list, t) {
    paint(el("sb-list"), list.map(x => `${x.id}:${x.name}:${x.stats.ships}:${x.usedBy}`).join("|")
      + "|" + (t?.id || ""), () => list.map(x => `
        <div class="row tplrow${x.id === t?.id ? " sel" : ""}" data-tpl="${x.id}">
          <span class="k">${x.name}</span>
          <span class="v">${x.stats.ships} 舰</span>
          <span class="c">${x.usedBy > 0 ? x.usedBy + " 队" : "—"}</span>
        </div>`).join(""));

    el("sb-list").querySelectorAll("[data-tpl]").forEach(row => {
      row.addEventListener("click", () => {
        selTplId = row.dataset.tpl;
        addOpen = false;
        render();
      });
    });
  }

  function paintFleet(t) {
    const box = el("sb-fleet");
    if (!t) { box.innerHTML = `<div class="line sub">左边选一个编制</div>`; return; }

    el("sb-fleet-n").textContent = `${t.stats.ships} 艘`;
    paint(box, t.id + "|" + t.entries.map(e => `${e.ship}:${e.n}`).join(","), () => {
      if (!t.entries.length) {
        return `<div class="line sub">这个编制还是空的，按右侧「添加舰船」往里放</div>`;
      }
      return t.entries.map(e => {
        const s = ships().find(x => x.id === e.ship);
        const h = hulls.find(x => x.id === s?.hull);
        const cell = spriteCell({ id: s?.hull }, h);
        const pos = `background-position:calc(${-cell.col} * var(--u)) calc(${-cell.row} * var(--u))`;
        return `
          <div class="fleetcard" data-ship="${e.ship}">
            <i class="sprite card" style="${pos}"></i>
            <div class="fc-head">
              <b>${e.name}</b>
              <span class="fc-n">× ${e.n}</span>
            </div>
            <div class="fc-sub">
              血量 ${fmtNum(e.single?.hp)} · 护盾 ${fmtNum(e.single?.shield)} ·
              DPS ${fmtNum(e.single?.dps)} · 指挥 ${e.single?.command ?? 0}
            </div>
          </div>`;
      }).join("");
    });
  }

  function paintStats(t) {
    const box = el("sb-stats");
    if (!t) { box.innerHTML = ""; return; }
    const s = t.stats;
    paint(box, `${s.ships}:${s.hp}:${s.shield}:${s.dps}:${s.command}`, () => `
      <div class="kv"><span>总血量</span><b>${fmtNum(s.hp)}</b></div>
      <div class="kv"><span>总护盾</span><b>${fmtNum(s.shield)}</b></div>
      <div class="kv"><span>总 DPS（单体）</span><b>${fmtNum(s.dps)}</b></div>
      <div class="kv"><span>人口占用</span><b>${s.command}</b></div>
      <div class="kv"><span>舰船数</span><b>${s.ships}</b></div>
    `);
  }

  function paintEntries(t) {
    const box = el("sb-entries");
    if (!t) { box.innerHTML = ""; return; }
    el("sb-entries-n").textContent = t.entries.length;

    paint(box, t.id + "|" + t.entries.map(e => `${e.ship}:${e.n}`).join(","), () => {
      if (!t.entries.length) return `<div class="line sub">空编制</div>`;
      return t.entries.map(e => `
        <div class="line entryrow">
          <span class="nm">${e.name}</span>
          <div class="stepper">
            <button data-ship="${e.ship}" data-d="-1">−</button>
            <b>${e.n}</b>
            <button data-ship="${e.ship}" data-d="1">＋</button>
          </div>
          <button class="mini-x" data-del="${e.ship}" title="从编制里删掉">✕</button>
        </div>`).join("");
    });

    box.querySelectorAll("[data-d]").forEach(btn => {
      btn.addEventListener("click", () => {
        editEntries(entriesWith(t, btn.dataset.ship, Number(btn.dataset.d)));
      });
    });
    box.querySelectorAll("[data-del]").forEach(btn => {
      btn.addEventListener("click", () => {
        editEntries(t.entries.filter(e => e.ship !== btn.dataset.del)
          .map(e => ({ ship: e.ship, n: e.n })));
      });
    });
  }

  function paintForms(t) {
    const box = el("sb-forms");
    if (!t) { box.innerHTML = ""; return; }
    paint(box, t.id + "|" + t.formations.join(","), () => `
      <div class="formchips">
        ${(t.formations || []).map((f, i) => `
          <button class="fchip${i === 0 ? " on" : ""}" data-form="${f}"
                  title="${i === 0 ? "当前默认阵型" : "点一下设为默认"}">${formName(f)}</button>`).join("")}
      </div>
      <div class="line sub">第一个是默认阵型；改编制时小队会被重置成它</div>
    `);

    box.querySelectorAll("[data-form]").forEach(btn => {
      btn.addEventListener("click", () => {
        const f = btn.dataset.form;
        if (t.formations[0] === f) return;
        const rest = t.formations.filter(x => x !== f);
        bridge.run({
          type: "editSquadTemplate",
          templateId: t.id,
          formations: [f, ...rest]
        });
      });
    });
  }

  function formName(id) {
    return {
      "form.standard": "标准", "form.guerrilla": "游击",
      "form.dense": "密集", "form.wide": "大间距"
    }[id] || id;
  }

  function paintPicker(t) {
    const box = el("sb-picker");
    box.hidden = !addOpen;
    if (!addOpen) return;

    paint(el("sb-picker-list"), ships().map(s => `${s.id}:${s.name}:${s.capacityUsed}`).join("|")
      + "|" + (pickedShip || ""), () => ships().map(s => {
        const h = hulls.find(x => x.id === s.hull);
        const cell = spriteCell({ id: s.hull }, h);
        const pos = `background-position:calc(${-cell.col} * var(--u)) calc(${-cell.row} * var(--u))`;
        const wn = (s.weapons || []).map(w => w.name).join("、") || "无武器";
        const pn = (s.plugins || []).map(p => p.name).join("、") || "无插件";
        return `
          <div class="item${pickedShip === s.id ? " current" : ""}" data-pick="${s.id}">
            <i class="sprite mini" style="${pos}"></i>
            <div class="pick-body">
              <div class="it-top"><b>${s.name}</b>
                <span class="cap">${s.command} 指挥 · ${s.capacityUsed}/${s.capacity}</span></div>
              <div class="it-sub">血量 ${fmtNum(s.armor?.hp)} · 护盾 ${fmtNum(s.armor?.shield)} · DPS ${fmtNum(s.dps)}</div>
              <div class="it-sub">武器：${wn}</div>
              <div class="it-sub">插件：${pn}</div>
            </div>
          </div>`;
      }).join(""));

    el("sb-picker-list").querySelectorAll("[data-pick]").forEach(node => {
      node.addEventListener("click", () => {
        pickedShip = node.dataset.pick;
        render();
      });
    });
    $('[data-act="confirm"]').disabled = !pickedShip;
  }

  const unsub = store.subscribe(render);
  render();

  return { destroy() { unsub(); } };
}
