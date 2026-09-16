/* Donebook — board + record.
   One in-memory task list drives every view; the server is the record. */

(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ---------------------------------------------------------------- dates

  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromISO = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const addDays = (d, n) => {
    const c = new Date(d);
    c.setDate(c.getDate() + n);
    return c;
  };
  /* Weeks run Monday to Sunday — a working week, not a US calendar week. */
  const startOfWeek = (d) => addDays(d, -((d.getDay() + 6) % 7));
  const today = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  };
  const localStamp = () => {
    const d = new Date();
    return `${iso(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const DOW = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const DOW_LONG = new Intl.DateTimeFormat(undefined, { weekday: "long" });
  const MONTH_YEAR = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
  const DAY_LABEL = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
  const RANGE_DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

  // ---------------------------------------------------------------- state

  const state = {
    view: "board",
    span: window.innerWidth < 900 ? "week" : "month",
    anchor: today(),
    tasks: [],
    sheetId: null,
    recordGroup: "strand",
    report: null,
    offline: false,
  };

  const byId = (id) => state.tasks.find((t) => t.id === id);

  // ------------------------------------------------------------------ api

  function setOffline(offline) {
    state.offline = offline;
    $("#offline-bar").hidden = !offline;
  }

  class OfflineError extends Error {
    constructor() {
      super("You’re offline — that change didn’t reach the server.");
    }
  }

  async function api(path, options = {}) {
    let res;
    try {
      res = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...options,
      });
    } catch {
      setOffline(true);
      throw new OfflineError();
    }
    if (res.status === 401) {
      showGate();
      throw new Error("unauthorized");
    }
    // The service worker stamps anything it served from its own cache.
    setOffline(res.headers.get("X-Donebook-Cache") === "hit");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  const post = (p, body) => api(p, { method: "POST", body: JSON.stringify(body) });
  const patch = (p, body) => api(p, { method: "PATCH", body: JSON.stringify(body) });

  let toastTimer;
  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2600);
  }

  // --------------------------------------------------------------- window

  function visibleRange() {
    if (state.span === "week") {
      const start = startOfWeek(state.anchor);
      return { start, end: addDays(start, 6), cells: 7 };
    }
    const first = new Date(state.anchor.getFullYear(), state.anchor.getMonth(), 1);
    const last = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + 1, 0);
    const start = startOfWeek(first);
    const weeks = Math.ceil((Math.round((last - start) / 86400000) + 1) / 7);
    return { start, end: addDays(start, weeks * 7 - 1), cells: weeks * 7 };
  }

  async function loadTasks() {
    const { start, end } = visibleRange();
    const data = await api(`/api/tasks?start=${iso(start)}&end=${iso(end)}`);
    state.tasks = data.tasks;
    renderBoard();
  }

  // -------------------------------------------------------------- board

  function cardEl(task) {
    const el = document.createElement("article");
    el.className = "card";
    el.dataset.id = task.id;
    if (task.done) el.classList.add("is-done");
    const late = !task.done && task.day && task.day < iso(today());
    if (late) el.classList.add("is-late");

    const tick = document.createElement("button");
    tick.className = "tick";
    tick.type = "button";
    tick.setAttribute("aria-label", task.done ? "Mark as not done" : "Mark as done");
    tick.innerHTML =
      '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 13 10 18 19 6"/></svg>';
    tick.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDone(task.id);
    });

    const body = document.createElement("div");
    body.className = "card-body";

    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = task.title;
    body.append(title);

    const bits = [];
    if (task.strand) bits.push(`<span class="card-strand">${escapeHtml(task.strand)}</span>`);
    if (late) bits.push(`<span class="card-late-stamp">${RANGE_DAY.format(fromISO(task.day))}</span>`);
    if (task.notes.trim()) bits.push('<span class="card-note-flag">&#9776;</span>');
    if (bits.length) {
      const meta = document.createElement("div");
      meta.className = "card-meta";
      meta.innerHTML = bits.join("");
      body.append(meta);
    }

    el.append(tick, body);
    el.addEventListener("click", () => {
      if (!dragMoved) openSheet(task.id);
    });
    return el;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function renderBoard() {
    const { start, cells } = visibleRange();
    const todayISO = iso(today());
    const anchorMonth = state.anchor.getMonth();

    // Period label + weekday header.
    $("#period-label").textContent =
      state.span === "month"
        ? MONTH_YEAR.format(state.anchor)
        : `${RANGE_DAY.format(start)} – ${RANGE_DAY.format(addDays(start, 6))}`;

    const weekdayRow = $("#weekday-row");
    weekdayRow.innerHTML = "";
    for (let i = 0; i < 7; i++) {
      const span = document.createElement("span");
      span.textContent = DOW.format(addDays(start, i));
      weekdayRow.append(span);
    }

    // Buckets.
    const scheduled = new Map();
    const backlog = [];
    const overdue = [];
    for (const task of state.tasks) {
      if (task.day === null) {
        backlog.push(task);
      } else if (!task.done && task.day < todayISO) {
        overdue.push(task);
      } else {
        if (!scheduled.has(task.day)) scheduled.set(task.day, []);
        scheduled.get(task.day).push(task);
      }
    }
    const sortPos = (a, b) => a.pos - b.pos || a.id - b.id;
    scheduled.forEach((list) => list.sort(sortPos));
    backlog.sort(sortPos);
    overdue.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : sortPos(a, b)));

    // Rail — running late.
    const overdueBlock = $("#overdue-block");
    overdueBlock.hidden = overdue.length === 0;
    $("#overdue-count").textContent = overdue.length;
    const overdueList = $("#overdue-list");
    overdueList.innerHTML = "";
    overdue.forEach((t) => overdueList.append(cardEl(t)));

    // Rail — unscheduled.
    $("#backlog-count").textContent = backlog.length;
    const backlogList = $("#backlog-list");
    backlogList.innerHTML = "";
    backlogList.dataset.dropzone = "1";
    if (backlog.length === 0) {
      const hint = document.createElement("p");
      hint.className = "empty-hint";
      hint.textContent = "Nothing waiting. Drop a task here to take it off the calendar.";
      backlogList.append(hint);
    } else {
      backlog.forEach((t) => backlogList.append(cardEl(t)));
    }

    // Calendar.
    const grid = $("#grid");
    grid.className = `grid ${state.span === "week" ? "is-week" : "is-month"}`;
    grid.innerHTML = "";

    for (let i = 0; i < cells; i++) {
      const date = addDays(start, i);
      const key = iso(date);
      const cell = document.createElement("div");
      cell.className = "day";
      cell.dataset.day = key;
      if (state.span === "month" && date.getMonth() !== anchorMonth) cell.classList.add("is-outside");
      if (date.getDay() === 0 || date.getDay() === 6) cell.classList.add("is-weekend");
      if (key === todayISO) cell.classList.add("is-today");

      const head = document.createElement("div");
      head.className = "day-head";

      const num = document.createElement("span");
      num.className = "day-num";
      num.textContent = date.getDate();
      head.append(num);

      if (state.span === "week" || window.innerWidth < 900) {
        const dow = document.createElement("span");
        dow.className = "day-dow";
        dow.textContent = DOW.format(date);
        head.append(dow);
      }

      const items = scheduled.get(key) || [];
      const doneCount = items.filter((t) => t.done).length;
      if (doneCount) {
        const tally = document.createElement("span");
        tally.className = "day-tally";
        tally.textContent = `${doneCount}/${items.length}`;
        head.append(tally);
      }

      const add = document.createElement("button");
      add.className = "day-add";
      add.type = "button";
      add.textContent = "+";
      add.setAttribute("aria-label", `Add a task on ${DAY_LABEL.format(date)}`);
      add.addEventListener("click", (e) => {
        e.stopPropagation();
        addTask("New task", key, true);
      });
      head.append(add);

      const list = document.createElement("div");
      list.className = "day-list";
      list.dataset.day = key;
      list.dataset.dropzone = "1";
      items.forEach((t) => list.append(cardEl(t)));

      cell.append(head, list);
      grid.append(cell);
    }

    renderTally();
  }

  function renderTally() {
    const prefix = iso(state.anchor).slice(0, 7);
    const n = state.tasks.filter(
      (t) => t.done && t.completedAt && t.completedAt.startsWith(prefix)
    ).length;
    $("#tally-num").textContent = n;
    $("#tally-label").textContent = `ticked off in ${MONTH_YEAR.format(state.anchor)}`;
  }

  // ----------------------------------------------------------- mutations

  async function addTask(title, day = null, openAfter = false) {
    const optimistic = {
      id: -Date.now(),
      title,
      notes: "",
      strand: "",
      day,
      pos: 9e9,
      done: false,
      completedAt: null,
      createdAt: localStamp(),
    };
    state.tasks.push(optimistic);
    renderBoard();
    try {
      const { task } = await post("/api/tasks", { title, day, now: localStamp() });
      state.tasks = state.tasks.filter((t) => t.id !== optimistic.id).concat(task);
      renderBoard();
      if (openAfter) openSheet(task.id, true);
    } catch (err) {
      state.tasks = state.tasks.filter((t) => t.id !== optimistic.id);
      renderBoard();
      toast(err.message);
    }
  }

  async function toggleDone(id) {
    const task = byId(id);
    if (!task) return;
    const next = !task.done;
    task.done = next;
    task.completedAt = next ? localStamp() : null;
    if (next && task.day === null) task.day = iso(today());
    renderBoard();
    if (state.sheetId === id) paintSheetTick(task);
    try {
      const { task: fresh } = await patch(`/api/tasks/${id}`, { done: next, now: localStamp() });
      Object.assign(task, fresh);
      renderBoard();
    } catch (err) {
      toast(err.message);
      loadTasks();
    }
  }

  async function saveFields(id, fields) {
    const task = byId(id);
    if (!task) return;
    Object.assign(task, fields);
    renderBoard();
    try {
      const { task: fresh } = await patch(`/api/tasks/${id}`, { ...fields, now: localStamp() });
      Object.assign(task, fresh);
      renderBoard();
    } catch (err) {
      toast(err.message);
    }
  }

  async function deleteTask(id) {
    state.tasks = state.tasks.filter((t) => t.id !== id);
    renderBoard();
    closeSheet();
    try {
      await api(`/api/tasks/${id}`, { method: "DELETE" });
      toast("Deleted from the board. Anything ticked off stays in the record.");
    } catch (err) {
      toast(err.message);
      loadTasks();
    }
  }

  // ----------------------------------------------------------------- drag

  let drag = null;
  let dragMoved = false;
  let pressTimer = null;

  function blockTouchScroll(e) {
    if (drag && drag.active) e.preventDefault();
  }

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const card = e.target.closest(".card");
    if (!card || e.target.closest(".tick")) return;

    dragMoved = false;
    const rect = card.getBoundingClientRect();
    const pending = {
      id: Number(card.dataset.id),
      card,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
      touch: e.pointerType !== "mouse",
      ready: e.pointerType === "mouse",
    };
    drag = pending;

    if (pending.touch) {
      /* Touch needs a deliberate press, so a flick still scrolls the day. */
      pressTimer = setTimeout(() => {
        if (drag === pending && !drag.active) {
          pending.ready = true;
          beginDrag(pending.startX, pending.startY);
        }
      }, 300);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    document.addEventListener("touchmove", blockTouchScroll, { passive: false });
  }

  function beginDrag(x, y) {
    drag.active = true;
    dragMoved = true;
    document.body.style.cursor = "grabbing";

    const ghost = drag.card.cloneNode(true);
    ghost.classList.add("card-ghost");
    ghost.style.width = `${drag.width}px`;
    document.body.append(ghost);
    drag.ghost = ghost;

    const slot = document.createElement("div");
    slot.className = "card-slot";
    drag.slot = slot;
    drag.card.after(slot);
    drag.card.style.display = "none";

    moveGhost(x, y);
  }

  function moveGhost(x, y) {
    drag.ghost.style.left = `${x - drag.offsetX}px`;
    drag.ghost.style.top = `${y - drag.offsetY}px`;
  }

  function onPointerMove(e) {
    if (!drag) return;
    const dx = Math.abs(e.clientX - drag.startX);
    const dy = Math.abs(e.clientY - drag.startY);

    if (!drag.active) {
      if (drag.touch) {
        if (dx > 10 || dy > 10) cancelPending(); // a scroll, not a drag
        return;
      }
      if (dx < 5 && dy < 5) return;
      beginDrag(e.clientX, e.clientY);
    }

    e.preventDefault();
    moveGhost(e.clientX, e.clientY);
    drag.ghost.style.visibility = "hidden";
    const under = document.elementFromPoint(e.clientX, e.clientY);
    drag.ghost.style.visibility = "";

    const zone = under && under.closest("[data-dropzone]");
    $$(".day.is-drop-target").forEach((d) => d.classList.remove("is-drop-target"));
    if (!zone) return;
    const dayCell = zone.closest(".day");
    if (dayCell) dayCell.classList.add("is-drop-target");

    const hint = zone.querySelector(".empty-hint");
    if (hint) hint.remove();

    const siblings = [...zone.children].filter(
      (n) => n.classList.contains("card") && n !== drag.card
    );
    const after = siblings.find((n) => {
      const r = n.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (after) zone.insertBefore(drag.slot, after);
    else zone.append(drag.slot);

    autoScroll(e.clientY);
  }

  function autoScroll(y) {
    const scroller =
      window.innerWidth < 900 ? $(".board") : drag.slot.closest(".day-list") || $("#grid");
    if (!scroller) return;
    const r = scroller.getBoundingClientRect();
    if (y < r.top + 44) scroller.scrollTop -= 12;
    else if (y > r.bottom - 44) scroller.scrollTop += 12;
  }

  function cancelPending() {
    clearTimeout(pressTimer);
    teardownDrag();
  }

  function teardownDrag() {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    document.removeEventListener("touchmove", blockTouchScroll);
    document.body.style.cursor = "";
    if (drag && drag.ghost) drag.ghost.remove();
    if (drag && drag.card) drag.card.style.display = "";
    if (drag && drag.slot) drag.slot.remove();
    $$(".day.is-drop-target").forEach((d) => d.classList.remove("is-drop-target"));
    drag = null;
    if (dragMoved) {
      const eat = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        dragMoved = false;
      };
      document.addEventListener("click", eat, { capture: true, once: true });
      setTimeout(() => {
        document.removeEventListener("click", eat, { capture: true });
        dragMoved = false;
      }, 350);
    }
  }

  async function onPointerUp() {
    clearTimeout(pressTimer);
    if (!drag) return;
    if (!drag.active) {
      teardownDrag();
      return;
    }

    const zone = drag.slot.parentElement;
    const id = drag.id;
    if (!zone || !zone.dataset.dropzone) {
      teardownDrag();
      return;
    }
    const day = zone.dataset.day === "backlog" ? null : zone.dataset.day;
    /* The dragged card is still in the DOM, just hidden, so it has to be
       excluded here — otherwise a same-day reorder sends its id twice, and
       the server's last write (its old position) puts it straight back. */
    const order = [...zone.children]
      .filter((n) => n === drag.slot || (n.classList.contains("card") && n !== drag.card))
      .map((n) => (n === drag.slot ? id : Number(n.dataset.id)));

    teardownDrag();

    const task = byId(id);
    if (!task) return;
    task.day = day ?? null;
    order.forEach((tid, i) => {
      const t = byId(tid);
      if (t) t.pos = i;
    });
    renderBoard();

    try {
      const { task: fresh } = await post("/api/move", {
        id,
        day: day ?? null,
        order,
        now: localStamp(),
      });
      Object.assign(task, fresh);
      renderBoard();
    } catch (err) {
      toast(err.message);
      loadTasks();
    }
  }

  // ---------------------------------------------------------------- sheet

  let sheetTimer;

  function openSheet(id, selectTitle = false) {
    const task = byId(id);
    if (!task) return;
    state.sheetId = id;

    $("#sheet-title").value = task.title;
    $("#sheet-notes").value = task.notes;
    $("#sheet-strand").value = task.strand;
    $("#sheet-day").value = task.day || "";
    $("#sheet-stamp").textContent = task.done
      ? `Done ${DAY_LABEL.format(fromISO(task.completedAt.slice(0, 10)))}`
      : `Added ${DAY_LABEL.format(fromISO(task.createdAt.slice(0, 10)))}`;
    paintSheetTick(task);

    const list = $("#strand-list");
    list.innerHTML = "";
    [...new Set(state.tasks.map((t) => t.strand).filter(Boolean))].sort().forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s;
      list.append(opt);
    });

    $("#sheet").hidden = false;
    $("#sheet-scrim").hidden = false;
    if (selectTitle) {
      const el = $("#sheet-title");
      el.focus();
      el.select();
    }
  }

  function paintSheetTick(task) {
    const btn = $("#sheet-tick");
    btn.classList.toggle("is-done", task.done);
    $(".tick-text", btn).textContent = task.done
      ? `Done — ${DAY_LABEL.format(fromISO(task.completedAt.slice(0, 10)))}`
      : "Mark as done";
  }

  function closeSheet() {
    flushSheet();
    state.sheetId = null;
    $("#sheet").hidden = true;
    $("#sheet-scrim").hidden = true;
  }

  function flushSheet() {
    clearTimeout(sheetTimer);
    const id = state.sheetId;
    if (id === null) return;
    const task = byId(id);
    if (!task) return;
    const title = $("#sheet-title").value.trim();
    const fields = {};
    if (title && title !== task.title) fields.title = title;
    if ($("#sheet-notes").value !== task.notes) fields.notes = $("#sheet-notes").value;
    if ($("#sheet-strand").value.trim() !== task.strand) fields.strand = $("#sheet-strand").value.trim();
    const day = $("#sheet-day").value || null;
    if (day !== task.day) fields.day = day;
    if (Object.keys(fields).length) saveFields(id, fields);
  }

  // --------------------------------------------------------------- record

  async function loadRecord(month) {
    const select = $("#record-month");
    const { months } = await api("/api/months");
    const current = iso(today()).slice(0, 7);
    const all = [...new Set([current, ...months])].sort().reverse();
    const chosen = month && all.includes(month) ? month : all[0];

    select.innerHTML = "";
    all.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = MONTH_YEAR.format(fromISO(`${m}-01`));
      if (m === chosen) opt.selected = true;
      select.append(opt);
    });

    state.report = await api(`/api/report?month=${chosen}`);
    renderRecord();
  }

  function renderRecord() {
    const data = state.report;
    if (!data) return;
    $("#record-title").textContent = data.label;

    $("#tallies").innerHTML = `
      <div class="tally"><span class="tally-value is-done">${data.completedCount}</span>
        <span class="tally-cap">tasks completed</span></div>
      <div class="tally"><span class="tally-value">${data.activeDays}</span>
        <span class="tally-cap">days with work logged</span></div>
      <div class="tally"><span class="tally-value is-open">${data.openCount}</span>
        <span class="tally-cap">still open at month end</span></div>`;

    const body = $("#record-body");
    body.innerHTML = "";

    if (data.completedCount === 0) {
      const p = document.createElement("p");
      p.className = "record-empty";
      p.textContent = "Nothing ticked off this month yet — the record fills itself as you work.";
      body.append(p);
    }

    const groups =
      state.recordGroup === "strand"
        ? data.byStrand.map((g) => ({ name: g.strand, tasks: g.tasks }))
        : data.byDay.map((g) => ({
            name: DAY_LABEL.format(fromISO(g.day)),
            tasks: g.tasks,
          }));

    for (const group of groups) {
      const section = document.createElement("section");
      section.className = "group";
      section.innerHTML = `<header class="group-head">
          <h2 class="group-name">${escapeHtml(group.name)}</h2>
          <span class="group-count">${group.tasks.length}</span>
        </header>`;
      for (const task of group.tasks) {
        const entry = document.createElement("div");
        entry.className = "entry";
        const showStrand = state.recordGroup === "day" && task.strand;
        entry.innerHTML = `
          <div class="entry-date">${escapeHtml(
            DAY_LABEL.format(fromISO(task.completedAt.slice(0, 10)))
          )}</div>
          <div>
            <div class="entry-title">${escapeHtml(task.title)}</div>
            ${task.notes.trim() ? `<p class="entry-notes">${escapeHtml(task.notes.trim())}</p>` : ""}
            ${showStrand ? `<span class="entry-strand">${escapeHtml(task.strand)}</span>` : ""}
          </div>`;
        section.append(entry);
      }
      body.append(section);
    }

    if (data.open.length) {
      const section = document.createElement("section");
      section.className = "group record-open";
      section.innerHTML = `<header class="group-head">
          <h2 class="group-name">Carried forward</h2>
          <span class="group-count">${data.open.length}</span>
        </header>`;
      for (const task of data.open) {
        const entry = document.createElement("div");
        entry.className = "entry";
        entry.innerHTML = `
          <div class="entry-date">${escapeHtml(DAY_LABEL.format(fromISO(task.day)))}</div>
          <div><div class="entry-title">${escapeHtml(task.title)}</div></div>`;
        section.append(entry);
      }
      body.append(section);
    }
  }

  // ----------------------------------------------------------------- view

  function setView(view) {
    state.view = view;
    $$(".view-tab").forEach((b) => {
      const on = b.dataset.view === view;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
    });
    $("#view-board").hidden = view !== "board";
    $("#view-record").hidden = view !== "record";
    $("#period-controls").style.visibility = view === "board" ? "" : "hidden";
    $("#span-toggle").style.visibility = view === "board" ? "" : "hidden";
    if (view === "record") loadRecord($("#record-month").value || null).catch((e) => toast(e.message));
  }

  function step(direction) {
    if (state.span === "week") {
      state.anchor = addDays(state.anchor, 7 * direction);
    } else {
      state.anchor = new Date(
        state.anchor.getFullYear(),
        state.anchor.getMonth() + direction,
        1
      );
    }
    loadTasks().catch((e) => toast(e.message));
  }

  // ----------------------------------------------------------------- wire

  function showGate() {
    $("#gate").hidden = false;
    $("#app").hidden = true;
    setTimeout(() => $("#password").focus(), 30);
  }

  async function showApp() {
    $("#gate").hidden = true;
    $("#app").hidden = false;
    await loadTasks();
  }

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#gate-error");
    err.hidden = true;
    try {
      await post("/api/login", { password: $("#password").value });
      $("#password").value = "";
      showApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  $("#sign-out").addEventListener("click", async () => {
    await post("/api/logout", {}).catch(() => {});
    // Otherwise the cached board would still be readable offline by whoever
    // picks the phone up next.
    navigator.serviceWorker?.controller?.postMessage("clear-cache");
    showGate();
  });

  $("#quick-add").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#quick-title");
    const title = input.value.trim();
    if (!title) return;
    input.value = "";
    addTask(title, null);
  });

  $$(".view-tab").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  $$("#span-toggle .seg-btn").forEach((b) =>
    b.addEventListener("click", () => {
      state.span = b.dataset.span;
      $$("#span-toggle .seg-btn").forEach((x) => x.classList.toggle("is-active", x === b));
      loadTasks().catch((e) => toast(e.message));
    })
  );

  $$("#record-group .seg-btn").forEach((b) =>
    b.addEventListener("click", () => {
      state.recordGroup = b.dataset.group;
      $$("#record-group .seg-btn").forEach((x) => x.classList.toggle("is-active", x === b));
      renderRecord();
    })
  );

  const railToggle = $("#rail-toggle");

  function setRail(collapsed) {
    document.body.classList.toggle("is-rail-collapsed", collapsed);
    railToggle.setAttribute("aria-expanded", String(!collapsed));
    const label = collapsed ? "Show the task list" : "Hide the task list";
    railToggle.title = label;
    railToggle.setAttribute("aria-label", label);
    try {
      localStorage.setItem("tasks.rail", collapsed ? "hidden" : "shown");
    } catch {
      /* private browsing — the preference just won't persist */
    }
  }

  railToggle.addEventListener("click", () =>
    setRail(!document.body.classList.contains("is-rail-collapsed"))
  );

  $("#prev").addEventListener("click", () => step(-1));
  $("#next").addEventListener("click", () => step(1));
  $("#period-label").addEventListener("click", () => {
    state.anchor = today();
    loadTasks().catch((e) => toast(e.message));
  });

  $("#record-month").addEventListener("change", (e) =>
    loadRecord(e.target.value).catch((err) => toast(err.message))
  );

  $("#copy-report").addEventListener("click", async () => {
    const month = $("#record-month").value;
    try {
      const res = await fetch(`/api/report.md?month=${month}`);
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      toast("Copied. Paste it straight into your report.");
    } catch {
      toast("Couldn't reach the clipboard — use the .md download instead.");
    }
  });

  $("#dl-md").addEventListener("click", () => {
    window.location = `/api/report.md?month=${$("#record-month").value}`;
  });
  $("#dl-csv").addEventListener("click", () => {
    window.location = `/api/report.csv?month=${$("#record-month").value}`;
  });

  $("#sheet-close").addEventListener("click", closeSheet);
  $("#sheet-scrim").addEventListener("click", closeSheet);
  $("#sheet-tick").addEventListener("click", () => {
    if (state.sheetId !== null) toggleDone(state.sheetId);
  });
  $("#sheet-delete").addEventListener("click", () => {
    const task = byId(state.sheetId);
    if (!task) return;
    if (confirm(`Delete “${task.title}” from the board?`)) deleteTask(task.id);
  });

  ["#sheet-title", "#sheet-notes", "#sheet-strand"].forEach((sel) =>
    $(sel).addEventListener("input", () => {
      clearTimeout(sheetTimer);
      sheetTimer = setTimeout(flushSheet, 700);
    })
  );
  $("#sheet-day").addEventListener("change", flushSheet);

  document.addEventListener("pointerdown", onPointerDown);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#sheet").hidden) closeSheet();
    if (e.key === "/" && document.activeElement === document.body) {
      e.preventDefault();
      setRail(false);
      $("#quick-title").focus();
    }
  });

  window.addEventListener("beforeunload", flushSheet);

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.view === "board") renderBoard();
    }, 200);
  });

  // ------------------------------------------------------------------ go

  try {
    if (localStorage.getItem("tasks.rail") === "hidden") setRail(true);
  } catch {
    /* no stored preference available; the rail stays open */
  }

  window.addEventListener("offline", () => setOffline(true));
  window.addEventListener("online", () => {
    setOffline(false);
    loadTasks().catch(() => setOffline(true));
  });

  // Registration needs a secure context, so this is a no-op over the plain
  // Tailscale bind — the app still works there, just without the offline copy.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }

  if (document.body.dataset.signedIn === "yes") {
    showApp().catch((e) => {
      if (e instanceof OfflineError) setOffline(true);
      else showGate();
    });
  } else {
    showGate();
  }
})();
