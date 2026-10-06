// popup.js — thin UI over chrome.storage. The content script reacts to state
// changes; the popup only reads/writes config + status.
//
// Logging: everything goes through log() to console.log so a run can be read
// back from the popup's own DevTools console (right-click the popup ->
// Inspect). The calendar tab's console has the engine's logs.
var INFO = ["firstName", "lastName", "email", "flat"];
var MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
var DEFAULT_URL = "https://calendar.google.com/calendar/u/0/appointments/schedules/AcZssZ10yTRRi6qPrNw8KI4__oFHvyiJDvU_Fwnszv5LGhwBzr_VL1DhIZaCAR4d6g488tLvnhFNtzsu";

function stamp() {
  var d = new Date();
  return d.toTimeString().slice(0, 8) + "." + ("00" + d.getMilliseconds()).slice(-3);
}
function log() {
  console.log.apply(console, ["[padel popup " + stamp() + "]"].concat([].slice.call(arguments)));
}

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
// The rollover opens today+2, so that is the only date a fresh arm can be
// waiting FOR. Defaulting to today left first-time users armed for a day that
// can never open, with no direct shot and no explanation.
function defaultDate() {
  var t = new Date();
  t.setDate(t.getDate() + 2);
  return { y: String(t.getFullYear()), mo: pad(t.getMonth() + 1), d: pad(t.getDate()) };
}

// ---- booking mode: "direct" (pre-captured request at midnight) or "ui" ----
// A cfg without a mode (saved before the switch existed) is a direct one.
var MODE_HINT = {
  direct: "Запрос собирается за ~20 с до полуночи и уходит в момент открытия даты. Стреляет только в полночь открытия.",
  ui: "Радар ждёт появления слота и бронирует через форму на странице — в полночь или когда слот освободится."
};
function readMode() {
  var r = document.querySelector('input[name="mode"]:checked');
  return r && r.value === "ui" ? "ui" : "direct";
}
function writeMode(mode) {
  var want = mode === "ui" ? "ui" : "direct";
  document.querySelectorAll('input[name="mode"]').forEach(function (r) { r.checked = (r.value === want); });
}
function applyModeVisibility() {
  var mode = readMode();
  el("modeHint").textContent = MODE_HINT[mode];
  // "Book now" is a UI booking, so it only belongs to the UI mode.
  el("bookNowRow").hidden = mode !== "ui";
}

// ---- profiles: named sets of booking data (Имя/Фамилия/email/квартира) ----
// The active profile's values are mirrored into cfg on every edit/switch, so
// the content script keeps reading cfg exactly as before.
var profiles = [];
var activeProfileId = null;

function newProfileId() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function blankProfile() { return { id: newProfileId(), firstName: "", lastName: "", email: "", flat: "" }; }
function activeProfile() {
  for (var i = 0; i < profiles.length; i++) if (profiles[i].id === activeProfileId) return profiles[i];
  return null;
}
function profileLabel(p, idx) {
  var name = ((p.firstName || "") + " " + (p.lastName || "")).trim();
  return name || p.email || ("Профиль " + (idx + 1));
}
function renderProfileSelect() {
  var sel = el("profileSelect");
  while (sel.options.length) sel.remove(0);
  profiles.forEach(function (p, i) { sel.add(new Option(profileLabel(p, i), p.id)); });
  sel.value = activeProfileId;
  renderSecondProfile();
}

// The second slot picks a whole profile (usually another resident) rather than
// repeating the four text fields.
function renderSecondProfile() {
  var sel = el("secondProfile");
  var keep = sel.value;
  while (sel.options.length) sel.remove(0);
  profiles.forEach(function (p, i) { sel.add(new Option(profileLabel(p, i), p.id)); });
  if (keep && profiles.some(function (p) { return p.id === keep; })) sel.value = keep;
  else if (profiles.length) sel.value = profiles[profiles.length > 1 ? 1 : 0].id;
}
function profileById(id) {
  for (var i = 0; i < profiles.length; i++) if (profiles[i].id === id) return profiles[i];
  return null;
}
function applySecondVisibility() {
  var on = el("secondOn").checked;
  el("secondBox").hidden = !on;
  el("secondHintOff").hidden = on;
  renderSecondPreview();
}

// Profiles are labelled by name only, so spell out who the second booking
// actually books — a wrong email/flat is otherwise invisible until midnight.
function renderSecondPreview() {
  var box = el("secondPreview");
  if (!box) return;
  var p = profileById(el("secondProfile").value);
  if (!p) { box.textContent = "— профиль не выбран"; return; }
  var name = ((p.firstName || "") + " " + (p.lastName || "")).trim() || "без имени";
  box.textContent = name + " · " + (p.email || "без email") + " · кв. " + (p.flat || "—");
  box.title = box.textContent;
}
function fillInfoInputs(p) {
  INFO.forEach(function (id) { el(id).value = p[id] || ""; });
}
function saveProfiles() { return set({ profiles: profiles, activeProfileId: activeProfileId }); }

