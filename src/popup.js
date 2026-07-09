// popup.js — thin UI over chrome.storage. The content script reacts to state
// changes; the popup only reads/writes config + status.
var INFO = ["firstName", "lastName", "email", "flat"];
var MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
var DEFAULT_URL = "https://calendar.google.com/calendar/u/0/appointments/schedules/AcZssZ10yTRRi6qPrNw8KI4__oFHvyiJDvU_Fwnszv5LGhwBzr_VL1DhIZaCAR4d6g488tLvnhFNtzsu";

function get(keys) { return new Promise(function (r) { chrome.storage.local.get(keys, r); }); }
function set(obj) { return new Promise(function (r) { chrome.storage.local.set(obj, r); }); }

function pad(n) { return (n < 10 ? "0" : "") + n; }
function el(id) { return document.getElementById(id); }

// ---- build date dropdowns (day / month / year) ----
function buildDateSelects() {
  var dd = el("dd"), mm = el("mm"), yyyy = el("yyyy");
  for (var d = 1; d <= 31; d++) dd.add(new Option(String(d), pad(d)));
  for (var m = 0; m < 12; m++) mm.add(new Option(MONTHS_RU[m], pad(m + 1)));
  var y0 = new Date().getFullYear();
  for (var y = y0; y <= y0 + 1; y++) yyyy.add(new Option(String(y), String(y)));
}

// compose / parse "YYYY-MM-DD"
function readDate() {
  var y = el("yyyy").value, m = el("mm").value, d = el("dd").value;
  if (!y || !m || !d) return "";
  return y + "-" + m + "-" + d;
}
function writeDate(iso) {
  var m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  var dt = m ? { y: m[1], mo: m[2], d: m[3] } : defaultDate();
  el("yyyy").value = dt.y; el("mm").value = dt.mo; el("dd").value = dt.d;
}
function defaultDate() {
  var t = new Date();
  return { y: String(t.getFullYear()), mo: pad(t.getMonth() + 1), d: pad(t.getDate()) };
}

function readForm() {
  var cfg = {};
  cfg.calendarUrl = DEFAULT_URL; // fixed, not user-editable
  cfg.targetDate = readDate();
  cfg.targetTime = el("targetTime").value;
  INFO.forEach(function (id) { cfg[id] = el(id).value; });
  cfg.autoBook = el("autoBook").checked;
  return cfg;
}

function applyStatus(status, state) {
  var e = el("status");
  e.className = "status " + (status && status.level ? status.level : "");
  if (state === "idle" && !status) { e.textContent = "Выключено"; return; }
  e.textContent = status ? status.text : (state === "armed" ? "Ожидание…" : state === "grab" ? "Бронирую…" : "Выключено");
}

function applyToggle(state) {
  var btn = el("toggle");
  var on = (state === "armed" || state === "grab");
  btn.className = "toggle " + (on ? "on" : "off");
  btn.textContent = on ? "Выключить" : "Включить ожидание";
}

async function restore() {
  var st = await get(["cfg", "state", "status"]);
  var cfg = st.cfg || {};
  el("calendarUrl").value = DEFAULT_URL;
  writeDate(cfg.targetDate);
  if (cfg.targetTime) el("targetTime").value = cfg.targetTime;
  INFO.forEach(function (id) { if (cfg[id] != null) el(id).value = cfg[id]; });
  el("autoBook").checked = cfg.autoBook !== false;
  applyToggle(st.state || "idle");
  applyStatus(st.status, st.state || "idle");
}

async function saveCfg() { await set({ cfg: readForm() }); }

async function toggle() {
  var st = await get(["state"]);
  var on = (st.state === "armed" || st.state === "grab");
  if (on) {
    await set({ state: "idle", status: { text: "Выключено", level: "info" } });
  } else {
    var cfg = readForm();
    if (!cfg.targetDate || !cfg.targetTime) { alert("Заполни дату и время."); return; }
    await set({ cfg: cfg, state: "armed", status: { text: "Ожидание слота…", level: "info" } });
  }
}

async function bookNow() {
  var cfg = readForm();
  if (!cfg.targetDate || !cfg.targetTime) { alert("Заполни дату и время."); return; }
  // Fast mode: no reload. The content script grabs on the already-open tab.
  await set({ cfg: cfg, state: "grab", status: { text: "Бронирую…", level: "info" } });
  chrome.tabs.query({ url: "https://calendar.google.com/calendar/*/appointments/schedules/*" }, function (tabs) {
    if (tabs && tabs[0]) {
      chrome.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId != null) chrome.windows.update(tabs[0].windowId, { focused: true });
    }
    window.close();
  });
}

function openCalendar() {
  var url = DEFAULT_URL;
  set({ cfg: readForm() });
  // Open the calendar in the currently active tab of this window.
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs && tabs[0]) chrome.tabs.update(tabs[0].id, { url: url });
    else chrome.tabs.create({ url: url });
    window.close();
  });
}

function init() {
  buildDateSelects();
  restore();
  // Autosave: selects/checkbox on change, text inputs on every keystroke.
  ["dd", "mm", "yyyy", "targetTime", "autoBook"].forEach(function (id) {
    el(id).addEventListener("change", saveCfg);
  });
  INFO.forEach(function (id) {
    el(id).addEventListener("input", saveCfg);
    el(id).addEventListener("change", saveCfg);
  });
  el("openCal").addEventListener("click", openCalendar);
  el("toggle").addEventListener("click", toggle);
  el("bookNow").addEventListener("click", bookNow);
}

// Run now if the DOM is already parsed, otherwise wait for it.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local") return;
  get(["state", "status"]).then(function (st) {
    applyToggle(st.state || "idle");
    applyStatus(st.status, st.state || "idle");
  });
});
