/* Reset Radar — renders the heatmap + signal log from data/*.json */

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEKDAYS = ["", "Mon", "", "Wed", "", "Fri", ""];

const state = { config: null, events: [], byDate: new Map(), filter: null, status: null };

async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// All day math runs in the configured timezone offset, expressed as UTC-midnight
// dates whose Y/M/D match that timezone's calendar — so "today" lines up with
// the tracker owner's local day rather than the viewer's browser timezone.
function tzOffset() {
  return (state.config && state.config.timezoneOffsetHours) || 0;
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

function parseDate(s) {
  return new Date(`${s}T00:00:00Z`);
}

function tzToday() {
  const shifted = new Date(Date.now() + tzOffset() * 3600000);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()),
  );
}

function relTime(dateStr) {
  const days = Math.round((tzToday().getTime() - parseDate(dateStr).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

function fmtDate(dateStr) {
  const d = parseDate(dateStr);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function fmtTime(at) {
  if (!at) return "";
  const d = new Date(new Date(at).getTime() + tzOffset() * 3600000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/* ── X (Twitter) single-tweet embeds ─────────────────────────────────── */
let _twttrPromise = null;
function ensureWidgets() {
  if (window.twttr && window.twttr.widgets) return Promise.resolve(window.twttr);
  if (!_twttrPromise) {
    _twttrPromise = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "https://platform.twitter.com/widgets.js";
      s.async = true;
      s.charset = "utf-8";
      s.onload = () => resolve(window.twttr || null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  }
  return _twttrPromise;
}

function renderEmbeds(container) {
  ensureWidgets().then((tw) => {
    if (tw && tw.widgets) tw.widgets.load(container);
  });
}

function tweetId(url) {
  const m = String(url || "").match(/status\/(\d+)/);
  return m ? m[1] : null;
}

// Build a single-tweet embed. Fallback content (our text + link) stays visible
// until the widget renders — and remains if the tweet was deleted.
function embedHtml(e) {
  const id = tweetId(e.url);
  const fallback = `${escapeHtml(e.text)} — <a href="${e.url}" target="_blank" rel="noopener">@${e.account} ↗</a>`;
  if (!id) return `<p class="embed-fallback">${fallback}</p>`;
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  return `<blockquote class="twitter-tweet" data-theme="${theme}" data-dnt="true" data-conversation="none" data-align="left"><a href="https://twitter.com/${e.account}/status/${id}">${fallback}</a></blockquote>`;
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

  const today = tzToday();
  const start = new Date(today);
  start.setUTCDate(today.getUTCDate() - 364);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay()); // back to Sunday

  const weeks = [];
  const cursor = new Date(start);
  while (cursor <= today) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push(cursor <= today ? new Date(cursor) : null);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(week);
  }

  document.getElementById("rangeReadout").textContent =
    `${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()} → now`;

  // month labels row
  const months = document.createElement("div");
  months.className = "hm-months";
  let lastMonth = -1;
  for (const week of weeks) {
    const span = document.createElement("span");
    const firstReal = week.find(Boolean);
    if (firstReal && firstReal.getUTCMonth() !== lastMonth) {
      span.textContent = MONTHS[firstReal.getUTCMonth()];
      lastMonth = firstReal.getUTCMonth();
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
        if (evs.some((e) => e.unverified)) cell.classList.add("reported");
        cell.dataset.date = key;
        cell.tabIndex = 0;
        cell.setAttribute("role", "button");
        cell.setAttribute("aria-label", `${fmtDate(key)}: ${evs.length} reset(s)`);
        paintCell(cell, evs);
        cell.addEventListener("mouseenter", showTip);
        cell.addEventListener("mousemove", moveTip);
        cell.addEventListener("mouseleave", hideTip);
        cell.addEventListener("click", () => { hideTip(); openModal(key); });
        cell.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openModal(key); }
        });
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
  const ordered = evs
    .slice()
    .sort((a, b) => ((a.at || a.date) < (b.at || b.date) ? 1 : -1));
  const rows = ordered
    .map((ev) => {
      const cfg = state.config.models[ev.model];
      const tag = ev.unverified ? ' <span class="tt-tag">reported</span>' : "";
      const tm = fmtTime(ev.at);
      return `<div class="tt-row"><span class="tt-dot" style="background:${cfg.color}"></span>${cfg.label}${tm ? ` · ${tm}` : ""}${tag}</div>`;
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

/* ── day modal ──────────────────────────────────────────────────────── */
function openModal(dateStr) {
  const evs = eventsOn(dateStr)
    .slice()
    .sort((a, b) => ((a.at || a.date) < (b.at || b.date) ? 1 : -1));
  if (!evs.length) return;
  const m = document.getElementById("modal");
  m.querySelector(".m-date").textContent = fmtDate(dateStr);
  m.querySelector(".m-count").textContent = `${evs.length} reset${evs.length === 1 ? "" : "s"}`;
  const body = m.querySelector(".m-body");
  body.innerHTML = evs
    .map((e) => {
      const cfg = state.config.models[e.model];
      const tm = fmtTime(e.at);
      const when = tm ? `${tm} ${state.config.timezoneLabel || ""}`.trim() : "";
      const tag = e.unverified ? ' <span class="badge-tag">reported</span>' : "";
      return `<div class="m-item" style="--c:${cfg.color}">
        <div class="m-item-head">
          <span class="badge">${cfg.label}${tag}</span>
          <span class="m-time">${when}</span>
        </div>
        <div class="embed-slot">${embedHtml(e)}</div>
      </div>`;
    })
    .join("");
  renderEmbeds(body);
  m.hidden = false;
  history.replaceState(null, "", "#day=" + dateStr);
  requestAnimationFrame(() => m.classList.add("show"));
  document.body.style.overflow = "hidden";
  m.querySelector(".m-close").focus();
}

function closeModal() {
  const m = document.getElementById("modal");
  m.classList.remove("show");
  m.hidden = true;
  document.body.style.overflow = "";
  if (location.hash.startsWith("#day=")) history.replaceState(null, "", location.pathname + location.search);
}

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

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
  const swatches = items
    .map(
      ([bg, label]) =>
        `<span class="legend-item"><span class="legend-sw" style="background:${bg}"></span>${label}</span>`,
    )
    .join("");
  const reported =
    `<span class="legend-item"><span class="legend-sw reported"></span>reported (source pending)</span>`;
  const tz = state.config.timezoneLabel
    ? `<span class="legend-note">days bucketed in ${state.config.timezoneLabel}</span>`
    : "";
  host.innerHTML = swatches + reported + tz;
}

/* ── signal log ─────────────────────────────────────────────────────── */
function renderLog() {
  const host = document.getElementById("log");
  const count = document.getElementById("logCount");
  const evs = [...activeEvents()].sort((a, b) =>
    (a.at || a.date) < (b.at || b.date) ? 1 : -1,
  );
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

  // Lazy-load embeds: inject the blockquote (shows fallback text) for every row,
  // but only ask the widget script to render one once it scrolls near view.
  const io = new IntersectionObserver(
    (entries, obs) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          renderEmbeds(en.target);
          obs.unobserve(en.target);
        }
      }
    },
    { rootMargin: "400px 0px" },
  );
  for (const e of evs) {
    const cfg = state.config.models[e.model];
    const li = document.createElement("li");
    li.className = e.unverified ? "log-item reported" : "log-item";
    li.style.setProperty("--c", cfg.color);
    const tag = e.unverified ? ' <span class="badge-tag">reported</span>' : "";
    li.innerHTML = `
      <div class="log-meta">
        <span class="badge">${cfg.label}${tag}</span>
        <span class="log-when">${fmtDate(e.date)} · ${fmtTime(e.at)} · ${relTime(e.date)}</span>
      </div>
      <div class="embed-slot">${embedHtml(e)}</div>`;
    host.appendChild(li);
    io.observe(li);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ── sync readout ───────────────────────────────────────────────────── */
function renderSync() {
  const el = document.getElementById("syncTime");
  // Prefer the refresher's last-checked stamp (advances every loop run, even when
  // no new reset landed); fall back to the newest event stamp for older data.
  const stamps = state.events.map((e) => e.addedAt).filter(Boolean).sort();
  const latest = (state.status && state.status.lastCheckedAt) || stamps[stamps.length - 1];
  if (!latest) {
    el.textContent = "no data";
    return;
  }
  // Render in the viewer's own timezone with no offset label — a plain
  // "last updated" wall-clock, using local Date getters (not the UTC ones).
  const d = new Date(latest);
  const p = (n) => String(n).padStart(2, "0");
  el.textContent = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ── orchestration ──────────────────────────────────────────────────── */
function renderAll() {
  renderChannels();
  renderHeatmap();
  renderLegend();
  renderLog();
}

/* ── theme ──────────────────────────────────────────────────────────────
   The <head> inline script has already stamped data-theme from the stored
   choice or the system preference. Here we wire the toggle (which records an
   explicit choice) and keep following the system while no choice is stored. */
function initTheme() {
  const root = document.documentElement;
  const KEY = "rr-theme";
  const mq = matchMedia("(prefers-color-scheme: light)");
  const stored = () => {
    try { return localStorage.getItem(KEY); } catch { return null; }
  };
  const systemTheme = () => (mq.matches ? "light" : "dark");
  if (root.dataset.theme !== "light" && root.dataset.theme !== "dark") {
    root.dataset.theme = stored() || systemTheme();
  }
  const btn = document.getElementById("themeToggle");
  if (btn) {
    btn.addEventListener("click", () => {
      const next = root.dataset.theme === "light" ? "dark" : "light";
      root.dataset.theme = next;
      try { localStorage.setItem(KEY, next); } catch {}
    });
  }
  mq.addEventListener("change", () => {
    if (!stored()) root.dataset.theme = systemTheme();
  });
}

async function init() {
  try {
    const [config, events, status] = await Promise.all([
      loadJSON("data/config.json"),
      loadJSON("data/events.json"),
      loadJSON("data/status.json").catch(() => null),
    ]);
    state.config = config;
    state.events = Array.isArray(events) ? events : [];
    state.status = status;
    indexEvents();
    renderSync();
    renderAll();
    const m = location.hash.match(/^#day=(\d{4}-\d{2}-\d{2})$/);
    if (m) openModal(m[1]);
  } catch (err) {
    document.getElementById("log").innerHTML =
      `<li class="empty">Couldn't load radar data (${escapeHtml(err.message)}). Try refreshing.</li>`;
    console.error(err);
  }
}

initTheme();
init();