async function switchProfile() {
  activeProfileId = el("profileSelect").value;
  var p = activeProfile();
  if (p) fillInfoInputs(p);
  await saveProfiles();
  await saveCfg();
}

async function addProfile() {
  var p = blankProfile();
  profiles.push(p);
  activeProfileId = p.id;
  renderProfileSelect();
  fillInfoInputs(p);
  await saveProfiles();
  await saveCfg();
  el("firstName").focus();
}

async function deleteProfile() {
  var p = activeProfile();
  if (!p) return;
  if (!confirm("Удалить профиль «" + profileLabel(p, profiles.indexOf(p)) + "»?")) return;
  profiles = profiles.filter(function (x) { return x.id !== p.id; });
  if (!profiles.length) profiles = [blankProfile()];
  activeProfileId = profiles[0].id;
  var secondWasDeleted = el("secondProfile").value === p.id;
  renderProfileSelect();
  fillInfoInputs(activeProfile());
  // The second booking silently re-pointed to a substitute profile while the
  // preview kept describing the deleted person — the exact mix-up the preview
  // exists to prevent. Say it out loud and refresh the preview.
  renderSecondPreview();
  if (secondWasDeleted && el("secondOn").checked) {
    alert("Профиль второй брони удалён — проверь, кто выбран вместо него.");
  }
  await saveProfiles();
  await saveCfg();
}

// Text edits flow into the active profile too, and the option label follows
// the name as it's typed.
function onInfoEdit() {
  var p = activeProfile();
  if (p) {
    INFO.forEach(function (id) { p[id] = el(id).value; });
    var sel = el("profileSelect");
    if (sel.selectedIndex >= 0) sel.options[sel.selectedIndex].text = profileLabel(p, sel.selectedIndex);
    renderSecondProfile();     // labels follow the name as it's typed
    renderSecondPreview();     // ...and so does the second booking's summary
    saveProfiles();
  }
  saveCfg();
}

