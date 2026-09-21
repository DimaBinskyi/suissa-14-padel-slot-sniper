// content.js — ISOLATED world orchestrator (FAST MODE, no page reload).
//
// States (persisted in chrome.storage.local under "state"):
//   idle  -> do nothing
//   armed -> on the rollover night, a third worker joins the two below: the
//            DIRECT SHOT (see prepareDirectBooking) captures the page's own
//            booking request (with its fresh reCAPTCHA token) ~75s before
//            server-corrected midnight, retargets it to the wanted slot, and
//            fires it ~120ms after the rollover — one RTT instead of the ~0.5s
//            UI path. The UI grab runs independently in parallel.
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
  var captureWaiters = [];   // resolved when inject captures a booking template
  var suppressWaiters = [];  // resolved when inject acks suppress-booking-on
  var preparedWaiters = [];  // resolved when inject finishes prepare-direct
  var directWaiters = [];    // resolved by a direct-book result
  var lastAppSlots = { body: "", ts: 0 }; // latest APP-initiated ListAvailableSlots response
  var onSlotsBody = null;    // armed-mode hook: called with EVERY availability body on arrival

  function flushWaiters(list, d) {
    var w = list.slice();
    list.length = 0;
    w.forEach(function (fn) { fn(d); });
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__padel !== "inject") return;
    if (d.type === "slots") {
      if (d.replayed) {
        if (d.dateHeader) noteClockSample(d.dateHeader, d.tSent, d.tRecv);
        flushWaiters(slotWaiters, d);
      } else {
        lastAppSlots = { body: d.body || "", ts: Date.now() };
      }
      if (onSlotsBody) onSlotsBody(d.body || "");
    } else if (d.type === "booking-result") {
      flushWaiters(bookingWaiters, d);
    } else if (d.type === "booking-captured") {
      flushWaiters(captureWaiters, d);
    } else if (d.type === "suppress-ack") {
      flushWaiters(suppressWaiters, d);
    } else if (d.type === "direct-prepared") {
      flushWaiters(preparedWaiters, d);
    } else if (d.type === "direct-book-result") {
      flushWaiters(directWaiters, d);
    }
  });

  function toInject(msg) {
    if (typeof msg === "string") msg = { cmd: msg };
    msg.__padel = "content";
    window.postMessage(msg, "*");
  }

  // Wait for the next message flushed into `list`; optionally fire the request
  // that should produce it. Resolves null on timeout.
  function awaitMsg(list, timeoutMs, sendFn) {
    return new Promise(function (res) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; res(null); } }, timeoutMs);
      list.push(function (d) { if (!done) { done = true; clearTimeout(t); res(d); } });
      if (sendFn) sendFn();
    });
  }

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
  // The booking window rolls over at midnight in the COURT's timezone, and that
  // is when the new day's slots appear. Knowing how far off that is lets us keep
  // the calendar hot right before it — see the turbo window in startPolling().
  function msUntilCourtMidnight() {
    var fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: COURT_TZ, hour12: false,
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
    var p = {};
    fmt.formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
    var secs = ((+p.hour) % 24) * 3600 + (+p.minute) * 60 + (+p.second);
    return (86400 - secs) * 1000;
  }
  // ---------- server clock sync ----------
  // The rollover happens on GOOGLE's clock, not this machine's. Every replayed
  // availability response carries a Date header; an NTP-style estimate against
  // the request's midpoint (header second + 500ms to undo truncation) gives
  // offset = serverNow - localNow, good to a few hundred ms — enough to
  // SCHEDULE the midnight shot instead of discovering the rollover by polling.
  var clockOffsets = [];
  function noteClockSample(dateHeader, tSent, tRecv) {
    var s = Date.parse(dateHeader || "");
    if (!s || !tSent || !tRecv) return;
    var rtt = tRecv - tSent;
    if (rtt < 0 || rtt > 2000) return; // stalled request — poisoned sample
    clockOffsets.push((s + 500) - (tSent + tRecv) / 2);
    if (clockOffsets.length > 15) clockOffsets.shift();
  }
  function clockOffset() {
    if (!clockOffsets.length) return 0;
    var a = clockOffsets.slice().sort(function (x, y) { return x - y; });
    return a[Math.floor(a.length / 2)];
  }
  // msUntilCourtMidnight truncates to the second; add the local sub-second part
  // back (tz offsets are whole minutes, so second boundaries coincide) and
  // shift by the server offset.
  function msUntilCourtMidnightCorrected() {
    return msUntilCourtMidnight() - (Date.now() % 1000) - clockOffset();
  }
  // Court-timezone date `days` ahead as "YYYYMMDD". The upcoming midnight
  // rollover opens courtYmdPlus(2): entering day X+1 reveals day X+2.
  function courtYmdPlus(days) {
    var fmt = new Intl.DateTimeFormat("en-GB", { timeZone: COURT_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
    var p = {};
    fmt.formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
    var dt = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + days));
    return "" + dt.getUTCFullYear() + pad(dt.getUTCMonth() + 1) + pad(dt.getUTCDate());
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
  // "Wednesday, July 8, 4:00 – 5:30pm" -> {y,m,d}. The header has no year, but
  // bookable dates are never more than a couple of days out, so pick the year
  // that puts the date near today.
  function parseModalDate() {
    var dlg = dialogEl();
    if (!dlg) return null;
    var m = (dlg.textContent || "").match(new RegExp("(" + MONTHS.join("|") + ")\\s+(\\d{1,2})\\b"));
    if (!m) return null;
    var mo = MONTHS.indexOf(m[1]) + 1, day = +m[2], y = new Date().getFullYear();
    var diff = new Date(y, mo - 1, day).getTime() - Date.now();
    if (diff < -45 * 86400000) y++;
    if (diff > 320 * 86400000) y--;
    return { y: y, m: mo, d: day };
  }
  // Booking raced and lost: Google swaps the modal to a "time is no longer
  // available" notice. Spotting it beats waiting out the 20s result race.
  function slotTakenText() {
    var scope = dialogEl() || document.body;
    return /no longer available|not available anymore|ya no está disponible/i.test(scope.textContent || "");
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

  // One click that is guaranteed to change the app's selected day, so it must
  // refetch and re-render. Alternates target <-> anchor: re-selecting the same
  // day can be served from the SPA's cache and render nothing.
  var pokeIdx = 0;
  function pokeApp(td) {
    var cells = [];
    var t = dateCellButton(ymd(td));
    // Ungated on purpose (same reasoning as in grab): before the rollover the
    // target still reads "no available times", and that is exactly the day we
    // need the app to be looking at when the slots land.
    if (t && !t.disabled && t.getAttribute("aria-disabled") !== "true") cells.push(t);
    var avs = anchorCells(td);
    for (var i = 0; i < avs.length && cells.length < 3; i++) {
      if (avs[i].btn !== t) cells.push(avs[i].btn);
    }
    if (!cells.length) return false;
    cells[pokeIdx++ % cells.length].click();
    parkedYmd = 0;                  // the view moved; parkView() must re-anchor
    return true;
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
  // Turbo window around the court's midnight rollover. Our replay tells US the
  // slot exists but leaves the app's own state untouched, so the page still has
  // to be nudged into redrawing — ~0.5-1s we'd rather not spend after detection.
  // Instead, for a short window we keep poking the app so IT fetches and renders
  // the new day by itself; by the time the radar fires, the button is on screen.
  // The radar halves its rate meanwhile — the app's own responses feed the same
  // detector, so total request volume stays where it was.
  var TURBO_LEAD_MS = 25000;   // start before midnight
  var TURBO_TAIL_MS = 60000;   // keep going after it
  var TURBO_POKE_MS = 600;     // how often to make the app refetch
  var TURBO_REPLAY_MS = 600;   // radar cadence while turbo is poking
  // Direct shot: build the booking request this early (the reCAPTCHA token
  // inside lives ~120s, so don't raise past ~90s), fire it this long after
  // corrected midnight (cushion for residual clock error — too early and the
  // server rejects it AND the single-use token is spent).
  var DIRECT_PREP_LEAD_MS = 75000;
  var DIRECT_SEND_DELAY_MS = 120;
  function inTurboWindow() {
    var left = msUntilCourtMidnightCorrected();
    return left <= TURBO_LEAD_MS || left >= 86400000 - TURBO_TAIL_MS;
  }

  // ---------- direct shot ----------
  // The UI grab costs ~0.5s after the rollover (detect -> render -> click ->
  // fill -> Book) — and yesterday that lost the race. The direct shot removes
  // all of it: shortly before midnight we let the page build a COMPLETE booking
  // request for a sacrificial already-open slot (real form data, real Book
  // click, so the page mints its own reCAPTCHA token), swallow it before it
  // reaches the network, rewrite the slot epochs to the target, and fire it at
  // corrected midnight — the booking arrives one RTT after the rollover. The
  // UI grab runs fully INDEPENDENTLY in parallel: neither path waits on the
  // other. If both land, the worst case is a duplicate booking to cancel by
  // hand — losing the slot costs more than an extra cancellation.
  //
  // Set when the direct shot booked the slot; the UI grab uses it only to
  // label its own outcome correctly (our own booking is not a rival's).
  var directWon = false;

  async function prepareDirectBooking(td, timeMin, cfg, myGen, isGrabbed) {
    try {
      setStatus("Готовлю прямой запрос (шаблон + токен)…");
      if (dialogEl()) { await closeModal(); if (!live(myGen) || isGrabbed()) return false; }
      var all = slotButtonsAll();
      if (!all.length) { log("direct prep: no slot buttons on screen"); return false; }
      var btn = all[0];
      var btnMin = slotTextToMinutes(btn.textContent);
      btn.click();
      if (!(await waitFor(formIsOpen, 4000, 60)) || !(await waitFor(modalDateRendered, 3000, 50))) {
        log("direct prep: sacrificial modal did not open");
        await closeModal();
        return false;
      }
      if (!live(myGen) || isGrabbed()) { await closeModal(); return false; }
      var pd = parseModalDate();
      if (!pd || btnMin < 0) { log("direct prep: could not read sacrificial date/time"); await closeModal(); return false; }
      var pCand = targetEpochCandidates(pd, btnMin);
      var tCand = targetEpochCandidates(td, timeMin);
      var pMs = parseInt(pCand[0], 10), tMs = parseInt(tCand[0], 10);
      if (!pMs || !tMs || pMs === tMs) { log("direct prep: bad epochs", pMs, tMs); await closeModal(); return false; }
      if (!(await fillForm(cfg))) { log("direct prep: form did not fill"); await closeModal(); return false; }
      if (!live(myGen) || isGrabbed()) { await closeModal(); return false; }
      // Arm the swallow and WAIT for the ack: the Book click below can reach
      // xhr.send synchronously, before an unacked postMessage would arrive —
      // and then the sacrificial slot would get booked for real.
      var ack = await awaitMsg(suppressWaiters, 1500, function () {
        toInject({ cmd: "suppress-booking-on", needle: cfg.email || "" });
      });
      if (!ack) { log("direct prep: no suppress ack"); await closeModal(); return false; }
      var book = bookButton();
      if (!book) { log("direct prep: no Book button"); await closeModal(); return false; }
      var capP = awaitMsg(captureWaiters, 6000);
      book.click();
      var cap = await capP;
      if ((!cap || !cap.ok) && captchaVisible()) {
        // A challenge fired on the warm-up click. The human can still save the
        // night: solving it makes the page finish building the request, which
        // we capture as usual. Keep the swallow alive while they solve.
        toInject({ cmd: "suppress-extend", ttl: 60000 });
        setStatus("Капча на прогреве! Реши её — токен нужен до полуночи", "error");
        notify("⚠️ Padel: капча на прогреве", "Реши капчу в открытой вкладке календаря — прямой запрос ждёт токен.", true);
        cap = await awaitMsg(captureWaiters, 45000);
      }
      await closeModal();
      if (!cap || !cap.ok) { log("direct prep: booking request was not captured"); return false; }
      var DUR = 5400000; // every court slot is 90 min
      var repl = [
        [String(pMs), String(tMs)],
        [String(pMs + DUR), String(tMs + DUR)],
        [String(Math.floor(pMs / 1000)), String(Math.floor(tMs / 1000))],
        [String(Math.floor((pMs + DUR) / 1000)), String(Math.floor((tMs + DUR) / 1000))],
        [ymd(pd), ymd(td)]
      ];
      var prep = await awaitMsg(preparedWaiters, 3000, function () {
        toInject({ cmd: "prepare-direct", repl: repl });
      });
      if (!prep || !prep.ok) { log("direct prep: epoch rewrite failed", prep && prep.counts); return false; }
      log("direct shot prepared, replacement counts:", prep.counts);
      return true;
    } catch (e) {
      log("direct prep error", e);
      return false;
    } finally {
      // NEVER leave the hook swallowing bookings — it would eat a real Book
      // click later. (The modal is already closed on every path above.)
      toInject("suppress-booking-off");
    }
  }

  async function scheduleMidnightFire(td, timeMin, cfg, myGen, ctl, isGrabbed) {
    var fireAt = Date.now() + msUntilCourtMidnightCorrected() + DIRECT_SEND_DELAY_MS;
    while (Date.now() < fireAt) {
      if (!live(myGen) || isGrabbed()) return;
      await sleep(Math.min(40, Math.max(4, fireAt - Date.now())));
    }
    if (!live(myGen)) return;
    // The shot goes out first — every ms counts — then the fallback burst:
    // select the target day so the app fetches/renders it, and give the radar
    // immediate samples instead of waiting out its cadence.
    var resP = null;
    if (ctl.prepared) {
      resP = awaitMsg(directWaiters, 4000, function () { toInject("direct-book"); });
      setStatus("Полночь — прямой запрос ушёл ⚡");
    }
    if (!isGrabbed()) {
      var cell = dateCellButton(ymd(td));
      if (cell && !cell.disabled && cell.getAttribute("aria-disabled") !== "true") cell.click();
      toInject("replay");
      setTimeout(function () { if (live(myGen)) toInject("replay"); }, 150);
      setTimeout(function () { if (live(myGen)) toInject("replay"); }, 320);
    }
    if (!resP) return;
    var res = await resP;
    if (!live(myGen)) return;
    if (!(res && res.status === 200)) {
      log("direct shot failed (status " + (res && res.status) + " " + (res && res.error || "") + ") — UI grab continues");
      // If the slot is ALSO gone from availability, a rival got it — say so.
      await sleep(1500);
      if (!live(myGen) || isGrabbed()) return;
      var gone = await replayOnce(1600);
      if (gone && gone.body && !bodiesContainTarget([gone.body], td, timeMin)) {
        setStatus("Слот перехватили раньше нас", "error");
        notify("Padel: слот перехвачен", "Кто-то забронировал " + cfg.targetTime + " первым.", true);
        await setState("idle");
      }
      return;
    }
    // 200 can still hide an in-body error; believe it only once availability
    // confirms the slot is gone. If it's still open, let the UI grab take it.
    var chk = await replayOnce(1600);
    var won = !(chk && chk.body && bodiesContainTarget([chk.body], td, timeMin));
    if (won) {
      directWon = true;
      setStatus("✅ Слот " + cfg.targetTime + " забронирован прямым запросом!", "ok");
      notify("✅ Padel забронирован", "Слот " + cfg.targetDate + " " + cfg.targetTime + " занят прямым запросом. Проверь почту.", true);
      // Don't kill a UI grab mid-flight — it runs independently and reports
      // its own outcome. Only disarm when nothing else is booking.
      if (!isGrabbed()) await setState("idle");
    } else {
      log("direct shot got 200 but the slot is still open — UI grab continues");
    }
  }

  async function startPolling(myGen) {
    var st = await get([CFG_KEY]);
    if (!live(myGen)) return;
    var cfg = st[CFG_KEY] || {};
    var td = parseTargetDate(cfg.targetDate);
    var timeMin = hhmmToMinutes(cfg.targetTime);
    if (!td || timeMin < 0) { setStatus("Заполни дату и время в popup", "error"); return; }

    directWon = false;
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
      var turboOn = false;
      var directCtl = { attempts: 0, prepared: false, scheduled: false };
      while (live(myGen) && !grabbed) {
        // Any dialog left open (prewarm, a stray click) would swallow the
        // clicks below and the slot click when the moment comes.
        if (dialogEl()) { await closeModal(); if (!live(myGen) || grabbed) return; }
        await ensureMonth(td); if (!live(myGen) || grabbed) return;
        // Direct shot: only on the night whose rollover actually opens the
        // target date — firing it a night early would just spend the token —
        // and only with auto-Book on: the shot IS an automatic booking.
        var leftMs = msUntilCourtMidnightCorrected();
        var opensTonight = !!cfg.autoBook && ymd(td) === courtYmdPlus(2);
        if (opensTonight && !directCtl.prepared && directCtl.attempts < 2 &&
            leftMs <= DIRECT_PREP_LEAD_MS && leftMs > 35000) {
          directCtl.attempts++;
          directCtl.prepared = await prepareDirectBooking(td, timeMin, cfg, myGen, function () { return grabbed; });
          if (!live(myGen) || grabbed) return;
          if (directCtl.prepared) setStatus("Прямой запрос готов — жду полночь ⚡", "ok");
          else if (directCtl.attempts >= 2) setStatus("Прямой запрос не собрался — бронирую по обычной схеме", "warn");
          parkedYmd = 0;                    // the sacrificial modal click moved focus
          continue;
        }
        if (opensTonight && !directCtl.scheduled && leftMs <= 6000) {
          directCtl.scheduled = true;
          scheduleMidnightFire(td, timeMin, cfg, myGen, directCtl, function () { return grabbed; });
        }
        if (inTurboWindow()) {
          // Rollover imminent: keep the app fetching so it renders the new day
          // on its own — no post-detection redraw to wait out.
          if (!turboOn) {
            turboOn = true;
            setStatus("Полночь близко — держу календарь горячим…");
          }
          pokeApp(td);
          await sleep(TURBO_POKE_MS);
        } else {
          if (turboOn) {
            turboOn = false;
            setStatus("Жду открытия слота " + cfg.targetDate + " " + cfg.targetTime + "…");
          }
          if (maintenanceAsap || Date.now() >= nextMaint) {
            maintenanceAsap = false;
            nextMaint = Date.now() + MAINTENANCE_MS;
            await forceRefetch(td, abortOnGrab);
          } else {
            await parkView(td);
          }
          await sleep(1000);
        }
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
      // While turbo pokes the app, its own responses hit the same detector, so
      // the radar can back off and keep total request volume flat.
      var wait = (inTurboWindow() ? TURBO_REPLAY_MS : REPLAY_MS) - (Date.now() - t0);
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
    // Belt & suspenders: never run the real booking through a swallowed hook.
    toInject("suppress-booking-off");

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
      // and catching that render saves any nudging at all. In the turbo window
      // the app is already fetching on its own, so this is the usual path.
      var cands = freshCandidates() || (await waitFor(freshCandidates, 150, 30)) || [];

      // Not rendered yet — the DOM still holds pre-rollover availability.
      // Selecting the target day is the shortest way to make the app refetch it:
      // one click, and the day lands as the strip's first column.
      //
      // Deliberately NOT gated on isDateAvailable(): that reads the stale
      // "no available times" label, while the radar has already confirmed
      // server-side that the slot is open. Trusting the label here would strand
      // us at exactly the moment the slot opens.
      if (!cands.length && live(myGen)) {
        await ensureMonth(td); if (!live(myGen)) return;
        var cell = dateCellButton(ymd(td));
        if (cell && !cell.disabled && cell.getAttribute("aria-disabled") !== "true") {
          cell.click();
          cands = (await waitFor(freshCandidates, 700, 40)) || [];
        }
      }
      if (!cands.length && live(myGen)) {
        // The cell was disabled, or the app served its cache: force a fetch and
        // watch for the button WHILE it runs, since the redraw usually lands
        // during the refetch's own pauses. forceRefetch stops once we're set.
        var seen = null;
        var refetching = forceRefetch(td, function () { return !!seen || !live(myGen); })
          .catch(function (e) { log("refetch failed", e); });
        seen = await waitFor(freshCandidates, 1200, 40);
        if (!seen) { await refetching; seen = await waitFor(freshCandidates, 400, 40); }
        cands = seen || [];
      }
      if (!live(myGen)) return;
      // Try each same-time button; verify the modal is actually the target day
      // (the multi-day column view can show the same time on a neighbouring day).
      for (var i = 0; i < cands.length; i++) {
        if (!live(myGen)) return;
        cands[i].click();
        // No dialog at all means the click hit a detached node (a turbo redraw
        // landed between the query and the click) — retry fast instead of
        // sitting out the full modal-open patience below.
        if (!(await waitFor(dialogEl, 800, 30))) continue;
        if (!(await waitFor(modalDateRendered, 2000, 40))) continue;
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
      waitFor(bookingConfirmed, 20000, 400).then(function (v) { return v ? { kind: "confirmed" } : null; }),
      waitFor(slotTakenText, 20000, 250).then(function (v) { return v ? { kind: "taken" } : null; })
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
    if (outcome && outcome.kind === "taken") {
      if (directWon) {
        // "Taken" by ourselves: the direct shot landed first. Not an error.
        setStatus("✅ Слот уже забронирован прямым запросом", "ok");
      } else {
        setStatus("Слот перехватили раньше нас", "error");
        notify("Padel: слот перехвачен", "Кто-то успел забронировать " + cfg.targetTime + " первым.", true);
      }
      await setState("idle");
      return;
    }
    var ok = (outcome && outcome.kind === "confirmed") ||
             (outcome && outcome.kind === "rpc" && outcome.data && outcome.data.status === 200);
    if (ok) {
      setStatus("✅ Слот " + cfg.targetTime + " забронирован!", "ok");
      notify("✅ Padel забронирован", "Слот " + cfg.targetDate + " " + cfg.targetTime + " успешно занят.", true);
      await setState("idle");
    } else if (directWon) {
      // The UI attempt fizzled, but the direct shot already secured the slot.
      setStatus("✅ Слот уже забронирован прямым запросом", "ok");
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
