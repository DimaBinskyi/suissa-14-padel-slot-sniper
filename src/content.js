// content.js — ISOLATED world orchestrator (FAST MODE, no page reload).
//
// States (persisted in chrome.storage.local under "state"):
//   idle  -> do nothing
//   armed -> two independent workers:
//            * replay radar: re-send the captured ListAvailableSlots request
//              every ~300ms and check each response for the EXACT target slot
//              (no DOM involved, so detection latency ≈ one server roundtrip);
//            * view parker: the day strip renders the selected day + the next
//              6 days, so we park once on the latest available date at/before
//              the target and never switch days — the target's column is
//              already on screen when its slots appear, and the grab clicks
//              them right in the strip. Every ~35s the parker forces one
//              app-initiated fetch so the replay template's time-bound
//              credentials (SAPISIDHASH) stay fresh.
//            Detection is event-driven: every availability response (the app's
//            own or a replayed one) is checked the moment it arrives.
//   grab  -> run the booking grab right now (used by "Забронировать сейчас").
//
// Why no reload: reloading costs ~3-5s of SPA boot. We learn "the slot exists"
// from the intercepted/replayed request (not from waiting on render), then
// click the slot with retries — the HTML may lag the response.
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
  var onSlotsBody = null;    // armed-mode hook: called with EVERY availability body on arrival

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
      if (onSlotsBody) onSlotsBody(d.body || "");
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
    await sleep(250);
    clickByText(["Discard", "Descartar", "Отменить изменения"]); // "discard unsaved changes" confirm
    await sleep(200);
    if (!dialogEl()) return;
    // A stuck dialog blocks every later click (parking, slot buttons), so fall
    // back to Escape rather than leaving the page unusable.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
    await sleep(250);
    clickByText(["Discard", "Descartar", "Отменить изменения"]);
    await sleep(200);
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

  // ---------- view parking (keep target slots on screen, no window jumping) ----------
  // The day strip shows the selected day PLUS the next 6 days, so the target's
  // column is visible while we stand on an earlier day. We park once on the
  // latest available date at/before the target and leave the view alone: when
  // the target's slots open, they render right in the visible strip — no day
  // switching needed at all. forceRefetch() runs rarely — its only job is to
  // trigger one app-initiated call so inject.js re-captures the template with
  // fresh time-bound credentials.
  var parkedYmd = 0;
  var maintenanceAsap = false;

  // Available dates ordered by anchoring preference: dates at/before the
  // target from latest to earliest (each keeps the target inside the 7-day
  // strip), then dates after the target from earliest to latest.
  function anchorCells(td) {
    var tn = +ymd(td);
    var avs = availableDateCells();
    avs.sort(function (a, b) {
      var ab = a.ymd <= tn, bb = b.ymd <= tn;
      if (ab !== bb) return ab ? -1 : 1;
      return ab ? (b.ymd - a.ymd) : (a.ymd - b.ymd);
    });
    return avs;
  }

  async function parkView(td) {
    var avs = anchorCells(td);
    if (!avs.length) {
      // Nothing bookable in view yet — bounce the month so the app refetches the range.
      var nm = navButton(/next month/i), pm = navButton(/previous month/i);
      if (nm) { nm.click(); await sleep(450); }
      if (pm) { pm.click(); await sleep(450); }
      parkedYmd = 0;
      return;
    }
    if (avs[0].ymd !== parkedYmd) {
      avs[0].btn.click();
      parkedYmd = avs[0].ymd;
    }
  }

  // Trigger one app-initiated ListAvailableSlots (re-selecting the parked day
  // may be served from the SPA cache, so select something else), then restore
  // the parked view. The alternate pick is the next-best anchor, so the target
  // column stays inside the strip even mid-refetch.
  //
  // abort() is checked before every click: the grab path watches for the slot
  // button while this runs, and once the button renders we must stop clicking
  // dates — a further re-render would detach the element we're about to click.
  async function forceRefetch(td, abort) {
    function stopped() { return !!(abort && abort()); }
    var avs = anchorCells(td);
    if (!avs.length) { await parkView(td); return; }
    if (avs.length > 1) {
      if (stopped()) return;
      avs[1].btn.click();
      parkedYmd = 0;              // aborting below must leave the view re-parkable
      await sleep(500);
    } else {
      var nd = navButton(/next day/i), pd = navButton(/previous day/i);
      if (nd && !stopped()) { nd.click(); await sleep(300); }
      var pd2 = navButton(/previous day/i) || pd;
      if (pd2 && !stopped()) { pd2.click(); await sleep(300); }
    }
    if (stopped()) return;
    avs[0].btn.click();
    parkedYmd = avs[0].ymd;
  }

  // Open a booking modal once on any available slot and immediately discard it.
  // First-open cost (lazy modal bundle + reCAPTCHA init) is ~0.5s; paying it
  // while idle means the real grab clicks into an already-warm dialog.
  async function prewarmModal(myGen, alive) {
    if (dialogEl()) return;
    var all = slotButtonsAll();
    if (!all.length) return;
    all[0].click();
    var f = await waitFor(formIsOpen, 4000, 60);
    if (!live(myGen) || !alive()) return;
    if (f) log("booking modal prewarmed");
    await closeModal();
  }

  // ---------- run control ----------
  // Every start captures runGen; any state change bumps runGen, so a running
  // loop bails at its next checkpoint. This makes "Выключить" stop instantly.
  var runGen = 0;
  function live(myGen) { return myGen === runGen; }

  // ---------- polling (armed) ----------
  var REPLAY_MS = 300;         // replay radar cadence (~3 req/s — fast but not abusive)
  var MAINTENANCE_MS = 35000;  // how often to force an app fetch (template freshness)

  async function startPolling(myGen) {
    var st = await get([CFG_KEY]);
    if (!live(myGen)) return;
    var cfg = st[CFG_KEY] || {};
    var td = parseTargetDate(cfg.targetDate);
    var timeMin = hhmmToMinutes(cfg.targetTime);
    if (!td || timeMin < 0) { setStatus("Заполни дату и время в popup", "error"); return; }

    setStatus("Жду открытия слота " + cfg.targetDate + " " + cfg.targetTime + " (радар " + REPLAY_MS + "мс)…");

    var grabbed = false;
    // Detection MUST be time-specific: look for the EXACT slot's epoch in the
    // response. A day-level "date is available" check falsely fires when the
    // day already has OTHER times open (e.g. 8:30/2:30 exist but 1:00pm doesn't).
    function tryDetect(bodies) {
      if (grabbed || !live(myGen)) return false;
      if (!bodiesContainTarget(bodies, td, timeMin)) return false;
      grabbed = true;
      onSlotsBody = null;
      log("target slot detected in ListAvailableSlots response");
      grab(td, timeMin, cfg, myGen);
      return true;
    }
    // Event-driven path: every availability response (the app's own or a
    // replayed one) is checked the moment it arrives, not once per loop turn.
    onSlotsBody = function (body) { tryDetect([body]); };

    // View parker: anchor the strip so the target's column stays on screen.
    (async function parker() {
      var notGrabbed = function () { return !grabbed; };
      var abortOnGrab = function () { return grabbed || !live(myGen); };
      await ensureMonth(td); if (!live(myGen) || grabbed) return;
      await parkView(td); if (!live(myGen) || grabbed) return;
      // Warm the modal now, while nothing is at stake — see prewarmModal().
      await prewarmModal(myGen, notGrabbed); if (!live(myGen) || grabbed) return;
      parkedYmd = 0;                        // the prewarm click moved the view
      var nextMaint = Date.now() + MAINTENANCE_MS;
      while (live(myGen) && !grabbed) {
        // Any dialog left open (prewarm, a stray click) would swallow the
        // clicks below and the slot click when the moment comes.
        if (dialogEl()) { await closeModal(); if (!live(myGen) || grabbed) return; }
        await ensureMonth(td); if (!live(myGen) || grabbed) return;
        if (maintenanceAsap || Date.now() >= nextMaint) {
          maintenanceAsap = false;
          nextMaint = Date.now() + MAINTENANCE_MS;
          await forceRefetch(td, abortOnGrab);
        } else {
          await parkView(td);
        }
        await sleep(1000);
      }
    })();

    // Replay radar: ask the server directly, no DOM involved.
    var fails = 0;
    while (live(myGen) && !grabbed) {
      var t0 = Date.now();
      var rep = await replayOnce(2000);
      if (!live(myGen) || grabbed) return;
      if (tryDetect([rep && rep.body, lastAppSlots.body])) return;
      if (rep && rep.status === 200) {
        fails = 0;
      } else if (++fails >= 6) {
        // ~2s of dead replays: template missing or credentials stale — have
        // the parker force an app fetch right away to re-capture it.
        fails = 0;
        maintenanceAsap = true;
        setStatus("Радар без ответа — обновляю шаблон запроса…", "warn");
      }
      var wait = REPLAY_MS - (Date.now() - t0);
      if (wait > 0) { await sleep(wait); if (!live(myGen) || grabbed) return; }
    }
  }

  // ---------- grab (book on the same page, retry through render lag) ----------
  // The modal header reads e.g. "Wednesday, July 8, 4:00 – 5:30pm". Once ANY
  // month name is rendered we can decide target-vs-neighbour immediately
  // instead of waiting out a fixed grace period.
  function modalDateRendered() {
    var d = dialogEl();
    if (!d) return false;
    var t = d.textContent || "";
    for (var i = 0; i < MONTHS.length; i++) if (t.indexOf(MONTHS[i]) !== -1) return true;
    return false;
  }
  // Fill each field the moment it exists rather than waiting for the whole
  // form: Google renders the name/email/notes inputs in stages.
  async function fillForm(cfg) {
    var start = Date.now();
    var end = start + 1500;
    var did = { first: false, last: false, mail: false, note: false };
    while (Date.now() < end) {
      var f = formInputs();
      if (!did.first && f.texts[0]) { setNativeValue(f.texts[0], cfg.firstName || ""); did.first = true; }
      if (!did.last && f.texts[1]) { setNativeValue(f.texts[1], cfg.lastName || ""); did.last = true; }
      if (!did.mail && f.emails[0]) { setNativeValue(f.emails[0], cfg.email || ""); did.mail = true; }
      if (!did.note && f.areas[0]) { setNativeValue(f.areas[0], cfg.flat || ""); did.note = true; }
      if (did.first && did.last && did.mail && did.note) return true;
      // Last name / notes may simply not exist on this form. Only accept that
      // after a grace period, or a late-rendering field would go unfilled.
      if (did.first && did.mail && bookButton() && Date.now() - start > 400) return true;
      await sleep(40);
    }
    return did.first && did.mail;
  }

  async function grab(td, timeMin, cfg, myGen) {
    setStatus("Слот открылся! Бронирую…", "ok");

    // Buttons that already opened a WRONG-day modal. Without this, a same-time
    // slot on a neighbouring day would be clicked again every iteration
    // (open modal -> discard -> re-find the same button) until the deadline.
    // A re-render replaces the elements, so genuinely new buttons still get tried.
    var tried = [];
    function freshCandidates() {
      var c = findSlotButtons(timeMin).filter(function (b) { return tried.indexOf(b) === -1; });
      return c.length ? c : null;   // null (not []) so waitFor keeps polling
    }

    var opened = false;
    var filled = false;
    // An open dialog swallows every click below, so deal with it first. If it
    // already IS the target's, there's nothing to click — go straight to filling.
    if (dialogEl()) {
      if (modalMatchesTarget(td)) {
        opened = true;
        setStatus("Заполняю данные…");
        filled = await fillForm(cfg);
      } else {
        await closeModal();
      }
      if (!live(myGen)) return;
    }
    var deadline = Date.now() + 15000;
    while (Date.now() < deadline && !opened) {
      if (!live(myGen)) return;
      // The parked strip already shows the target's column, so the slot button
      // renders in place — no day selection needed. Check what's on screen, then
      // give the app a brief moment: the radar usually beats the DOM by ~200ms,
      // and catching that render saves a whole refetch.
      var cands = freshCandidates() || (await waitFor(freshCandidates, 200, 40)) || [];
      if (!cands.length && live(myGen)) {
        // Still not rendered: force an app fetch to redraw the strip — but watch
        // for the button WHILE it runs, since the redraw usually lands during
        // the refetch's own pauses. forceRefetch stops clicking once we're set.
        var seen = null;
        var refetching = forceRefetch(td, function () { return !!seen || !live(myGen); })
          .catch(function (e) { log("refetch failed", e); });
        seen = await waitFor(freshCandidates, 1200, 40);
        if (!seen) { await refetching; seen = await waitFor(freshCandidates, 400, 40); }
        cands = seen || [];
      }
      if (!cands.length && live(myGen)) {
        // Nothing at all — the target column may be outside the strip (anchor
        // more than 6 days away). Select the target day itself as a fallback.
        await ensureMonth(td); if (!live(myGen)) return;
        var cell = dateCellButton(ymd(td));
        if (cell && isDateAvailable(cell)) {
          cell.click();                  // select the target day -> its slots render
          cands = (await waitFor(freshCandidates, 1500, 40)) || [];
        }
      }
      if (!live(myGen)) return;
      // Try each same-time button; verify the modal is actually the target day
      // (the multi-day column view can show the same time on a neighbouring day).
      for (var i = 0; i < cands.length; i++) {
        if (!live(myGen)) return;
        cands[i].click();
        if (!(await waitFor(modalDateRendered, 2500, 40))) continue;
        if (!modalMatchesTarget(td)) {    // wrong day -> skip this button from now on
          tried.push(cands[i]);
          await closeModal();
          continue;
        }
        opened = true;
        setStatus("Заполняю данные…");
        filled = await fillForm(cfg);     // starts as soon as the first input exists
        break;
      }
      if (!opened) await sleep(150);
    }

    if (!live(myGen)) return;
    if (!opened) {
      setStatus("Слот не отрисовался вовремя — продолжаю ждать", "warn");
      if ((await get([STATE_KEY]))[STATE_KEY] === "armed" && live(myGen)) startPolling(myGen);
      else await setState("idle");
      return;
    }

    if (!filled) {              // late-rendering inputs: one more pass
      filled = await fillForm(cfg);
      if (!live(myGen)) return;
      if (!filled) { setStatus("Поля формы не заполнились — проверь вкладку", "error"); notify("Padel: заполни форму", "Слот открыт, но поля не заполнились. Открой вкладку.", true); await setState("idle"); return; }
    }

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
