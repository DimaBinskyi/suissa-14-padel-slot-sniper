// content.js — ISOLATED world orchestrator (FAST MODE, no page reload).
//
// States (persisted in chrome.storage.local under "state"):
//   idle  -> do nothing
//   armed -> poll: every ~1.5s click the calendar (nearest available date) so
//            the SPA re-fetches + re-renders WITHOUT a reload; intercept the
//            ListAvailableSlots response (authoritative) + read the grid. When
//            the target slot opens, grab it immediately on the same page.
//   grab  -> run the booking grab right now (used by "Забронировать сейчас").
//
// Why no reload: reloading costs ~3-5s of SPA boot. Instead we drive the app's
// own fetch by clicking a date, learn "the slot exists" from the intercepted
// request (not from waiting on render), then click the slot with retries —
// because the HTML may lag the response and the first click(s) can miss.
(function () {
  "use strict";

  var CFG_KEY = "cfg";
  var STATE_KEY = "state";

  var log = function () {
    var a = ["[padel]"].concat([].slice.call(arguments));
    console.log.apply(console, a);
  };

  // ---------- storage ----------
  function get(keys) { return new Promise(function (res) { chrome.storage.local.get(keys, res); }); }
  function set(obj) { return new Promise(function (res) { chrome.storage.local.set(obj, res); }); }
  function setStatus(text, level) { set({ status: { text: text, level: level || "info", ts: Date.now() } }); log(text); }
  function setState(s) { return set({ state: s }); }

  // ---------- inject bridge ----------
  var slotWaiters = [];      // resolved by REPLAYED responses only
  var bookingWaiters = [];
  var lastAppSlots = { body: "", ts: 0 }; // latest APP-initiated ListAvailableSlots response

  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__padel !== "inject") return;
    if (d.type === "slots") {
      if (d.replayed) {
        var w = slotWaiters; slotWaiters = [];
        w.forEach(function (fn) { fn(d); });
      } else {
        lastAppSlots = { body: d.body || "", ts: Date.now() };
      }
    } else if (d.type === "booking-result") {
      var b = bookingWaiters; bookingWaiters = [];
      b.forEach(function (fn) { fn(d); });
    }
  });

  function toInject(cmd) { window.postMessage({ __padel: "content", cmd: cmd }, "*"); }

  function replayOnce(timeoutMs) {
    return new Promise(function (res) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; res({ body: "", status: 0, timeout: true }); } }, timeoutMs || 5000);
      slotWaiters.push(function (d) { if (!done) { done = true; clearTimeout(t); res(d); } });
      toInject("replay");
    });
  }
  function nextBookingResult(timeoutMs) {
    return new Promise(function (res) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; res(null); } }, timeoutMs || 20000);
      bookingWaiters.push(function (d) { if (!done) { done = true; clearTimeout(t); res(d); } });
    });
  }

  // ---------- time / date ----------
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function slotTextToMinutes(txt) {
    var m = String(txt).trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
    if (!m) return -1;
    var h = parseInt(m[1], 10) % 12;
    if (m[3] === "pm") h += 12;
    return h * 60 + parseInt(m[2], 10);
  }
  function hhmmToMinutes(txt) {
    var m = String(txt).trim().match(/^(\d{1,2}):(\d{2})$/);
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : -1;
  }
  var MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  function parseTargetDate(s) {
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return { y: +m[1], m: +m[2], d: +m[3] };
  }
  function ymd(td) { return "" + td.y + pad(td.m) + pad(td.d); } // "20260710"
  // Candidate epoch strings for the target slot, computed in the COURT's
  // timezone (Europe/Madrid) so it works regardless of the Mac's timezone/DST.
  // ListAvailableSlots encodes slot starts as unix seconds.
  var COURT_TZ = "Europe/Madrid";
  function targetEpochCandidates(td, timeMin) {
    var hh = Math.floor(timeMin / 60), mm = timeMin % 60;
    var want = td.y + "-" + pad(td.m) + "-" + pad(td.d) + " " + pad(hh) + ":" + pad(mm);
    var fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: COURT_TZ, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    });
    var out = [];
    [2, 1].forEach(function (off) { // CEST (+2) then CET (+1)
      var ms = Date.UTC(td.y, td.m - 1, td.d, hh - off, mm, 0, 0);
      var p = {};
      fmt.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
      var got = p.year + "-" + p.month + "-" + p.day + " " + p.hour + ":" + p.minute;
      if (got === want) { out.push(String(ms), String(Math.floor(ms / 1000))); }
    });
    if (!out.length) {
      var ms2 = new Date(td.y, td.m - 1, td.d, hh, mm, 0, 0).getTime();
      out.push(String(ms2), String(Math.floor(ms2 / 1000)));
    }
    return out;
  }
  function bodiesContainTarget(bodies, td, timeMin) {
    var cands = targetEpochCandidates(td, timeMin);
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i]; if (!b) continue;
      for (var j = 0; j < cands.length; j++) if (b.indexOf(cands[j]) !== -1) return true;
    }
    return false;
  }

  // ---------- DOM ----------
  function visible(el) {
    if (!el) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function waitFor(fn, timeoutMs, step) {
    var end = Date.now() + (timeoutMs || 6000);
    return new Promise(function (res) {
      (function tick() {
        var v = fn();
        if (v) return res(v);
        if (Date.now() > end) return res(null);
        setTimeout(tick, step || 150);
      })();
    });
  }
  function navButton(labelRe) {
    var btns = document.querySelectorAll("button[aria-label]");
    for (var i = 0; i < btns.length; i++) if (labelRe.test(btns[i].getAttribute("aria-label"))) return btns[i];
    return null;
  }

  // Date cells keyed by the reliable data-date attribute on the <td>.
  function dateCellButton(ymdStr) {
    var td = document.querySelector('td[data-date="' + ymdStr + '"]');
    return td ? td.querySelector("button[data-grid-cell], button") : null;
  }
  function isDateAvailable(btn) {
    return !!btn && !/no available times/i.test(btn.getAttribute("aria-label") || "");
  }
  function availableDateCells() {
    var out = [];
    var tds = document.querySelectorAll("td[data-date]");
    for (var i = 0; i < tds.length; i++) {
      var btn = tds[i].querySelector("button[data-grid-cell], button");
      if (btn && isDateAvailable(btn)) out.push({ btn: btn, ymd: +tds[i].getAttribute("data-date") });
    }
    return out;
  }
  async function ensureMonth(td) {
    var y = ymd(td);
    if (dateCellButton(y)) return true;
    var tries = 0;
    while (!dateCellButton(y) && tries < 24) {
      var any = document.querySelector("td[data-date]");
      var goNext = true;
      if (any) goNext = (+y >= +any.getAttribute("data-date"));
      var nav = navButton(goNext ? /next month/i : /previous month/i);
      if (!nav) break;
      nav.click();
      await sleep(450);
      tries++;
    }
    return !!dateCellButton(y);
  }

  function slotButtonsAll() {
    var out = [];
    var btns = document.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || "").trim();
      if (/^\d{1,2}:\d{2}(am|pm)$/i.test(t) && visible(btns[i])) out.push(btns[i]);
    }
    return out;
  }
  function findSlotButtons(timeMin) {
    return slotButtonsAll().filter(function (b) { return slotTextToMinutes(b.textContent) === timeMin; });
  }

  function dialogEl() {
    var d = document.querySelector('[role="dialog"]');
    return (d && visible(d)) ? d : null;
  }
  function dialogScope() { return dialogEl() || document; }
  function formInputs() {
    var all = dialogScope().querySelectorAll("input, textarea");
    var texts = [], emails = [], areas = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.name === "g-recaptcha-response" || !visible(el)) continue;
      if (el.tagName === "TEXTAREA") areas.push(el);
      else if (el.type === "email") emails.push(el);
      else if (el.type === "text") texts.push(el);
    }
    return { texts: texts, emails: emails, areas: areas };
  }
  function formIsOpen() {
    var f = formInputs();
    return (f.texts.length >= 1 && f.emails.length >= 1) ? f : null;
  }
  // Guard against booking a neighbouring day: the modal header reads e.g.
  // "Wednesday, July 8, 4:00 – 5:30pm". Require the target month+day to appear.
  function modalMatchesTarget(td) {
    var dlg = dialogEl();
    if (!dlg) return false;
    var txt = (dlg.textContent || "");
    return new RegExp(MONTHS[td.m - 1] + "\\s+" + td.d + "\\b").test(txt);
  }
  function clickByText(labels) {
    var btns = document.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || "").trim();
      if (visible(btns[i]) && labels.indexOf(t) !== -1) { btns[i].click(); return true; }
    }
    return false;
  }
  async function closeModal() {
    clickByText(["Cancel", "Cancelar", "Отмена"]);
    await sleep(350);
    clickByText(["Discard", "Descartar", "Отменить изменения"]); // "discard unsaved changes" confirm
    await sleep(300);
  }
  function bookButton() {
    var btns = dialogScope().querySelectorAll("button");
    var cands = [];
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || "").trim();
      if (visible(btns[i]) && (t === "Book" || t === "Reservar" || t === "Забронировать")) cands.push(btns[i]);
    }
    return cands.length ? cands[cands.length - 1] : null;
  }
  function setNativeValue(el, value) {
    var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function isReallyVisible(el) {
    var e = el;
    while (e && e !== document.body) {
      var cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
      e = e.parentElement;
    }
    var r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 60) return false;
    return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  }
  function captchaVisible() {
    var frames = document.querySelectorAll("iframe");
    for (var i = 0; i < frames.length; i++) {
      var src = frames[i].src || "";
      if (/recaptcha/i.test(src) && /bframe/i.test(src) && isReallyVisible(frames[i])) return true;
    }
    return false;
  }
  function bookingConfirmed() {
    if (formIsOpen()) return false;
    var body = (document.body.textContent || "").toLowerCase();
    return /you'?re booked|booking confirmed|reserva confirmada|has reservado|cita reservada|added to your calendar/.test(body);
  }
  function notify(title, message, sound) {
    try { chrome.runtime.sendMessage({ type: "notify", title: title, message: message, sound: !!sound }); } catch (e) {}
  }

  // ---------- refresh trigger (drive the app's own fetch, no reload) ----------
  var refreshIdx = 0;
  async function triggerAppFetch(td) {
    var tn = +ymd(td);
    var avs = availableDateCells();
    if (!avs.length) {
      // Nothing bookable in view yet — bounce the month so the app refetches the range.
      var nm = navButton(/next month/i), pm = navButton(/previous month/i);
      if (nm) { nm.click(); await sleep(450); }
      if (pm) { pm.click(); await sleep(450); }
      return;
    }
    avs.sort(function (a, b) { return Math.abs(a.ymd - tn) - Math.abs(b.ymd - tn); });
    // Alternate between the two nearest available dates to bust the SPA cache
    // (re-selecting the same day may not refetch).
    var pick = avs[avs.length > 1 ? (refreshIdx++ % 2) : 0];
    pick.btn.click();
    if (avs.length === 1) {
      // Only one clickable day: nudge the day-window to force a fresh fetch.
      var nd = navButton(/next day/i), pd = navButton(/previous day/i);
      if (nd) { nd.click(); await sleep(250); }
      if (pd) { pd.click(); await sleep(250); }
    }
  }

  // ---------- run control ----------
  // Every start captures runGen; any state change bumps runGen, so a running
  // loop bails at its next checkpoint. This makes "Выключить" stop instantly.
  var runGen = 0;
  function live(myGen) { return myGen === runGen; }

  // ---------- polling (armed) ----------
  async function startPolling(myGen) {
    var st = await get([CFG_KEY]);
    if (!live(myGen)) return;
    var cfg = st[CFG_KEY] || {};
    var td = parseTargetDate(cfg.targetDate);
    var timeMin = hhmmToMinutes(cfg.targetTime);
    if (!td || timeMin < 0) { setStatus("Заполни дату и время в popup", "error"); return; }

    setStatus("Жду открытия слота " + cfg.targetDate + " " + cfg.targetTime + " (быстрый режим)…");

    while (live(myGen)) {
      await ensureMonth(td); if (!live(myGen)) return;
      await triggerAppFetch(td); if (!live(myGen)) return;   // click calendar -> app fetches + renders
      await sleep(450); if (!live(myGen)) return;

      var rep = await replayOnce(2500); if (!live(myGen)) return;
      // Detection MUST be time-specific: look for the EXACT slot's epoch in the
      // response. A day-level "date is available" check falsely fires when the
      // day already has OTHER times open (e.g. 8:30/2:30 exist but 1:00pm doesn't).
      if (bodiesContainTarget([lastAppSlots.body, rep && rep.body], td, timeMin)) {
        log("target slot detected in ListAvailableSlots response");
        await grab(td, timeMin, cfg, myGen);
        return;
      }
      await sleep(150); // fixed ~1s cadence
    }
  }

  // ---------- grab (book on the same page, retry through render lag) ----------
  async function grab(td, timeMin, cfg, myGen) {
    setStatus("Слот открылся! Бронирую…", "ok");

    var opened = false;
    var deadline = Date.now() + 15000;
    while (Date.now() < deadline && !opened) {
      if (!live(myGen)) return;
      await ensureMonth(td); if (!live(myGen)) return;
      var cell = dateCellButton(ymd(td));
      if (cell && isDateAvailable(cell)) {
        cell.click();                    // select the target day -> its slots render
        await sleep(450);
      } else {
        await triggerAppFetch(td);       // force the app to fetch so the target opens
        await sleep(650);
        continue;
      }
      if (!live(myGen)) return;
      // Try each same-time button; verify the modal is actually the target day
      // (the multi-day column view can show the same time on a neighbouring day).
      var cands = findSlotButtons(timeMin);
      for (var i = 0; i < cands.length; i++) {
        if (!live(myGen)) return;
        cands[i].click();
        var f = await waitFor(formIsOpen, 3000);
        if (f && modalMatchesTarget(td)) { opened = true; break; }
        if (f) { await closeModal(); }   // wrong day -> discard and try the next
      }
      if (!opened) await sleep(400);
    }

    if (!live(myGen)) return;
    if (!opened) {
      setStatus("Слот не отрисовался вовремя — продолжаю ждать", "warn");
      if ((await get([STATE_KEY]))[STATE_KEY] === "armed" && live(myGen)) startPolling(myGen);
      else await setState("idle");
      return;
    }

    setStatus("Заполняю данные…");
    var form = formIsOpen();
    if (form.texts[0]) setNativeValue(form.texts[0], cfg.firstName || "");
    if (form.texts[1]) setNativeValue(form.texts[1], cfg.lastName || "");
    if (form.emails[0]) setNativeValue(form.emails[0], cfg.email || "");
    if (form.areas[0]) setNativeValue(form.areas[0], cfg.flat || "");
    await sleep(350);
    if (!live(myGen)) return;   // let "Выключить" cancel before we click Book

    if (!cfg.autoBook) {
      setStatus("Форма готова — нажми Book вручную", "warn");
      notify("Padel: форма готова", "Слот " + cfg.targetTime + " заполнен. Нажми Book.", true);
      await setState("idle");
      return;
    }

    var book = bookButton();
    if (!book) { setStatus("Кнопка Book не найдена — стоп", "error"); await setState("idle"); return; }

    setStatus("Жму Book…");
    var resultP = nextBookingResult(20000);
    book.click();

    var outcome = await Promise.race([
      resultP.then(function (r) { return { kind: "rpc", data: r }; }),
      waitFor(captchaVisible, 20000, 300).then(function (v) { return v ? { kind: "captcha" } : null; }),
      waitFor(bookingConfirmed, 20000, 400).then(function (v) { return v ? { kind: "confirmed" } : null; })
    ]);
    if (!outcome || (outcome.kind === "rpc" && outcome.data && outcome.data.status !== 200)) {
      if (captchaVisible()) outcome = { kind: "captcha" };
    }

    if (outcome && outcome.kind === "captcha") {
      setStatus("КАПЧА — нужен ты. Открой вкладку и добей вручную", "error");
      notify("⚠️ Padel: капча!", "Автобронь остановлена. Открой вкладку календаря и реши капчу вручную.", true);
      await setState("idle");
      return;
    }
    var ok = (outcome && outcome.kind === "confirmed") ||
             (outcome && outcome.kind === "rpc" && outcome.data && outcome.data.status === 200);
    if (ok) {
      setStatus("✅ Слот " + cfg.targetTime + " забронирован!", "ok");
      notify("✅ Padel забронирован", "Слот " + cfg.targetDate + " " + cfg.targetTime + " успешно занят.", true);
      await setState("idle");
    } else {
      setStatus("Не удалось подтвердить бронь — проверь вкладку", "error");
      notify("Padel: проверь бронь", "Не удалось автоматически подтвердить результат. Открой вкладку.", true);
      await setState("idle");
    }
  }

  async function grabNow(myGen) {
    var st = await get([CFG_KEY]);
    if (!live(myGen)) return;
    var cfg = st[CFG_KEY] || {};
    var td = parseTargetDate(cfg.targetDate);
    var timeMin = hhmmToMinutes(cfg.targetTime);
    if (!td || timeMin < 0) { setStatus("Заполни дату и время в popup", "error"); await setState("idle"); return; }
    await grab(td, timeMin, cfg, myGen);
  }

  // ---------- lifecycle ----------
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local" || !changes[STATE_KEY]) return;
    var s = changes[STATE_KEY].newValue;
    runGen++;                    // bump => any running poll/grab loop bails at once
    if (s === "armed") startPolling(runGen);
    else if (s === "grab") grabNow(runGen);
    // idle: nothing to start; the runGen bump already halted the loop.
  });

  async function boot() {
    var st = await get([STATE_KEY]);
    var s = st[STATE_KEY] || "idle";
    log("boot, state =", s);
    runGen++;
    if (s === "armed") startPolling(runGen);
    else if (s === "grab") grabNow(runGen);
  }

  boot();
})();
