/* Reset Radar — renders the heatmap + signal log from data/*.json */

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEKDAYS = ["", "Mon", "", "Wed", "", "Fri", ""];

const state = { config: null, events: [], byDate: new Map(), filter: null };

async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function relTime(dateStr) {
  const then = parseDate(dateStr);
  const days = Math.round((Date.now() - then.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

function fmtDate(dateStr) {
  const d = parseDate(dateStr);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/* ── data prep ──────────────────────────────────────────────────────── */
function indexEvents() {
  state.byDate = new Map();
  for (const e of state.events) {
    if (!state.byDate.has(e.date)) state.byDate.set(e.date, []);
    state.byDate.get(e.date).push(e);
  }
}

function activeEvents() {
  return state.filter
    ? state.events.filter((e) => e.model === state.filter)
    : state.events;
}

function eventsOn(dateStr) {
  const evs = state.byDate.get(dateStr) || [];
  return state.filter ? evs.filter((e) => e.model === state.filter) : evs;
}

/* ── channels ───────────────────────────────────────────────────────── */
function renderChannels() {
  const host = document.getElementById("channels");
  host.innerHTML = "";
  for (const [key, cfg] of Object.entries(state.config.models)) {
    const evs = state.events.filter((e) => e.model === key);
    const last = evs.reduce((a, b) => (a && a.date > b.date ? a : b), null);
    const btn = document.createElement("button");
    btn.className = "chan";
    btn.style.setProperty("--c", cfg.color);
    btn.setAttribute("aria-pressed", state.filter === key ? "true" : "false");
    btn.innerHTML = `
      <div class="chan-top">
        <span class="chan-led"></span>
        <span class="chan-name">${cfg.label}</span>
        <span class="chan-handle">@${cfg.account}</span>
      </div>
      <div class="chan-count">${evs.length}<span class="unit">reset${evs.length === 1 ? "" : "s"}</span></div>
      <div class="chan-last">${last ? "last " + relTime(last.date) : "none on record"}</div>`;
    btn.addEventListener("click", () => {
      state.filter = state.filter === key ? null : key;
      renderAll();
    });
    host.appendChild(btn);
  }
}

/* ── heatmap ────────────────────────────────────────────────────────── */
function renderHeatmap() {
  const host = document.getElementById("heatmap");
  host.innerHTML = "";

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(today.getDate() - 364);
  start.setDate(start.getDate() - start.getDay()); // back to Sunday

  const weeks = [];
  const cursor = new Date(start);
  while (cursor <= today) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push(cursor <= today ? new Date(cursor) : null);
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  document.getElementById("rangeReadout").textContent =
    `${MONTHS[start.getMonth()]} ${start.getFullYear()} → now`;

  // month labels row
  const months = document.createElement("div");
  months.className = "hm-months";
  let lastMonth = -1;
  for (const week of weeks) {
    const span = document.createElement("span");
    const firstReal = week.find(Boolean);
    if (firstReal && firstReal.getMonth() !== lastMonth) {
      span.textContent = MONTHS[firstReal.getMonth()];
      lastMonth = firstReal.getMonth();
    }
    months.appendChild(span);
  }

  // weekday labels
  const wd = document.createElement("div");
  wd.className = "hm-weekdays";
  for (const label of WEEKDAYS) {
    const span = document.createElement("span");
    span.textContent = label;
    wd.appendChild(span);
  }

  // cells (column-major: week by week, Sun→Sat)
  const grid = document.createElement("div");
  grid.className = "hm-grid";
  for (const week of weeks) {
    for (const day of week) {
      const cell = document.createElement("div");
      cell.className = "cell";
      if (!day) {
        cell.classList.add("void");
        grid.appendChild(cell);
        continue;
      }
      const key = iso(day);
      const evs = eventsOn(key);
      if (evs.length) {
        cell.classList.add("hit");
        cell.dataset.date = key;
        paintCell(cell, evs);
        cell.addEventListener("mouseenter", showTip);
        cell.addEventListener("mousemove", moveTip);
        cell.addEventListener("mouseleave", hideTip);
      }
      grid.appendChild(cell);
    }
  }

  host.append(months, wd, grid);
}

function paintCell(cell, evs) {
  const order = Object.keys(state.config.models);
  const models = [...new Set(evs.map((e) => e.model))].sort(
    (a, b) => order.indexOf(a) - order.indexOf(b),
  );
  const colors = models.map((m) => state.config.models[m].color);
  if (colors.length === 1) {
    cell.style.background = colors[0];
    cell.style.boxShadow = `0 0 7px ${colors[0]}, inset 0 0 0 1px ${colors[0]}`;
  } else {
    // conic wedges, one per model that reset that day
    const step = 100 / colors.length;
    const stops = colors
      .map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`)
      .join(", ");
    cell.style.background = `conic-gradient(from -45deg, ${stops})`;
    cell.style.boxShadow = `0 0 8px ${colors[0]}88`;
  }
}

/* ── tooltip ────────────────────────────────────────────────────────── */
const tip = () => document.getElementById("tooltip");

function showTip(e) {
  const key = e.currentTarget.dataset.date;
  const evs = eventsOn(key);
  const counts = {};
  for (const ev of evs) counts[ev.model] = (counts[ev.model] || 0) + 1;
  const rows = Object.entries(counts)
    .map(([m, n]) => {
      const cfg = state.config.models[m];
      return `<div class="tt-row"><span class="tt-dot" style="background:${cfg.color}"></span>${cfg.label}${n > 1 ? ` ×${n}` : ""}</div>`;
    })
    .join("");
  const t = tip();
  t.innerHTML = `<div class="tt-date">${fmtDate(key)}</div>${rows}`;
  t.classList.add("show");
  moveTip(e);
}

function moveTip(e) {
  const t = tip();
  const pad = 14;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  const r = t.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}

function hideTip() {
  tip().classList.remove("show");
}

/* ── legend ─────────────────────────────────────────────────────────── */
function renderLegend() {
  const host = document.getElementById("legend");
  const items = [
    ...Object.values(state.config.models).map(
      (m) => [m.color, m.label],
    ),
    ["conic-gradient(from -45deg, #d97757 0 50%, #4a9eff 50% 100%)", "multiple"],
    ["var(--void)", "no reset"],
  ];
  host.innerHTML = items
    .map(
      ([bg, label]) =>
        `<span class="legend-item"><span class="legend-sw" style="background:${bg}"></span>${label}</span>`,
    )
    .join("");
}

/* ── signal log ─────────────────────────────────────────────────────── */
function renderLog() {
  const host = document.getElementById("log");
  const count = document.getElementById("logCount");
  const evs = [...activeEvents()].sort((a, b) => (a.date < b.date ? 1 : -1));
  count.textContent = `${evs.length} event${evs.length === 1 ? "" : "s"}`;
  host.innerHTML = "";

  if (!evs.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.innerHTML = state.filter
      ? `No resets on record for this channel yet.`
      : `No resets detected yet. The radar checks <code>@ClaudeDevs</code>, <code>@thsottiaux</code> and <code>@SpaceXAI</code> every hour — a cell lights up here the day a reset lands.`;
    host.appendChild(li);
    return;
  }

  for (const e of evs) {
    const cfg = state.config.models[e.model];
    const li = document.createElement("li");
    li.className = "log-row";
    li.style.setProperty("--c", cfg.color);
    li.innerHTML = `
      <div class="log-date">${fmtDate(e.date)}<span class="rel">${relTime(e.date)}</span></div>
      <span class="badge">${cfg.label}</span>
      <div class="log-text">${escapeHtml(e.text)}</div>
      <a class="log-link" href="${e.url}" target="_blank" rel="noopener">@${e.account} ↗</a>`;
    host.appendChild(li);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ── sync readout ───────────────────────────────────────────────────── */
function renderSync() {
  const el = document.getElementById("syncTime");
  const stamps = state.events.map((e) => e.addedAt).filter(Boolean).sort();
  const latest = stamps[stamps.length - 1];
  if (!latest) {
    el.textContent = "no data";
    return;
  }
  const d = new Date(latest);
  el.textContent = `${iso(d)} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/* ── orchestration ──────────────────────────────────────────────────── */
function renderAll() {
  renderChannels();
  renderHeatmap();
  renderLegend();
  renderLog();
}

async function init() {
  try {
    const [config, events] = await Promise.all([
      loadJSON("data/config.json"),
      loadJSON("data/events.json"),
    ]);
    state.config = config;
    state.events = Array.isArray(events) ? events : [];
    indexEvents();
    renderSync();
    renderAll();
  } catch (err) {
    document.getElementById("log").innerHTML =
      `<li class="empty">Couldn't load radar data (${escapeHtml(err.message)}). Try refreshing.</li>`;
    console.error(err);
  }
}

init();
