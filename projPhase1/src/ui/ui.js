/**
 * UI 层（阶段一用原生 DOM 搭，之后整体换成 React）
 * -----------------------------------------------------------------
 * 三条纪律在这里落地：
 *   1. 只读 store，不读 core
 *   2. 任何编辑都走 bridge.run(cmd)，自己**不判断**合不合法
 *   3. 不注册 rAF —— 渲染由 main.js 的单一主循环负责
 *
 * 唯一的例外是「预览」：改装配前先问 bridge.query({type:"previewFit"})，
 * 拿到 ok/reasons 再决定要不要发命令。查询不写状态，所以不算破坏纪律。
 *
 * 换 React 时，这个文件被替换成组件树，仓库其余部分不动。
 */

import { actions } from "../store/gameStore.js";

const RANK = { S: 0, M: 1, L: 2 };

export function mountUI({ store, bridge }) {
  const root = document.getElementById("ui-root");

  root.innerHTML = `
    <div class="card" id="hud">
      <div class="brand">Phase 1 · 架构骨架</div>
      <div class="kv"><span>单位总数</span><b data-f="units">0</b></div>
      <div class="kv"><span>指挥值</span><b data-f="cmd">0 / 0</b></div>
      <div class="kv"><span>预制模组</span><b data-f="mod">0</b></div>
      <div class="kv"><span>FPS</span><b data-f="fps">0</b></div>
      <div class="btns">
        <button data-act="pause">暂停</button>
        <button data-act="reset">重开</button>
      </div>
    </div>

    <div class="card" id="panel">
      <div class="title">小队编制 <span class="hint">点击选中</span></div>
      <div id="list"></div>

      <div class="title">选中的小队</div>
      <div id="editor"></div>
      <div class="btns">
        <button data-act="absorb">吸收散兵补满</button>
        <button data-act="disband">解散小队</button>
      </div>

      <div class="title">编制模板 <span class="hint">改动会追溯所有引用它的小队</span></div>
      <div id="tpls"></div>

      <div class="title">舰船方案库 <span class="hint">点击编辑装配</span></div>
      <div id="ships"></div>
      <div class="btns">
        <button data-act="newShip">新建</button>
        <button data-act="dupShip">复制</button>
        <button data-act="delShip">删除</button>
      </div>

      <div class="title">装配</div>
      <div id="fit"></div>

      <div class="title">散兵池</div>
      <div id="pool"></div>

      <div class="title">生产线 <span class="hint">阵营 0 · 效率/分钟</span></div>
      <div id="prod"></div>
      <div class="btns">
        <button data-act="queue">排队建造 +1</button>
        <button data-act="instant">快速建造 +1</button>
      </div>

      <div id="msg"></div>
      <div class="foot">
        core 是真相源 · UI 只发命令
      </div>
    </div>
  `;

  const hud = {
    units: root.querySelector('[data-f="units"]'),
    cmd: root.querySelector('[data-f="cmd"]'),
    mod: root.querySelector('[data-f="mod"]'),
    fps: root.querySelector('[data-f="fps"]')
  };
  const listEl = root.querySelector("#list");
  const editorEl = root.querySelector("#editor");
  const shipsEl = root.querySelector("#ships");
  const fitEl = root.querySelector("#fit");
  const poolEl = root.querySelector("#pool");
  const tplsEl = root.querySelector("#tpls");
  const prodEl = root.querySelector("#prod");
  const msgEl = root.querySelector("#msg");
  const pauseBtn = root.querySelector('[data-act="pause"]');
  const resetBtn = root.querySelector('[data-act="reset"]');

  // 当前选中的小队（吸收 / 解散 / 下生产单都以它为准）
  const curSquad = () => {
    const s = store.getState();
    const list = s.snap?.squads || [];
    return list.find(x => x.id === s.selectedId) || list.find(x => !x.loose) || list[0] || null;
  };

  root.querySelector('[data-act="absorb"]').addEventListener("click", () => {
    const sq = curSquad();
    if (sq) bridge.run({ type: "absorb", squadId: sq.id });
  });

  root.querySelector('[data-act="disband"]').addEventListener("click", () => {
    const sq = curSquad();
    if (!sq) return;
    if (sq.loose) return actions.message("error", "散兵池不能解散");
    if (!confirm(`解散「${sq.key}」？舰船会退回散兵池。`)) return;
    bridge.run({ type: "disband", squadId: sq.id });
  });

  // 生产：造「方案库里选中的那一型」，出锅进散兵池（不绑小队）
  const buildShipId = () => {
    const s = store.getState();
    return s.selectedShipId || (s.snap?.shipList || [])[0]?.id || null;
  };

  root.querySelector('[data-act="queue"]').addEventListener("click", () => {
    const shipId = buildShipId();
    if (!shipId) return actions.message("error", "先在方案库里选一个方案");
    bridge.run({ type: "queueShip", faction: 0, shipId, count: 1 });
  });

  root.querySelector('[data-act="instant"]').addEventListener("click", () => {
    const shipId = buildShipId();
    if (!shipId) return actions.message("error", "先在方案库里选一个方案");
    bridge.run({ type: "instantBuild", faction: 0, shipId, count: 1 });
  });

  // 静态目录：武器/插件/船体，只问一次
  const catalog = bridge.query({ type: "catalog" }) || { weapons: [], plugins: [] };

  pauseBtn.addEventListener("click", () => {
    const s = store.getState();
    bridge.run({ type: "setPaused", value: !(s.snap && s.snap.paused) });
  });
  resetBtn.addEventListener("click", () => bridge.run({ type: "reset" }));

  root.querySelector('[data-act="newShip"]').addEventListener("click", () => {
    const s = store.getState();
    const cur = (s.snap?.shipList || []).find(x => x.id === s.selectedShipId);
    const hull = cur?.hull || "hull.falcon";
    const r = bridge.run({ type: "createShip", hull, name: "新方案" });
    if (r.ok && r.id) actions.selectShip(r.id);
  });

  root.querySelector('[data-act="dupShip"]').addEventListener("click", () => {
    const s = store.getState();
    if (!s.selectedShipId) return;
    const r = bridge.run({ type: "duplicateShip", shipId: s.selectedShipId });
    if (r.ok && r.id) actions.selectShip(r.id);
  });

  root.querySelector('[data-act="delShip"]').addEventListener("click", () => {
    const s = store.getState();
    if (!s.selectedShipId) return;
    const ship = (s.snap?.shipList || []).find(x => x.id === s.selectedShipId);
    if (!ship) return;
    if (!confirm(`删除方案「${ship.name}」？`)) return;
    const r = bridge.run({ type: "deleteShip", shipId: ship.id });
    if (r.ok) actions.selectShip(null);
  });

  // 编辑区只在「选中 / 编制变化」时重建，否则会打断下拉框的交互
  let editorSig = "";
  let shipsSig = "";
  let fitSig = "";
  let prodSig = "";
  let poolSig = "";
  let tplSig = "";

  /** 阵型短名：只用于按钮上的字 */
  const FORM_SHORT = {
    "form.standard": "标准",
    "form.guerrilla": "游击",
    "form.dense": "密集",
    "form.wide": "大间距"
  };

  function render() {
    const { snap, selectedId, selectedShipId, fps, msg } = store.getState();

    // ---- HUD ----
    if (snap) {
      hud.units.textContent = snap.unitCount;
      hud.cmd.textContent = snap.commandUsed + " / " + snap.commandCap;
      hud.mod.textContent = snap.modules;
      hud.cmd.className = snap.commandUsed > snap.commandCap * 0.9 ? "warn" : "";
      pauseBtn.textContent = snap.paused ? "继续" : "暂停";
    }
    hud.fps.textContent = fps;

    if (!snap) return;

    // ---- 小队列表 ----
    listEl.innerHTML = snap.squads.map(s => {
      const sel = s.id === selectedId ? " sel" : "";
      const dead = (s.alive === 0 || s.active === false) ? " dead" : "";
      const num = s.loose ? `${s.alive}` : `${s.alive}<em>/${s.count}</em>`;
      const tag = s.active === false ? `<em>解</em>` : "";
      return `
        <div class="row${sel}${dead}" data-id="${s.id}"
             title="${s.loose ? `散兵池 · ${s.alive} 艘未编队`
               : s.active === false ? `已解散 · 编制 ${s.count} 艘还在`
               : `${s.shipName} × ${s.count}`}">
          <i style="background:hsl(${s.hue},72%,58%)"></i>
          <span class="k">${s.key}${tag}</span>
          <span class="v">${num}</span>
          <span class="c">${s.cost}</span>
        </div>`;
    }).join("");

    listEl.querySelectorAll(".row").forEach(row => {
      row.addEventListener("click", () => {
        store.setState({ selectedId: Number(row.dataset.id) });
      });
    });

    // ---- 小队编辑区 ----
    const sel = snap.squads.find(s => s.id === selectedId) || snap.squads[0];
    if (sel) {
      const sig = [sel.id, sel.template, sel.count, sel.alive, sel.form,
                   (sel.entries || []).map(e => e.n + "/" + e.alive).join(","),
                   snap.modules, sel.loose ? 1 : 0].join("|");
      if (sig !== editorSig) {
        editorSig = sig;
        if (sel.loose) {
          // 散兵池没有编制：不给方案/编制控件，只说明它是什么
          editorEl.innerHTML = `
            <div class="line sub">
              <span>未编队舰船 <b>${sel.alive}</b> 艘</span>
              <span>指挥值 <b>${sel.cost}</b></span>
            </div>
            <div class="line sub"><span>散兵池只是一个收纳队，没有编制。选中别的小队按「吸收散兵补满」从这里拿船。</span></div>
          `;
        } else {
          const ships = snap.shipList || [];
          const comp = (sel.entries || []).map(e => `
            <div class="line"><span>${e.name}</span><b>${e.alive}/${e.n}</b></div>`).join("");
          const formChips = (sel.formations || []).map(f => `
            <button class="fch${f === sel.form ? " on" : ""}" data-form="${f}"
                    title="${FORM_SHORT[f] || f}">${FORM_SHORT[f] || f}</button>`).join("");

          editorEl.innerHTML = `
            <div class="line sub">
              <span>模板 <b>${sel.templateName || "—（无编制小队）"}</b></span>
              <span>编制 <b>${sel.count}</b> 艘</span>
            </div>
            ${comp || `<div class="line sub">没有编制</div>`}
            <div class="line">
              <label>阵型</label>
              <div class="stepper">${formChips || "—"}</div>
            </div>
            <div class="line sub">
              <span>本队指挥值 <b>${sel.cost}</b></span>
              <span>承载 <b>${sel.capacityUsed}/${sel.capacity}</b></span>
            </div>
            <div class="line sub">
              <span>${sel.template ? "改下面的方案/编制 = 脱离模板，变成自定义编制（失去吸收散兵）" : "无编制小队：自己拿一份编制，不能吸收散兵"}</span>
            </div>
            <div class="line">
              <label>方案</label>
              <select data-act="ship">
                ${ships.map(s =>
                  `<option value="${s.id}" ${s.id === sel.ship ? "selected" : ""}>${s.name} · ${s.command}</option>`
                ).join("")}
              </select>
            </div>
            <div class="line">
              <label>编制</label>
              <div class="stepper">
                <button data-act="dec">−</button>
                <b>${sel.count}</b>
                <button data-act="inc">＋</button>
                <button data-act="inc5">＋5</button>
              </div>
            </div>
          `;

          const run = patch => bridge.run({ type: "setLoadout", squadId: sel.id, ...patch });

          editorEl.querySelector('[data-act="ship"]').addEventListener("change", e =>
            run({ ship: e.target.value }));
          editorEl.querySelector('[data-act="inc"]').addEventListener("click", () =>
            run({ count: sel.count + 1 }));
          editorEl.querySelector('[data-act="dec"]').addEventListener("click", () =>
            run({ count: Math.max(0, sel.count - 1) }));
          editorEl.querySelector('[data-act="inc5"]').addEventListener("click", () =>
            run({ count: sel.count + 5 }));
          editorEl.querySelectorAll("[data-form]").forEach(btn => {
            btn.addEventListener("click", () =>
              bridge.run({ type: "setFormation", squadId: sel.id, form: btn.dataset.form }));
          });
        }
      }
    }

    // ---- 编制模板（改动会追溯所有引用它的小队） ----
    const tpls = snap.templates || [];
    const sigT = tpls.map(t =>
      `${t.id}:${t.usedBy}:${t.entries.map(e => e.ship + e.n).join("+")}`).join("|");
    if (sigT !== tplSig) {
      tplSig = sigT;
      tplsEl.innerHTML = tpls.map(t => `
        <div class="line sub">
          <span><b>${t.name}</b></span>
          <span>${t.usedBy} 队在用</span>
        </div>
        ${t.entries.map(e => `
          <div class="line">
            <span>${e.name}</span>
            <div class="stepper">
              <button class="mini" data-tpl="${t.id}" data-ship="${e.ship}" data-d="-1">−</button>
              <b>${e.n}</b>
              <button class="mini" data-tpl="${t.id}" data-ship="${e.ship}" data-d="1">＋</button>
            </div>
          </div>`).join("")}
      `).join("");

      tplsEl.querySelectorAll("[data-tpl]").forEach(btn => {
        btn.addEventListener("click", () => {
          const t = tpls.find(x => x.id === btn.dataset.tpl);
          if (!t) return;
          const d = Number(btn.dataset.d);
          const entries = t.entries.map(e => ({
            ship: e.ship,
            n: e.ship === btn.dataset.ship ? Math.max(0, e.n + d) : e.n
          })).filter(e => e.n > 0);
          if (!entries.length) return actions.message("error", "编制不能为空");
          bridge.run({ type: "editSquadTemplate", templateId: t.id, entries });
        });
      });
    }

    // ---- 散兵池明细 ----
    const poolInfo = snap.pool || { size: 0, kinds: [] };
    const sigP0 = poolInfo.kinds.map(k => `${k.name}:${k.n}`).join(",") + "|" + poolInfo.size;
    if (sigP0 !== poolSig) {
      poolSig = sigP0;
      poolEl.innerHTML = `
        <div class="line sub">
          <span>蓝方未编队 <b>${poolInfo.size}</b> 艘</span>
          <span class="hint">生产线出锅 / 解散小队都进这里</span>
        </div>
        ${poolInfo.kinds.length
          ? poolInfo.kinds.map(k => `
            <div class="row pool"><span class="k">${k.name}</span><span class="v">${k.n}</span></div>`).join("")
          : `<div class="line sub">池子是空的</div>`}
      `;
    }

    // ---- 方案库列表 ----
    const ships = snap.shipList || [];
    const cur = ships.find(s => s.id === selectedShipId) || ships[0] || null;
    const sigS = ships.map(s => `${s.id}:${s.capacityUsed}/${s.capacity}:${s.ok ? 1 : 0}:${s.inService}`).join(",")
      + "|" + (cur?.id || "");
    if (sigS !== shipsSig) {
      shipsSig = sigS;
      shipsEl.innerHTML = ships.map(s => {
        const pct = s.capacity > 0 ? Math.min(100, s.capacityUsed / s.capacity * 100) : 0;
        return `
          <div class="row ship${s.id === (cur?.id) ? " sel" : ""}${s.ok ? "" : " dead"}" data-ship="${s.id}"
               title="${s.inService > 0 ? `在役 ${s.inService} 艘 · 已锁定` : "未建造 · 可改"}">
            <span class="k">${s.inService > 0 ? "锁 · " : ""}${s.name}</span>
            <span class="v">${s.capacityUsed}<em>/${s.capacity}</em></span>
            <span class="c">${s.command}</span>
            <span class="bar${s.capacityUsed > s.capacity ? " over" : ""}"><i style="width:${pct}%"></i></span>
          </div>`;
      }).join("");

      shipsEl.querySelectorAll(".row").forEach(row => {
        row.addEventListener("click", () => actions.selectShip(row.dataset.ship));
      });
    }

    // ---- 装配编辑区 ----
    const sigF = cur
      ? [cur.id, cur.capacityUsed, cur.capacity, cur.ok ? 1 : 0,
         JSON.stringify(cur.fit), (cur.reasons || []).join("|"), cur.inService].join("|")
      : "none";
    if (sigF !== fitSig) {
      fitSig = sigF;
      if (!cur) {
        fitEl.innerHTML = `<div class="line sub">没有可选方案</div>`;
      } else {
        const locked = cur.inService > 0;
        const rows = cur.slots.map(slot => {
          const stored = cur.fit[slot.id] || "";
          const options = slot.kind === "weapon"
            ? catalog.weapons.filter(w => (RANK[w.size] ?? 9) <= (RANK[slot.size] ?? 9))
            : catalog.plugins;
          const opts = [`<option value="">（空）</option>`]
            .concat(options.map(it =>
              `<option value="${it.id}" ${it.id === stored ? "selected" : ""}>${it.name} · ${it.capacity}</option>`))
            .join("");
          return `
            <div class="line">
              <label>${slot.id}${slot.size ? "·" + slot.size : ""}</label>
              <select data-slot="${slot.id}" ${locked ? "disabled" : ""}>${opts}</select>
            </div>`;
        }).join("");

        fitEl.innerHTML = `
          ${locked ? `<div class="line warnline">该方案有 ${cur.inService} 艘在役，已锁定：拆光之前不能改。用「复制」生成一份可改的副本。</div>` : ""}
          ${rows}
          <div class="line sub">
            <span>承载 <b>${cur.capacityUsed}/${cur.capacity}</b></span>
            <span>工时 <b>${cur.buildTime}s</b></span>
          </div>
          ${cur.ok ? "" : `<div class="line warnline">${(cur.reasons || []).join("；")}</div>`}
        `;

        fitEl.querySelectorAll("select").forEach(el => {
          el.addEventListener("change", () => {
            const slotId = el.dataset.slot;
            const itemId = el.value || null;
            const stored = cur.fit[slotId] || null;

            if (itemId) {
              // 先预览：不合法就红字 + 还原，绝不把非法装配写进库
              const pv = bridge.query({ type: "previewFit", shipId: cur.id, slotId, itemId });
              if (!pv.ok) {
                actions.message("error", (pv.reasons || ["装不上"]).join("；"));
                el.value = stored || "";
                return;
              }
            }
            bridge.run({ type: "setShipFit", shipId: cur.id, slotId, itemId });
          });
        });
      }
    }

    // ---- 生产线 ----
    const fac = (snap.production || []).find(p => p.faction === 0);
    if (fac) {
      const sigP = fac.lines.map(l =>
        `${l.alloc}:${l.job ? l.job.id + ":" + l.job.pct.toFixed(2) : "-"}`
      ).join("|") + "|" + fac.allocated;
      if (sigP !== prodSig) {
        prodSig = sigP;
        prodEl.innerHTML = `
          <div class="line sub">
            <span>已分配 <b>${fac.allocated}/${fac.efficiencyTotal}</b></span>
            <span>排队 <b>${fac.queued}</b></span>
          </div>
          ${fac.lines.map(l => `
            <div class="row prod" data-line="${l.index}">
              <span class="k">线${l.index + 1}</span>
              <span class="v">${l.alloc}</span>
              <button class="mini" data-act="effDown" data-line="${l.index}">−</button>
              <button class="mini" data-act="effUp" data-line="${l.index}">＋</button>
              ${l.job
                ? `<button class="mini" data-act="cancel" data-job="${l.job.id}">✕</button>`
                : ""}
            </div>
            <div class="bar${l.job ? "" : " idle"}">
              <i style="width:${l.job ? (l.job.pct * 100).toFixed(1) : 0}%"></i>
            </div>
            <div class="prodsub">${l.job
              ? `${l.job.name} · 剩 ${l.job.remaining == null ? "∞" : l.job.remaining + "s"}`
              : "空闲"}</div>
          `).join("")}
        `;

        prodEl.querySelectorAll('[data-act="effUp"]').forEach(btn => {
          btn.addEventListener("click", () => {
            const i = Number(btn.dataset.line);
            const l = fac.lines[i];
            bridge.run({
              type: "setLineEfficiency", faction: 0, line: i,
              value: Math.min(l.alloc + 1, fac.efficiencyTotal)
            });
          });
        });
        prodEl.querySelectorAll('[data-act="effDown"]').forEach(btn => {
          btn.addEventListener("click", () => {
            const i = Number(btn.dataset.line);
            const l = fac.lines[i];
            bridge.run({
              type: "setLineEfficiency", faction: 0, line: i,
              value: Math.max(0, l.alloc - 1)
            });
          });
        });
        prodEl.querySelectorAll('[data-act="cancel"]').forEach(btn => {
          btn.addEventListener("click", () =>
            bridge.run({ type: "cancelOrder", jobId: btn.dataset.job }));
        });
      }
    }

    // ---- 提示 ----
    if (msg) {
      msgEl.className = msg.kind;
      msgEl.textContent = (msg.kind === "error" ? "✕ " : "✓ ") + msg.text;
    } else {
      msgEl.className = "";
      msgEl.textContent = "";
    }
  }

  // 只订阅 store，不订阅 core
  store.subscribe(render);
  render();
}