function readForm() {
  var cfg = {};
  cfg.calendarUrl = DEFAULT_URL; // fixed, not user-editable
  cfg.mode = readMode();
  cfg.targetDate = readDate();
  cfg.targetTime = el("targetTime").value;
  INFO.forEach(function (id) { cfg[id] = el(id).value; });
  // Second slot: same date, another time, booked with another profile's data.
  // Stored flat so the content script reads it without touching `profiles`.
  cfg.second = null;
  if (el("secondOn").checked) {
    var p = profileById(el("secondProfile").value);
    cfg.second = { time: el("secondTime").value, profileId: p ? p.id : null };
    INFO.forEach(function (id) { cfg.second[id] = p ? (p[id] || "") : ""; });
  }
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

// The popup always runs the freshly loaded extension, but an open calendar tab
// keeps the engine it was loaded with until the tab itself is reloaded. Show
// both, so a stale tab is caught before midnight rather than after.
function renderEngine(engine) {
  var mine = chrome.runtime.getManifest().version;
  var e = el("engine");
  var ok = !!(engine && engine.version === mine);
  e.className = "engine " + (ok ? "ok" : "warn");
  e.textContent = ok
    ? "Вкладка календаря: v" + engine.version + " ✓"
    : "Вкладка календаря не на v" + mine + (engine && engine.version ? " (там v" + engine.version + ")" : "") +
      " — открой или перезагрузи её";
}

async function restore() {
  var st = await get(["cfg", "state", "status", "profiles", "activeProfileId", "engine"]);
  var cfg = st.cfg || {};
  renderEngine(st.engine);
  el("calendarUrl").value = DEFAULT_URL;
  writeMode(cfg.mode);
  applyModeVisibility();
  writeDate(cfg.targetDate);
  if (cfg.targetTime) el("targetTime").value = cfg.targetTime;

  var sec = cfg.second;
  el("secondOn").checked = !!(sec && sec.time);
  if (sec && sec.time) el("secondTime").value = sec.time;
  applySecondVisibility();

  profiles = Array.isArray(st.profiles) ? st.profiles : [];
  activeProfileId = st.activeProfileId;
  var migrated = false;
  if (!profiles.length) {
    // First run with profiles: adopt whatever is already in cfg as profile #1.
    var p0 = blankProfile();
    INFO.forEach(function (id) { if (cfg[id] != null) p0[id] = cfg[id]; });
    profiles = [p0];
    migrated = true;
  }
  if (!activeProfile()) { activeProfileId = profiles[0].id; migrated = true; }
  renderProfileSelect();
  if (sec && sec.profileId && profileById(sec.profileId)) el("secondProfile").value = sec.profileId;
  renderSecondPreview();
  fillInfoInputs(activeProfile());
  if (migrated) await saveProfiles();
  // cfg stays the booking source of truth — re-sync it if it diverged.
  var ap = activeProfile();
  // Also drops the retired autoBook setting (the UI mode always presses Book)
  // — but never while armed, where a cfg write restarts the run.
  var legacy = ("autoBook" in cfg) && st.state !== "armed";
  if (legacy || INFO.some(function (id) { return (cfg[id] || "") !== (ap[id] || ""); })) await saveCfg();
  chrome.storage.local.remove("armedOffAfterBook");   // retired UI-booking flag

  applyToggle(st.state || "idle");
  applyStatus(st.status, st.state || "idle");
  log("popup opened: state=" + (st.state || "idle"),
      "profiles=" + profiles.length,
      "status=" + (st.status ? st.status.text : "—"));
}

async function saveCfg() {
  var cfg = readForm();
  log("cfg saved:", "mode=" + cfg.mode, "date=" + cfg.targetDate, "slot1=" + cfg.targetTime + " <" + cfg.email + "> кв." + cfg.flat,
      cfg.second ? "slot2=" + cfg.second.time + " <" + cfg.second.email + "> кв." + cfg.second.flat : "slot2=off");
  await set({ cfg: cfg });
}

// Returns an error string, or "" when the config can be armed.
function cfgProblem(cfg) {
  if (!cfg.targetDate || !cfg.targetTime) return "Заполни дату и время.";
  // An empty name/email books a blank form, so require both here rather than
  // finding out at midnight.
  if (!cfg.firstName || !cfg.email) return "Заполни имя и email для первой брони.";
  if (cfg.second) {
    if (cfg.second.time === cfg.targetTime) return "Второй слот должен быть на другое время.";
    if (!cfg.second.firstName || !cfg.second.email) return "У профиля второй брони нет имени или email.";
  }
  return "";
}

// Not an error — the court has accepted two slots on one email before — but
// worth one confirmation, since it is usually an unchanged default.
function confirmIfSameIdentity(cfg) {
  if (!cfg.second || cfg.second.email !== cfg.email) return true;
  return confirm("Обе брони на один профиль (" + cfg.email + "). Продолжить?");
}

async function toggle() {
  var st = await get(["state"]);
  var on = (st.state === "armed" || st.state === "grab");
  if (on) {
    log("DISARM requested (state was " + st.state + ")");
    await set({ state: "idle", status: { text: "Выключено", level: "info" } });
  } else {
    var cfg = readForm();
    var bad = cfgProblem(cfg);
    if (bad) { log("ARM rejected:", bad); alert(bad); return; }
    if (!confirmIfSameIdentity(cfg)) { log("ARM cancelled at the same-identity confirmation"); return; }
    log("ARM requested (" + cfg.mode + "):", cfg.targetDate, cfg.targetTime + (cfg.second ? " + " + cfg.second.time : ""));
    await set({ cfg: cfg, state: "armed", status: { text: "Ожидание слота…", level: "info" } });
  }
}

async function bookNow() {
  var cfg = readForm();
  var problem = cfgProblem(cfg);
  if (problem) { log("bookNow rejected:", problem); alert(problem); return; }
  log("BOOK NOW requested:", cfg.targetDate, cfg.targetTime + (cfg.second ? " + " + cfg.second.time : ""));
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
  el("ver").textContent = "v" + chrome.runtime.getManifest().version;
  buildDateSelects();
  restore();
  // Autosave: selects/checkbox on change, text inputs on every keystroke.
  ["dd", "mm", "yyyy", "targetTime", "secondTime", "secondProfile"].forEach(function (id) {
    el(id).addEventListener("change", saveCfg);
  });
  el("secondOn").addEventListener("change", function () {
    log("second booking " + (el("secondOn").checked ? "ENABLED" : "disabled"));
    applySecondVisibility();
    saveCfg();
  });
  document.querySelectorAll('input[name="mode"]').forEach(function (r) {
    r.addEventListener("change", function () {
      log("booking mode -> " + readMode());
      applyModeVisibility();
      saveCfg();
    });
  });
  el("secondProfile").addEventListener("change", renderSecondPreview);
  INFO.forEach(function (id) {
    el(id).addEventListener("input", onInfoEdit);
    el(id).addEventListener("change", onInfoEdit);
  });
  el("profileSelect").addEventListener("change", switchProfile);
  el("profileAdd").addEventListener("click", addProfile);
  el("profileDel").addEventListener("click", deleteProfile);
  el("openCal").addEventListener("click", openCalendar);
  el("toggle").addEventListener("click", toggle);
  el("bookNow").addEventListener("click", bookNow);
}

// Run now if the DOM is already parsed, otherwise wait for it.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local") return;
  if (changes.status && changes.status.newValue) {
    var s = changes.status.newValue;
    log("status[" + (s.level || "info") + "]", s.text);
  }
  if (changes.state) log("state ->", changes.state.newValue);
  if (changes.engine) renderEngine(changes.engine.newValue);
  get(["state", "status"]).then(function (st) {
    applyToggle(st.state || "idle");
    applyStatus(st.status, st.state || "idle");
  });
});
