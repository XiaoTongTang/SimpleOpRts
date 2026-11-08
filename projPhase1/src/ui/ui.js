/**
 * UI 层（阶段一用原生 DOM 搭，之后整体换成 React）
 * -----------------------------------------------------------------
 * 三条纪律在这里落地：
 *   1. 只读 store，不读 core
 *   2. 任何编辑都走 bridge.run(cmd)，自己**不判断**合不合法
 *   3. 不注册 rAF —— 渲染由 main.js 的单一主循环负责
 *
 * 换 React 时，这个文件被替换成组件树，仓库其余部分不动。
 */

export function mountUI({ store, bridge, hulls, weapons }) {
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
  const msgEl = root.querySelector("#msg");
  const pauseBtn = root.querySelector('[data-act="pause"]');
  const resetBtn = root.querySelector('[data-act="reset"]');

  pauseBtn.addEventListener("click", () => {
    const s = store.getState();
    bridge.run({ type: "setPaused", value: !(s.snap && s.snap.paused) });
  });
  resetBtn.addEventListener("click", () => bridge.run({ type: "reset" }));

  // 编辑区只在「选中 / 编制变化」时重建，否则会打断下拉框的交互
  let editorSig = "";

  function render() {
    const { snap, selectedId, fps, msg } = store.getState();

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
      const dead = s.alive === 0 ? " dead" : "";
      return `
        <div class="row${sel}${dead}" data-id="${s.id}">
          <i style="background:hsl(${s.hue},72%,58%)"></i>
          <span class="k">${s.key}</span>
          <span class="v">${s.alive}<em>/${s.count}</em></span>
          <span class="c">${s.cost}</span>
        </div>`;
    }).join("");

    listEl.querySelectorAll(".row").forEach(row => {
      row.addEventListener("click", () => {
        store.setState({ selectedId: Number(row.dataset.id) });
      });
    });

    // ---- 编辑区 ----
    const sel = snap.squads.find(s => s.id === selectedId) || snap.squads[0];
    if (!sel) return;

    const sig = [sel.id, sel.hull, sel.count, sel.weapon, sel.alive, snap.modules].join("|");
    if (sig !== editorSig) {
      editorSig = sig;
      editorEl.innerHTML = `
        <div class="line">
          <label>船体</label>
          <select data-act="hull">
            ${Object.entries(hulls).map(([id, h]) =>
              `<option value="${id}" ${id === sel.hull ? "selected" : ""}>${h.name} · ${h.cost}</option>`
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
        <div class="line">
          <label>武器</label>
          <select data-act="weapon">
            ${weapons.map(w =>
              `<option value="${w}" ${w === sel.weapon ? "selected" : ""}>${w}</option>`
            ).join("")}
          </select>
        </div>
        <div class="line sub">
          <span>本队指挥值 <b>${sel.cost}</b></span>
          <span>存活 <b>${sel.alive}</b></span>
        </div>
      `;

      const run = patch => bridge.run({ type: "setLoadout", squadId: sel.id, ...patch });

      editorEl.querySelector('[data-act="hull"]').addEventListener("change", e =>
        run({ hull: e.target.value }));
      editorEl.querySelector('[data-act="weapon"]').addEventListener("change", e =>
        run({ weapon: e.target.value }));
      editorEl.querySelector('[data-act="inc"]').addEventListener("click", () =>
        run({ count: sel.count + 1 }));
      editorEl.querySelector('[data-act="dec"]').addEventListener("click", () =>
        run({ count: Math.max(0, sel.count - 1) }));
      editorEl.querySelector('[data-act="inc5"]').addEventListener("click", () =>
        run({ count: sel.count + 5 }));
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

  store.subscribe(render);
  render();
  return { render };
}
