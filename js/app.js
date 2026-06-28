/* global OC */

(() => {
  const LANES = ["backlog", "mon", "tue", "wed", "thu", "fri", "done"];
  const MAX_TASKS = 30;

  const API_STATE_URL = OC.generateUrl("/apps/weeklydashboard/api/state");

  // Local UI prefs (optional; Nextcloud snapshot also stores UI state)
  const K_DONE_H = "weekly_dashboard_done_height_px_local";

  const state = {
    tasks: new Map(),
    order: Object.fromEntries(LANES.map((l) => [l, []])),
    draggingId: null,
    placeholder: null,
    editingId: null,
    draft: null,
    doneResizer: { splitter: null, lane: null, main: null, set: null },

    // ETag of the last state loaded from Nextcloud (for optimistic concurrency)
    remoteEtag: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const uid = () =>
    "t_" +
    Math.random().toString(36).slice(2, 9) +
    "_" +
    Date.now().toString(36);

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  const nowStamp = () => {
    const d = new Date();
    const wd = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(d);
    return `${wd} ${d.toISOString().slice(0, 10)}`;
  };

  const lsGet = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const lsSet = (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  };

  const isWaitingDesc = (desc) =>
    String(desc ?? "")
      .split(/\r?\n/)
      .some((l) => l.trim().toUpperCase() === "WAITING");

  const normalizeWaiting = (desc, waiting) => {
    const raw = String(desc ?? "");
    const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const cleaned = lines.filter((l) => l.trim().toUpperCase() !== "WAITING");
    if (waiting) cleaned.unshift("WAITING");
    while (cleaned.length && cleaned[0].trim() === "") cleaned.shift();
    while (cleaned.length && cleaned[cleaned.length - 1].trim() === "") cleaned.pop();
    return cleaned.join("\n");
  };

  function ensureInOrder(id, lane) {
    const arr = state.order[lane];
    if (!arr.includes(id)) arr.push(id);
  }
  function removeFromAllOrders(id) {
    for (const l of LANES) {
      const arr = state.order[l];
      const i = arr.indexOf(id);
      if (i >= 0) arr.splice(i, 1);
    }
  }
  function moveToBottom(id, lane) {
    const arr = state.order[lane];
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
    arr.push(id);
  }
  function tasksForLane(lane) {
    const inLane = [...state.tasks.values()].filter((t) => t.lane === lane);
    const byId = new Map(inLane.map((t) => [t.id, t]));
    const ordered = [];
    for (const id of state.order[lane]) {
      const t = byId.get(id);
      if (t) ordered.push(t);
    }
    for (const t of inLane) {
      if (!state.order[lane].includes(t.id)) ordered.push(t);
    }
    state.order[lane] = ordered.map((t) => t.id);
    return ordered;
  }

  // ---------- CSV (with meta comment lines) ----------
  function escapeCsvCell(v) {
    const s = String(v ?? "");
    if (/[\n\r,"]/g.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function parseCsv(text) {
    const s = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = s.split("\n");

    const meta = {};
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("#")) {
        const m = line.slice(1).trim();
        const eq = m.indexOf("=");
        if (eq > 0) meta[m.slice(0, eq).trim()] = m.slice(eq + 1).trim();
      } else if (line.trim() !== "") {
        dataLines.push(line);
      }
    }

    const src = dataLines.join("\n");
    const rows = [];
    let row = [];
    let cell = "";
    let inQuotes = false;

    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          const nx = src[i + 1];
          if (nx === '"') {
            cell += '"';
            i++;
            continue;
          }
          inQuotes = false;
          continue;
        }
        cell += ch;
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
        continue;
      }
      if (ch === ",") {
        row.push(cell);
        cell = "";
        continue;
      }
      if (ch === "\n") {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
        continue;
      }
      cell += ch;
    }
    if (cell.length || row.length) {
      row.push(cell);
      rows.push(row);
    }

    const header = (rows.shift() || []).map((h) => (h || "").trim());
    const out = [];
    for (const r of rows) {
      if (!r.length || r.every((c) => (c || "").trim() === "")) continue;
      const obj = {};
      for (let k = 0; k < header.length; k++) obj[header[k]] = r[k] ?? "";
      out.push(obj);
    }
    return { meta, header, rows: out };
  }

  function buildCsvSnapshot() {
    const root = $("#weeklydashboard-root");

    const metaLines = [];
    metaLines.push("# weeklydashboard v1");
    metaLines.push(`# ui.backlogCollapsed=${root.classList.contains("backlog-collapsed") ? 1 : 0}`);
    metaLines.push(`# ui.doneCollapsed=${root.classList.contains("done-collapsed") ? 1 : 0}`);

    const doneHeight = (() => {
      const doneLane = $(".wd-lane.done");
      const collapsed = root.classList.contains("done-collapsed");
      if (collapsed) return "";
      const h = doneLane ? Math.round(doneLane.getBoundingClientRect().height) : "";
      return String(h || "");
    })();
    metaLines.push(`# ui.doneHeightPx=${doneHeight}`);

    const header = ["id", "title", "description", "lane", "doneStamp", "orderIndex"].join(",");

    const rows = [];
    for (const lane of LANES) {
      const ids = state.order[lane];
      ids.forEach((id, idx) => {
        const t = state.tasks.get(id);
        if (!t) return;
        rows.push(
          [
            escapeCsvCell(t.id),
            escapeCsvCell(t.title),
            escapeCsvCell(t.description),
            escapeCsvCell(t.lane),
            escapeCsvCell(t.doneStamp || ""),
            escapeCsvCell(String(idx)),
          ].join(",")
        );
      });
    }

    return metaLines.join("\n") + "\n" + header + "\n" + rows.join("\n") + "\n";
  }

  function loadSnapshotFromCsv(csvText) {
    const parsed = parseCsv(csvText);

    state.tasks.clear();
    state.order = Object.fromEntries(LANES.map((l) => [l, []]));

    for (const r of parsed.rows) {
      const lane = String(r.lane || "").trim();
      if (!LANES.includes(lane)) continue;

      const t = {
        id: String(r.id || uid()).trim() || uid(),
        title: String(r.title || "").trim(),
        description: String(r.description || ""),
        lane,
        doneStamp: String(r.doneStamp || ""),
      };

      if (t.lane !== "done") t.doneStamp = "";

      const oi = Number(r.orderIndex);
      if (Number.isFinite(oi)) t._orderIndex = oi;

      state.tasks.set(t.id, t);
    }

    for (const lane of LANES) {
      const list = [...state.tasks.values()].filter((t) => t.lane === lane);
      list.sort((a, b) => (a._orderIndex ?? 999999) - (b._orderIndex ?? 999999));
      state.order[lane] = list.map((t) => t.id);
      list.forEach((t) => delete t._orderIndex);
    }

    // Apply UI meta from CSV
    const root = $("#weeklydashboard-root");
    root.classList.toggle("backlog-collapsed", parsed.meta["ui.backlogCollapsed"] === "1");
    root.classList.toggle("done-collapsed", parsed.meta["ui.doneCollapsed"] === "1");

    const doneHeightPx = Number(parsed.meta["ui.doneHeightPx"]);
    if (
      parsed.meta["ui.doneCollapsed"] !== "1" &&
      Number.isFinite(doneHeightPx) &&
      doneHeightPx > 0
    ) {
      lsSet(K_DONE_H, String(Math.round(doneHeightPx)));
    }

    render();
    applyCollapseUI();
  }

  // ---------- Nextcloud sync (ETag aware) ----------
  async function loadFromNextcloud() {
    const r = await fetch(API_STATE_URL, { credentials: "same-origin" });
    if (!r.ok) throw new Error(`Load failed (${r.status})`);

    const etag = r.headers.get("ETag");
    state.remoteEtag = etag ? etag.replace(/^"|"$/g, "") : null;

    const csv = await r.text();
    loadSnapshotFromCsv(csv);
  }

  async function saveToNextcloud() {
    const csv = buildCsvSnapshot();

    const headers = {
      requesttoken: OC.requestToken,
      "Content-Type": "text/csv; charset=utf-8",
    };

    // If the server file already exists, backend requires If-Match
    if (state.remoteEtag) {
      headers["If-Match"] = state.remoteEtag;
    }

    const r = await fetch(API_STATE_URL, {
      method: "PUT",
      credentials: "same-origin",
      headers,
      body: csv,
    });

    if (r.status === 428) {
      // Precondition Required: missing If-Match
      const data = await r.json().catch(() => null);
      const current = data && data.currentEtag ? data.currentEtag : "unknown";
      throw new Error(
        `Save blocked to prevent overwriting newer changes. Please click “Load from Nextcloud” first.\n(Current ETag: ${current})`
      );
    }

    if (r.status === 409) {
      // Conflict: ETag mismatch
      const data = await r.json().catch(() => null);
      const current = data && data.currentEtag ? data.currentEtag : "unknown";
      throw new Error(
        `Conflict: the dashboard changed in Nextcloud since you loaded it.\nClick “Load from Nextcloud” to refresh, then save again.\n(Current ETag: ${current})`
      );
    }

    if (!r.ok) {
      const msg = await r.text().catch(() => "");
      throw new Error(`Save failed (${r.status}) ${msg}`);
    }

    // Update local ETag to new one returned by server
    const newEtag = r.headers.get("ETag");
    if (newEtag) state.remoteEtag = newEtag.replace(/^"|"$/g, "");
  }

  // ---------- Local export/import ----------
  function downloadLocalCsv(filename, text) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  // ---------- UI build ----------
  function mount() {
    const root = $("#weeklydashboard-root");
    root.className = "wd-root";
    root.innerHTML = `
      <div class="wd-wrap">
        <div class="wd-topbar">
          <div class="wd-brand">
            <div class="wd-logo" aria-hidden="true"></div>
            <div class="wd-titleblock">
              <h1>Weekly Task Dashboard</h1>
              <p>Nextcloud-backed single file snapshot with overwrite protection (ETag).</p>
            </div>
          </div>
          <div class="wd-controls">
            <div class="wd-week" title="Optional label used for filenames only.">
              <label for="wdWeek">Week</label>
              <input id="wdWeek" placeholder="e.g., 2026-W26" />
            </div>
            <button class="wd-btn accent" id="wdNew">+ New Task</button>

            <button class="wd-btn good" id="wdSaveNC">Save to Nextcloud</button>
            <button class="wd-btn warn" id="wdLoadNC">Load from Nextcloud</button>

            <button class="wd-btn good" id="wdExport">Export CSV</button>
            <button class="wd-btn warn" id="wdImportBtn">Import CSV</button>

            <button class="wd-btn warn" id="wdArchiveDone">Archive Done</button>
            <input id="wdCsvFile" type="file" accept=".csv,text/csv" />
          </div>
        </div>

        <div class="wd-hint">
          Save-to-Nextcloud requires you to load first (to get the current ETag). If you get a conflict, load again and re-save.
        </div>
      </div>

      <div class="wd-main">
        <div class="wd-wrap">
          <section class="wd-board">
            <div class="wd-lane backlog" data-lane="backlog">
              <div class="wd-laneHead">
                <div class="wd-laneTitle"><span class="wd-dot backlog"></span><h2>Weekly Backlog</h2></div>
                <div class="wd-actions">
                  <div class="wd-count" data-count="backlog">0</div>
                  <button id="wdCollapseBacklog" class="wd-iconBtn" data-dir="left" title="Collapse Backlog" aria-label="Collapse Backlog"><span>›</span></button>
                </div>
              </div>
              <div class="wd-quickAdd">
                <input id="wdQuickTitle" placeholder="Quick add: type a title and press Enter" maxlength="120" />
                <button id="wdQuickAddBtn" class="wd-btn accent">Add</button>
              </div>
              <div class="wd-dropzone" data-dropzone="backlog"></div>
            </div>

            <div class="wd-maincol">
              <div class="wd-days" aria-label="Weekdays">
                ${["mon","tue","wed","thu","fri"].map((d) => `
                  <div class="wd-lane" data-lane="${d}">
                    <div class="wd-laneHead">
                      <div class="wd-laneTitle"><span class="wd-dot"></span><h2>${({mon:"Monday",tue:"Tuesday",wed:"Wednesday",thu:"Thursday",fri:"Friday"})[d]}</h2></div>
                      <div class="wd-count" data-count="${d}">0</div>
                    </div>
                    <div class="wd-dropzone" data-dropzone="${d}"></div>
                  </div>
                `).join("")}
              </div>

              <div class="wd-lane done" data-lane="done">
                <div class="wd-laneHead">
                  <div class="wd-laneTitle"><span class="wd-dot done"></span><h2>Done Tasks</h2></div>
                  <div class="wd-actions">
                    <div class="wd-count" data-count="done">0</div>
                    <button id="wdCollapseDone" class="wd-iconBtn" data-dir="down" title="Collapse Done" aria-label="Collapse Done"><span>›</span></button>
                  </div>
                </div>
                <div class="wd-dropzone" data-dropzone="done"></div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <div class="wd-overlay" id="wdOverlay" role="dialog" aria-modal="true" aria-labelledby="wdModalTitle">
        <div class="wd-modal">
          <div class="wd-modalHead">
            <div><h3 id="wdModalTitle">Task</h3></div>
            <div class="wd-modalHeadRight">
              <button id="wdWaitingBtn" class="wd-btn warn" style="display:none;">Waiting</button>
              <button id="wdModalClose" class="wd-modalClose" title="Close" aria-label="Close">×</button>
            </div>
          </div>
          <div class="wd-modalBody">
            <div class="wd-field"><label for="wdTaskTitle">Title</label><input id="wdTaskTitle" maxlength="120" /></div>
            <div class="wd-field"><label for="wdTaskDesc">Description (tooltip)</label><textarea id="wdTaskDesc" maxlength="4000"></textarea></div>
            <div class="small">Close the dialog to save automatically. New task is created when it has a title.</div>
          </div>
          <div class="wd-modalFoot"><button id="wdDeleteBtn" class="wd-btn danger" style="display:none;">Delete</button></div>
        </div>
      </div>

      <div class="wd-tip" id="wdTip"></div>
    `;

    wireUiHandlers();
    wireDnD();
    initDoneResizer();
    applyCollapseUI();
  }

  // ---------- Collapse UI ----------
  function applyCollapseUI() {
    const root = $("#weeklydashboard-root");
    const bc = root.classList.contains("backlog-collapsed");
    const dc = root.classList.contains("done-collapsed");

    const btnCB = $("#wdCollapseBacklog");
    const btnCD = $("#wdCollapseDone");

    btnCB.dataset.dir = bc ? "right" : "left";
    btnCB.title = bc ? "Expand Backlog" : "Collapse Backlog";
    btnCB.setAttribute("aria-label", btnCB.title);

    btnCD.dataset.dir = dc ? "up" : "down";
    btnCD.title = dc ? "Expand Done" : "Collapse Done";
    btnCD.setAttribute("aria-label", btnCD.title);

    if (state.doneResizer.lane && state.doneResizer.set) {
      if (dc) state.doneResizer.lane.style.height = "auto";
      else {
        const saved = lsGet(K_DONE_H);
        const n = saved ? Number(saved) : NaN;
        if (Number.isFinite(n) && n > 0) state.doneResizer.set(n);
      }
    }
  }

  // ---------- Done resizer ----------
  function initDoneResizer() {
    const mainCol = $(".wd-maincol");
    const days = $(".wd-days");
    const doneLane = $(".wd-lane.done");
    if (!mainCol || !days || !doneLane) return;

    const splitter = document.createElement("div");
    splitter.className = "wd-splitter";
    splitter.title = "Drag to resize Done area";
    mainCol.insertBefore(splitter, doneLane);

    days.style.flex = "1 1 auto";
    doneLane.style.flex = "0 0 auto";

    const MIN = 140;
    const MAXR = 0.6;

    const clampDone = (px) => {
      const avail = mainCol.clientHeight;
      const max = Math.max(MIN, Math.floor(avail * MAXR));
      return Math.max(MIN, Math.min(px, max));
    };

    const setDone = (px) => {
      const h = clampDone(px);
      doneLane.style.height = h + "px";
      lsSet(K_DONE_H, String(Math.round(h)));
    };

    state.doneResizer = { splitter, lane: doneLane, main: mainCol, set: setDone };

    const saved = lsGet(K_DONE_H);
    const n = saved ? Number(saved) : NaN;
    setDone(Number.isFinite(n) && n > 0 ? n : Math.floor(mainCol.clientHeight * 0.33));

    let dragging = false,
      startY = 0,
      startH = 0;

    splitter.addEventListener("pointerdown", (e) => {
      if ($("#weeklydashboard-root").classList.contains("done-collapsed")) return;
      dragging = true;
      startY = e.clientY;
      startH = doneLane.getBoundingClientRect().height;
      splitter.setPointerCapture(e.pointerId);
      document.body.style.cursor = "row-resize";
    });
    splitter.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      setDone(startH - (e.clientY - startY));
    });
    const end = () => {
      dragging = false;
      document.body.style.cursor = "";
    };
    splitter.addEventListener("pointerup", end);
    splitter.addEventListener("pointercancel", end);

    window.addEventListener("resize", () => {
      if ($("#weeklydashboard-root").classList.contains("done-collapsed")) return;
      setDone(doneLane.getBoundingClientRect().height);
    });
  }

  // ---------- Render ----------
  function render() {
    for (const lane of LANES) {
      const zone = $(`[data-dropzone="${lane}"]`);
      zone.innerHTML = "";
      const list = tasksForLane(lane);

      if (!list.length) {
        const e = document.createElement("div");
        e.className = "wd-empty";
        e.textContent =
          lane === "backlog"
            ? "Drop tasks here (or create a new one)."
            : lane === "done"
              ? "Drop finished tasks here."
              : "Drop tasks here.";
        zone.appendChild(e);
      } else {
        list.forEach((t) => zone.appendChild(taskEl(t)));
      }

      const c = $(`[data-count="${lane}"]`);
      if (c) c.textContent = String(list.length);
    }
  }

  function taskEl(t) {
    const waiting = isWaitingDesc(t.description);
    const el = document.createElement("div");
    el.className = "wd-task" + (waiting ? " waiting" : "");
    el.draggable = true;
    el.dataset.taskId = t.id;

    const title = document.createElement("p");
    title.className = "wd-taskTitle";
    title.textContent = t.title || "(Untitled)";
    el.appendChild(title);

    if (t.lane === "done" && t.doneStamp) {
      const b = document.createElement("div");
      b.className = "wd-badge done";
      b.textContent = `Done: ${t.doneStamp}`;
      el.appendChild(b);
    }

    el.addEventListener("mousemove", (e) => showTip(e, t.description));
    el.addEventListener("mouseenter", (e) => showTip(e, t.description));
    el.addEventListener("mouseleave", hideTip);
    el.addEventListener("dblclick", () => openModal("edit", t.id));

    el.addEventListener("dragstart", (e) => {
      state.draggingId = t.id;
      el.classList.add("wd-ghost");
      e.dataTransfer.setData("text/plain", t.id);
      e.dataTransfer.effectAllowed = "move";
      state.placeholder = document.createElement("div");
      state.placeholder.className = "wd-placeholder";
    });

    el.addEventListener("dragend", () => {
      state.draggingId = null;
      el.classList.remove("wd-ghost");
      cleanupPlaceholder();
      $$(".wd-dropzone.dragover").forEach((z) => z.classList.remove("dragover"));
    });

    return el;
  }

  // ---------- Tooltip ----------
  const tip = () => $("#wdTip");
  let tipOn = false;

  function showTip(e, text) {
    const c = (text || "").trim();
    const t = tip();
    if (!c) {
      hideTip();
      return;
    }
    t.textContent = c;
    t.style.display = "block";
    tipOn = true;
    const pad = 14;
    const r = t.getBoundingClientRect();
    t.style.left = clamp(e.clientX + 14, pad, window.innerWidth - r.width - pad) + "px";
    t.style.top = clamp(e.clientY + 14, pad, window.innerHeight - r.height - pad) + "px";
  }
  function hideTip() {
    if (!tipOn) return;
    tipOn = false;
    const t = tip();
    t.style.display = "none";
    t.textContent = "";
  }

  // ---------- DnD reorder ----------
  function cleanupPlaceholder() {
    if (state.placeholder && state.placeholder.parentNode)
      state.placeholder.parentNode.removeChild(state.placeholder);
  }
  function computeInsertBefore(zone, y) {
    const items = [...zone.querySelectorAll(".wd-task:not(.wd-ghost)")];
    for (const el of items) {
      const b = el.getBoundingClientRect();
      if (y < b.top + b.height / 2) return el;
    }
    return null;
  }
  function ensurePlaceholder(zone, beforeEl) {
    if (!state.placeholder) return;
    const empty = zone.querySelector(".wd-empty");
    if (empty) empty.remove();
    if (beforeEl) {
      if (beforeEl.previousSibling !== state.placeholder) zone.insertBefore(state.placeholder, beforeEl);
    } else zone.appendChild(state.placeholder);
  }
  function wireDnD() {
    for (const lane of LANES) {
      const zone = $(`[data-dropzone="${lane}"]`);

      zone.addEventListener("dragover", (e) => {
        e.preventDefault();
        zone.classList.add("dragover");
        ensurePlaceholder(zone, computeInsertBefore(zone, e.clientY));
        e.dataTransfer.dropEffect = "move";
      });

      zone.addEventListener("dragleave", (e) => {
        if (!zone.contains(e.relatedTarget)) zone.classList.remove("dragover");
      });

      zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("dragover");
        const id = state.draggingId || e.dataTransfer.getData("text/plain");
        if (id) finalizeDrop(id, lane);
      });
    }
  }

  function finalizeDrop(id, targetLane) {
    const t = state.tasks.get(id);
    if (!t) return;
    const fromLane = t.lane;

    let insertIndex = null;
    if (state.placeholder && state.placeholder.parentNode === $(`[data-dropzone="${targetLane}"]`)) {
      const kids = [...$(`[data-dropzone="${targetLane}"]`).children].filter(
        (el) => el.classList.contains("wd-task") || el.classList.contains("wd-placeholder")
      );
      insertIndex = kids.indexOf(state.placeholder);
      if (insertIndex < 0) insertIndex = null;
    }

    t.lane = targetLane;
    if (targetLane === "done") {
      t.doneStamp = nowStamp();
      t.description = normalizeWaiting(t.description, false);
    } else if (fromLane === "done") {
      t.doneStamp = "";
    }
    state.tasks.set(id, t);

    removeFromAllOrders(id);
    const arr = state.order[targetLane];
    if (insertIndex === null || insertIndex > arr.length) arr.push(id);
    else arr.splice(insertIndex, 0, id);

    cleanupPlaceholder();
    render();
  }

  // ---------- Modal ----------
  const overlay = () => $("#wdOverlay");
  const modalTitle = () => $("#wdModalTitle");
  const inTitle = () => $("#wdTaskTitle");
  const inDesc = () => $("#wdTaskDesc");
  const btnClose = () => $("#wdModalClose");
  const btnDelete = () => $("#wdDeleteBtn");
  const btnWaiting = () => $("#wdWaitingBtn");

  function openModal(mode, id) {
    overlay().classList.add("open");

    if (mode === "edit") {
      state.editingId = id;
      const t = state.tasks.get(id);
      state.draft = { ...t };
      modalTitle().textContent = "Edit Task";
      inTitle().value = t?.title ?? "";
      inDesc().value = t?.description ?? "";
      btnDelete().style.display = "inline-block";
    } else {
      state.editingId = null;
      state.draft = { title: "", description: "", lane: "backlog" };
      modalTitle().textContent = "New Task";
      inTitle().value = "";
      inDesc().value = "";
      btnDelete().style.display = "none";
    }

    btnWaiting().style.display = "inline-block";
    syncWaitingBtn();
    setTimeout(() => inTitle().focus(), 30);
  }

  function syncDraftFromInputs() {
    if (!state.draft) return;
    state.draft.title = (inTitle().value || "").trim();
    state.draft.description = (inDesc().value || "").trim();
  }

  function syncWaitingBtn() {
    if (!state.draft) return;
    btnWaiting().textContent = isWaitingDesc(state.draft.description) ? "Waiting ✓" : "Waiting";
  }

  function toggleWaitingInDraft() {
    if (!state.draft) return;
    const cur = isWaitingDesc(state.draft.description);
    state.draft.description = normalizeWaiting(state.draft.description, !cur);
    inDesc().value = state.draft.description;
    syncWaitingBtn();
  }

  function closeModal(commit = true) {
    if (commit) commitDraft();
    overlay().classList.remove("open");
    state.editingId = null;
    state.draft = null;
  }

  function commitDraft() {
    if (!state.draft) return;
    syncDraftFromInputs();

    const waiting = isWaitingDesc(state.draft.description);
    state.draft.description = normalizeWaiting(state.draft.description, waiting);

    if (state.editingId) {
      const ex = state.tasks.get(state.editingId);
      if (!ex) return;

      const wasWaiting = isWaitingDesc(ex.description);

      ex.title = state.draft.title;
      ex.description = state.draft.description;
      state.tasks.set(ex.id, ex);

      if (!wasWaiting && waiting) moveToBottom(ex.id, ex.lane);
    } else {
      if (!state.draft.title) return;
      if (state.tasks.size >= MAX_TASKS) {
        alert(`Weekly limit reached (${MAX_TASKS} tasks).`);
        return;
      }
      const t = {
        id: uid(),
        title: state.draft.title,
        description: state.draft.description,
        lane: "backlog",
        doneStamp: "",
      };
      state.tasks.set(t.id, t);
      ensureInOrder(t.id, "backlog");
      if (waiting) moveToBottom(t.id, "backlog");
    }

    render();
  }

  function deleteEditing() {
    if (!state.editingId) return;
    const t = state.tasks.get(state.editingId);
    if (!t) return;
    if (!confirm(`Delete task "${t.title}"?`)) return;
    state.tasks.delete(state.editingId);
    removeFromAllOrders(state.editingId);
    closeModal(false);
    render();
  }

  // ---------- UI handlers ----------
  function wireUiHandlers() {
    $("#wdCollapseBacklog").addEventListener("click", () => {
      const root = $("#weeklydashboard-root");
      root.classList.toggle("backlog-collapsed");
      applyCollapseUI();
    });
    $("#wdCollapseDone").addEventListener("click", () => {
      const root = $("#weeklydashboard-root");
      root.classList.toggle("done-collapsed");
      applyCollapseUI();
    });

    overlay().addEventListener("click", (e) => {
      if (e.target === overlay()) closeModal(true);
    });
    btnClose().addEventListener("click", () => closeModal(true));
    btnDelete().addEventListener("click", deleteEditing);
    btnWaiting().addEventListener("click", toggleWaitingInDraft);
    inTitle().addEventListener("input", () => syncDraftFromInputs());
    inDesc().addEventListener("input", () => {
      syncDraftFromInputs();
      syncWaitingBtn();
    });
    document.addEventListener("keydown", (e) => {
      if (!overlay().classList.contains("open")) return;
      if (e.key === "Escape") closeModal(true);
    });

    $("#wdNew").addEventListener("click", () => openModal("new"));

    const quick = $("#wdQuickTitle");
    const doQuick = () => {
      const title = (quick.value || "").trim();
      if (!title) return;
      if (state.tasks.size >= MAX_TASKS) {
        alert(`Weekly limit reached (${MAX_TASKS} tasks).`);
        return;
      }
      const t = { id: uid(), title, description: "", lane: "backlog", doneStamp: "" };
      state.tasks.set(t.id, t);
      ensureInOrder(t.id, "backlog");
      quick.value = "";
      render();
    };
    $("#wdQuickAddBtn").addEventListener("click", doQuick);
    quick.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doQuick();
      }
    });

    $("#wdLoadNC").addEventListener("click", async () => {
      try {
        await loadFromNextcloud();
      } catch (err) {
        alert(String(err?.message || err));
      }
    });
    $("#wdSaveNC").addEventListener("click", async () => {
      try {
        await saveToNextcloud();
        alert("Saved to Nextcloud Files (/WeeklyDashboard/dashboard.csv).");
      } catch (err) {
        alert(String(err?.message || err));
      }
    });

    $("#wdExport").addEventListener("click", () => {
      const label = ($("#wdWeek").value || "weekly_tasks").trim().replace(/[^a-z0-9\-_]+/gi, "_");
      downloadLocalCsv(`${label || "weekly_tasks"}.csv`, buildCsvSnapshot());
    });

    const fileInput = $("#wdCsvFile");
    $("#wdImportBtn").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      const text = await file.text();
      loadSnapshotFromCsv(text);
    });

    $("#wdArchiveDone").addEventListener("click", () => {
      const done = [...state.tasks.values()].filter((t) => t.lane === "done");
      if (!done.length) {
        alert("No done tasks to archive.");
        return;
      }
      if (
        !confirm(
          `Archive ${done.length} done task(s)?\n\nThis will download a CSV of done tasks and then remove them from the Done lane.`
        )
      )
        return;

      const label = ($("#wdWeek").value || "weekly_tasks").trim().replace(/[^a-z0-9\-_]+/gi, "_");

      // build done-only csv, preserving UI meta
      const meta = buildCsvSnapshot().split("\n").filter((l) => l.startsWith("#"));
      const header = "id,title,description,lane,doneStamp,orderIndex";
      const rows = [];
      const ids = state.order.done.slice();
      ids.forEach((id, idx) => {
        const t = state.tasks.get(id);
        if (!t || t.lane !== "done") return;
        rows.push(
          [
            escapeCsvCell(t.id),
            escapeCsvCell(t.title),
            escapeCsvCell(t.description),
            "done",
            escapeCsvCell(t.doneStamp || ""),
            String(idx),
          ].join(",")
        );
      });

      downloadLocalCsv(`${label || "weekly_tasks"}_done_archive.csv`, meta.join("\n") + "\n" + header + "\n" + rows.join("\n") + "\n");

      for (const t of done) {
        state.tasks.delete(t.id);
        removeFromAllOrders(t.id);
      }
      render();
    });
  }

  // ---------- Bootstrap ----------
  function seed() {
    const add = (title, description, lane) => {
      if (state.tasks.size >= MAX_TASKS) return;
      const t = { id: uid(), title, description, lane, doneStamp: "" };
      state.tasks.set(t.id, t);
      ensureInOrder(t.id, lane);
    };
    add("Plan the week", "Drag tasks onto days.\nUse the Waiting button in Edit to mark blocked tasks.", "backlog");
    add("Write status update", "Draft and send weekly update to stakeholders.", "backlog");
    add("Deep work block", "Reserve 2 hours for the most important task.", "backlog");
  }

  async function start() {
    mount();
    seed();
    render();

    // Auto-load on startup to get current state + ETag
    try {
      await loadFromNextcloud();
    } catch {
      // ignore; user can click Load from Nextcloud
    }
  }

  document.addEventListener("DOMContentLoaded", start);
})();