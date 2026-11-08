/**
 * 舰船设计界面
 * -----------------------------------------------------------------
 * 对照 design/261107_2机制改进/UI原型-2-舰船设计.html 与《新的游戏界面设计.md》：
 *   左：所有舰船方案（名称 + 船图 + 承载/锁定）
 *   中：船体贴图 + 槽位引脚（空槽显示 w1-空，装了东西显示 w1-激光）
 *   右：本舰数值 → 当前船体（可换） → 武器区 → 插件区
 *       点任意槽位，右下方展开二级面板，枚举这个槽位能装的东西
 *
 * 数据全部来自 store 的 snapshot；写入全部走 bridge.run。
 */

import { spriteCell, applySprite, paint, fmtNum, fmtSigned } from "./util.js";

const RANK = { S: 0, M: 1, L: 2 };

export function mountShipDesign(root, { store, bridge, catalog, onBack }) {
  // 母舰不是"船体方案"，不给玩家拿来装配
  const hulls = (catalog.hulls || []).filter(h => h.class !== "mothership");
  const weapons = catalog.weapons || [];
  const plugins = catalog.plugins || [];

  let selId = null;          // 当前选中的方案
  let drawer = null;         // { kind:"weapon"|"plugin"|"hull", slotId? }
  let renaming = false;

  root.innerHTML = `
    <div class="screen">
      <div class="screen-head">
        <button class="btn" data-act="back">← 返回战场</button>
        <span class="screen-title">舰船设计</span>
        <span class="screen-hint">在役舰船会锁定它所属的方案：拆光之前不能改</span>
      </div>
      <div class="sd-body">
        <aside class="sd-left">
          <div class="panel-head">舰船方案 <span class="n" id="sd-count"></span></div>
          <div class="scroll" id="sd-list"></div>
          <div class="btns sd-btns">
            <button class="btn" data-act="new">新建</button>
            <button class="btn" data-act="dup">复制</button>
            <button class="btn" data-act="del">删除</button>
            <button class="btn" data-act="rename">改名</button>
          </div>
        </aside>

        <div class="sd-stage">
          <div class="hull-wrap">
            <i class="sprite lg" id="sd-sprite"></i>
            <div class="pins" id="sd-pins"></div>
          </div>
          <div class="sd-caption">
            <b id="sd-name">—</b>
            <span id="sd-hullname"></span>
          </div>
        </div>

        <aside class="sd-right">
          <div class="panel-head">本舰数值</div>
          <div class="sec" id="sd-stats"></div>
          <div class="sec">
            <button class="hullbtn" data-act="hull">
              <i class="sprite mini" id="sd-hullmini"></i>
              <span class="hn" id="sd-hullnm">当前船体</span>
              <span class="hx">›</span>
            </button>
          </div>
          <div class="panel-head">武器 <span class="n" id="sd-wpn-n"></span></div>
          <div class="scroll sd-slots" id="sd-slots-w"></div>
          <div class="panel-head">插件 <span class="n" id="sd-plg-n"></span></div>
          <div class="scroll sd-slots" id="sd-slots-p"></div>
          <div class="drawer" id="sd-drawer" hidden></div>
        </aside>
      </div>
    </div>
  `;

  const el = id => root.querySelector("#" + id);
  const $ = sel => root.querySelector(sel);

  // ----------------------------------------------------------------
  // 交互
  // ----------------------------------------------------------------

  $('[data-act="back"]').addEventListener("click", onBack);

  $('[data-act="new"]').addEventListener("click", () => {
    const cur = findShip();
    const hull = cur?.hull || hulls[0]?.id || "hull.falcon";
    const r = bridge.run({ type: "createShip", hull, name: "新方案" });
    if (r.ok && r.id) { selId = r.id; drawer = null; render(); }
  });

  $('[data-act="dup"]').addEventListener("click", () => {
    if (!selId) return;
    const r = bridge.run({ type: "duplicateShip", shipId: selId });
    if (r.ok && r.id) { selId = r.id; drawer = null; render(); }
  });

  $('[data-act="del"]').addEventListener("click", () => {
    const s = findShip();
    if (!s) return;
    if (!confirm(`删除方案「${s.name}」？`)) return;
    const r = bridge.run({ type: "deleteShip", shipId: s.id });
    if (r.ok) { selId = null; drawer = null; render(); }
  });

  $('[data-act="rename"]').addEventListener("click", () => {
    const s = findShip();
    if (!s || renaming) return;
    renaming = true;
    const name = prompt("方案名", s.name);
    renaming = false;
    if (name == null || !name.trim() || name.trim() === s.name) return;
    bridge.run({ type: "renameShip", shipId: s.id, name: name.trim() });
  });

  function findShip() {
    const snap = store.getState().snap;
    const list = snap?.shipList || [];
    return selId ? list.find(s => s.id === selId) : null;
  }

  function currentHull(s) {
    return hulls.find(h => h.id === s?.hull) || null;
  }

  function openSlot(kind, slotId) {
    drawer = { kind, slotId };
    render();
  }

  // ----------------------------------------------------------------
  // 绘制
  // ----------------------------------------------------------------

  function render() {
    const { snap } = store.getState();
    if (!snap) return;
    const list = snap.shipList || [];
    if (!selId || !list.some(s => s.id === selId)) {
      selId = (list.find(s => !s.inService) || list[0] || {}).id || null;
    }
    const cur = list.find(s => s.id === selId) || null;

    el("sd-count").textContent = list.length;
    paintList(list, cur);
    paintStage(cur);
    paintStats(cur);
    paintSlots(cur);
    paintDrawer(cur);
  }

  function paintList(list, cur) {
    const body = el("sd-list");
    paint(body, list.map(s =>
      `${s.id}:${s.name}:${s.capacityUsed}/${s.capacity}:${s.inService > 0 ? 1 : 0}:${s.ok ? 1 : 0}`
    ).join("|") + "|" + (cur?.id || ""), () => list.map(s => {
      const h = hulls.find(x => x.id === s.hull);
      const cell = spriteCell({ id: s.hull }, h);
      const pos = `background-position:calc(${-cell.col} * var(--u)) calc(${-cell.row} * var(--u))`;
      return `
        <div class="row ship${s.id === cur?.id ? " sel" : ""}${s.ok ? "" : " bad"}" data-ship="${s.id}"
             title="${s.inService > 0 ? `在役 ${s.inService} 艘 · 已锁定` : "未建造 · 可改"}">
          <i class="sprite mini" style="${pos}"></i>
          <span class="k">${s.name}</span>
          <span class="v">${s.capacityUsed}<em>/${s.capacity}</em></span>
          ${s.inService > 0 ? '<span class="lock">锁</span>' : ""}
        </div>`;
    }).join(""));

    body.querySelectorAll(".row").forEach(row => {
      row.addEventListener("click", () => {
        selId = row.dataset.ship;
        drawer = null;
        render();
      });
    });
  }

  function paintStage(cur) {
    const h = currentHull(cur);
    const cell = spriteCell({ id: cur?.hull }, h);
    const spr = el("sd-sprite");
    applySprite(spr, cell);
    spr.style.opacity = cur ? "1" : ".3";

    el("sd-name").textContent = cur ? cur.name : "—";
    el("sd-hullname").textContent = cur
      ? `${cur.hullName} · ${cur.ok ? "装配合法" : "装配不合法"}`
      : "";

    // 槽位引脚：武器用船体给的坐标，插件排在下沿
    const pins = cur ? cur.slots : [];
    const body = el("sd-pins");
    paint(body, pins.map(p => `${p.id}:${p.kind}:${cur.fit[p.id] || ""}`).join("|"), () => {
      const parts = [];
      const pPins = pins.filter(p => p.kind === "plugin");
      let pi = 0;
      for (const slot of pins) {
        const item = cur.fit[slot.id] || null;
        const nm = item ? (itemName(item) || item) : "空";
        let style;
        if (slot.kind === "weapon" && slot.pos) {
          // 船体局部坐标（±20）→ 相对贴图中心的像素偏移
          const dx = slot.pos[0] * 7;
          const dy = -slot.pos[1] * 7;
          style = `left:calc(50% + ${dx}px);top:calc(50% + ${dy}px)`;
        } else {
          // 插件槽没有坐标：在贴图下方排一行
          const k = pi++;
          const dx = (k - (pPins.length - 1) / 2) * 100;
          style = `left:calc(50% + ${dx}px);top:calc(50% + 96px)`;
        }
        parts.push(`
          <button class="pin${item ? "" : " empty"}${drawer && drawer.slotId === slot.id ? " on" : ""}"
                  data-pin="${slot.id}" data-kind="${slot.kind}" style="${style}">
            ${slot.id}-${nm}
          </button>`);
      }
      return parts.join("");
    });

    body.querySelectorAll("[data-pin]").forEach(btn => {
      btn.addEventListener("click", () => openSlot(btn.dataset.kind, btn.dataset.pin));
    });
  }

  function itemName(id) {
    return weapons.find(w => w.id === id)?.name || plugins.find(p => p.id === id)?.name || "";
  }

  function paintStats(cur) {
    const body = el("sd-stats");
    if (!cur) { body.innerHTML = `<div class="line sub">没有选中方案</div>`; return; }
    const a = cur.armor || {};
    paint(body, JSON.stringify([cur.armor, cur.capacityUsed, cur.capacity,
      cur.command, cur.buildTime, cur.dps, cur.ok, cur.reasons]), () => `
      <div class="kv"><span>血量</span><b>${fmtNum(a.hp)}</b></div>
      <div class="kv"><span>回血 / 秒</span><b>${fmtNum(a.hpRegen)}</b></div>
      <div class="kv"><span>护盾</span><b>${fmtNum(a.shield)}</b></div>
      <div class="kv"><span>护盾回复 / 秒</span><b>${fmtNum(a.shieldRegen)}</b></div>
      <div class="kv"><span>受击半径</span><b>${fmtNum(a.hullHitR)}</b></div>
      <div class="kv"><span>承载</span><b>${cur.capacityUsed} / ${cur.capacity}</b></div>
      <div class="kv"><span>指挥值</span><b>${cur.command}</b></div>
      <div class="kv"><span>工时</span><b>${fmtNum(cur.buildTime)}s</b></div>
      <div class="kv"><span>单舰 DPS</span><b>${fmtNum(cur.dps)}</b></div>
      ${cur.ok ? "" : `<div class="warnline">${(cur.reasons || []).join("；")}</div>`}
    `);

    const h = currentHull(cur);
    el("sd-hullnm").textContent = h ? `${h.name} · 承载 ${h.capacity}` : "当前船体";
    applySprite(el("sd-hullmini"), spriteCell({ id: cur.hull }, h));
  }

  function paintSlots(cur) {
    if (!cur) {
      el("sd-slots-w").innerHTML = "";
      el("sd-slots-p").innerHTML = "";
      return;
    }
    const wSlots = cur.slots.filter(s => s.kind === "weapon");
    const pSlots = cur.slots.filter(s => s.kind === "plugin");
    el("sd-wpn-n").textContent = wSlots.length;
    el("sd-plg-n").textContent = pSlots.length;

    const sig = cur.slots.map(s => `${s.id}:${cur.fit[s.id] || ""}`).join("|");
    paint(el("sd-slots-w"), sig + "|w", () => wSlots.map(s => slotRow(cur, s)).join(""));
    paint(el("sd-slots-p"), sig + "|p", () => pSlots.map(s => slotRow(cur, s)).join(""));

    bindSlotRows();
  }

  function slotRow(cur, slot) {
    const item = cur.fit[slot.id] || null;
    const def = item
      ? (slot.kind === "weapon" ? weapons.find(w => w.id === item) : plugins.find(p => p.id === item))
      : null;
    // 顺序：代号 · 尺寸 · 名称 · 承载
    return `
      <div class="slotrow${drawer && drawer.slotId === slot.id ? " on" : ""}"
           data-slot="${slot.id}" data-kind="${slot.kind}">
        <span class="code">${slot.id}</span>
        <span class="size">${slot.kind === "weapon" ? (slot.size || "?") : "—"}</span>
        <span class="wname${def ? "" : " empty"}">${def ? def.name : "空"}</span>
        <span class="cap">${def ? def.capacity : 0}</span>
      </div>`;
  }

  function bindSlotRows() {
    root.querySelectorAll(".slotrow").forEach(row => {
      row.addEventListener("click", () => openSlot(row.dataset.kind, row.dataset.slot));
    });
  }

  function paintDrawer(cur) {
    const box = el("sd-drawer");
    if (!cur || !drawer) { box.hidden = true; return; }
    box.hidden = false;
    const locked = cur.inService > 0;
    const lockLine = locked
      ? `<div class="warnline">该方案有 ${cur.inService} 艘在役，已锁定：拆光或换掉之前不能改</div>`
      : "";

    if (drawer.kind === "hull") {
      paint(box, "hull|" + cur.hull + "|" + locked, () => `
        <div class="drawer-head">
          <span>选择船体</span>
          <button class="mini-x" data-close>✕</button>
        </div>
        ${lockLine}
        <div class="drawer-list">
          ${hulls.map(h => `
            <div class="item${h.id === cur.hull ? " current" : ""}${locked ? " dis" : ""}"
                 data-item="${h.id}" data-kind="hull">
              <div class="pick-body">
                <div class="it-top"><b>${h.name}</b><span class="cap">承载 ${h.capacity}</span></div>
                <div class="it-sub">血量 ${fmtNum(h.armor.hp)} · 护盾 ${fmtNum(h.armor.shield)} ·
                  受击 ${fmtNum(h.armor.hullHitR)} · 槽位 ${h.slots.weapon.length}武/${h.slots.plugin.length}插</div>
              </div>
            </div>`).join("")}
        </div>
      `);
    } else {
      const slot = cur.slots.find(s => s.id === drawer.slotId);
      if (!slot) { box.hidden = true; return; }
      const items = drawer.kind === "weapon"
        ? weapons.filter(w => (RANK[w.size] ?? 9) <= (RANK[slot.size] ?? 9))
        : plugins;

      paint(box, `${drawer.kind}|${slot.id}|${cur.fit[slot.id] || ""}` + "|" + locked, () => `
        <div class="drawer-head">
          <span>${slot.id}${slot.size ? " · " + slot.size + " 级槽" : " · 插件槽"}</span>
          <button class="mini-x" data-close>✕</button>
        </div>
        ${lockLine}
        <div class="drawer-list">
          <div class="item${cur.fit[slot.id] ? "" : " current"}${locked ? " dis" : ""}"
               data-item="" data-kind="${drawer.kind}">
            <div class="pick-body">
              <div class="it-top"><b>（空）</b><span class="cap">卸下</span></div>
            </div>
          </div>
          ${items.map(it => {
            const isW = drawer.kind === "weapon";
            const sub = isW
              ? `伤害 ${it.dmg} · 冷却 ${it.cd}s · ${it.burst > 1 ? `连发 ${it.burst} · ` : ""}射程 ${it.range} · DPS ${it.dps}${it.pierce ? " · 穿盾" : ""}`
              : `${it.desc || ""}${Object.keys(it.mods || {}).length ? " · " + modsText(it.mods) : ""}${it.abilities.length ? " · " + it.abilities.map(a => a.name).join("/") : ""}`;
            return `
              <div class="item${cur.fit[slot.id] === it.id ? " current" : ""}${locked ? " dis" : ""}"
                   data-item="${it.id}" data-kind="${drawer.kind}">
                <div class="pick-body">
                  <div class="it-top"><b>${it.name}</b>
                    <span class="cap">${isW ? (it.size || "") + " · " : ""}承载 ${it.capacity}</span></div>
                  <div class="it-sub">${sub}</div>
                </div>
              </div>`;
          }).join("")}
        </div>
      `);
    }

    box.querySelector("[data-close]")?.addEventListener("click", () => {
      drawer = null;
      render();
    });
    box.querySelectorAll("[data-item]").forEach(node => {
      node.addEventListener("click", () => {
        if (node.classList.contains("dis")) return;
        const item = node.dataset.item;
        if (node.dataset.kind === "hull") {
          bridge.run({ type: "setShipHull", shipId: cur.id, hull: item });
        } else {
          bridge.run({
            type: "setShipFit",
            shipId: cur.id,
            slotId: drawer.slotId,
            itemId: item || null
          });
        }
      });
    });
  }

  function modsText(mods) {
    const name = {
      hp: "血量", hpRegen: "回血", shield: "护盾", shieldRegen: "护盾回复",
      hullHitR: "受击半径", shieldHitR: "盾受击", capacity: "承载", fireRate: "射速"
    };
    return Object.entries(mods)
      .map(([k, v]) => (k === "fireRate" ? `射速×${v}` : `${name[k] || k}${fmtSigned(v)}`))
      .join(" ");
  }

  el("sd-drawer").addEventListener("click", e => e.stopPropagation());
  $('[data-act="hull"]').addEventListener("click", () => openSlot("hull"));

  const unsub = store.subscribe(render);
  render();

  return {
    destroy() { unsub(); }
  };
}
