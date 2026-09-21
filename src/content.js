// content.js — ISOLATED world orchestrator (FAST MODE, no page reload).
//
// States (persisted in chrome.storage.local under "state"):
//   idle  -> do nothing
//   armed -> on the rollover night, a third worker joins the two below: the
//            DIRECT SHOT (see prepareDirectBooking) captures the page's own
//            booking request (with its fresh reCAPTCHA token) ~45s before
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

  // Every event goes to console.log with a ms-resolution stamp and, once the
  // clock is synced, the signed offset to the court's midnight (T-12.3s /
  // T+0.150s). That offset is the number that matters when tuning the shot, so
  // it belongs on every line rather than in a separate countdown log.
  function stamp() {
    var d = new Date();
    return d.toTimeString().slice(0, 8) + "." + ("00" + d.getMilliseconds()).slice(-3);
  }
  function tOffset() {
    if (!clockOffsets.length) return "";
    var left = msUntilCourtMidnightCorrected();
    if (left > 86400000 - 120000) return " T+" + ((86400000 - left) / 1000).toFixed(3) + "s";
    if (left < 120000) return " T-" + (left / 1000).toFixed(3) + "s";
    return "";
  }
  var log = function () {
    var a = ["[padel " + stamp() + tOffset() + "]"].concat([].slice.call(arguments));
    console.log.apply(console, a);
  };

  // ---------- storage ----------
  function get(keys) { return new Promise(function (res) { chrome.storage.local.get(keys, res); }); }
  function set(obj) { return new Promise(function (res) { chrome.storage.local.set(obj, res); }); }
  function setStatus(text, level) {
    set({ status: { text: text, level: level || "info", ts: Date.now() } });
    log("status[" + (level || "info") + "]", text);
  }
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

  // Waiters are { fn, pred }. A waiter with a predicate only takes messages it
  // matches and stays queued otherwise — needed once two jobs have direct-shot
  // requests in flight, so one job's result can't resolve the other's promise.
  function flushWaiters(list, d) {
    var keep = [], fire = [];
    list.forEach(function (w) { (!w.pred || w.pred(d) ? fire : keep).push(w); });
    list.length = 0;
    keep.forEach(function (w) { list.push(w); });
    fire.forEach(function (w) { w.fn(d); });
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

  // Wait for the next message flushed into `list` (optionally only those
  // matching `pred`); `sendFn` fires the request that should produce it.
  // Resolves null on timeout.
  function awaitMsg(list, timeoutMs, sendFn, pred) {
    return new Promise(function (res) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; res(null); } }, timeoutMs);
      list.push({ pred: pred, fn: function (d) { if (!done) { done = true; clearTimeout(t); res(d); } } });
      if (sendFn) sendFn();
    });
  }
  function byId(id) { return function (d) { return d && d.id === id; }; }

  function replayOnce(timeoutMs) {
    return new Promise(function (res) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; res({ body: "", status: 0, timeout: true }); } }, timeoutMs || 5000);
      slotWaiters.push({ fn: function (d) { if (!done) { done = true; clearTimeout(t); res(d); } } });
      toInject("replay");
    });
  }
  function nextBookingResult(timeoutMs) {
    return new Promise(function (res) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; res(null); } }, timeoutMs || 20000);
      bookingWaiters.push({ fn: function (d) { if (!done) { done = true; clearTimeout(t); res(d); } } });
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
  var lastLoggedOffset = null;
  function noteClockSample(dateHeader, tSent, tRecv) {
    var s = Date.parse(dateHeader || "");
    if (!s || !tSent || !tRecv) return;
    var rtt = tRecv - tSent;
    if (rtt < 0 || rtt > 2000) return; // stalled request — poisoned sample
    clockOffsets.push((s + 500) - (tSent + tRecv) / 2);
    if (clockOffsets.length > 15) clockOffsets.shift();
    // Log the first fix and any material drift; a per-sample log would be 3/s.
    var off = clockOffset();
    if (lastLoggedOffset === null || Math.abs(off - lastLoggedOffset) > 150) {
      lastLoggedOffset = off;
      log("clock sync: server offset " + (off >= 0 ? "+" : "") + Math.round(off) + "ms" +
          " (rtt " + rtt + "ms, " + clockOffsets.length + " samples), midnight in " +
          (msUntilCourtMidnightCorrected() / 1000).toFixed(1) + "s");
    }
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
  function hhmm12(min) {
    var h = Math.floor(min / 60) % 24, h12 = h % 12;
    return (h12 === 0 ? 12 : h12) + ":" + pad(min % 60);
  }
  function meridiem(min) { return (Math.floor(min / 60) % 24) < 12 ? "am" : "pm"; }
  // With two jobs in play, a modal left open by the OTHER slot must not be
  // filled in for this one. The header reads "Wednesday, July 8, 4:00 – 5:30pm":
  // the start time carries no am/pm, so the 90-min end time identifies the slot.
  // Deliberately defensive — if no time pattern is recognisable at all we do
  // NOT block the booking, since the slot button we clicked already matched the
  // exact time. Only a clearly different time counts as a mismatch.
  function modalShowsOtherTime(timeMin) {
    var d = dialogEl();
    if (!d) return false;
    var t = (d.textContent || "").toLowerCase().replace(/\s+/g, "");
    var endMin = timeMin + 90;
    if (t.indexOf(hhmm12(endMin) + meridiem(endMin)) !== -1) return false;
    return /\d{1,2}:\d{2}(am|pm)/.test(t);
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
    log("notify:", title, "|", message);
    try { chrome.runtime.sendMessage({ type: "notify", title: title, message: message, sound: !!sound }); } catch (e) {
      log("notify FAILED (service worker gone?)", String(e));
    }
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

  // ---------- jobs ----------
  // One job = one slot to book with one identity. A midnight rollover opens
  // exactly ONE new day, so every job shares cfg.targetDate and differs only
  // in time + form data. Two slots are booked by firing both direct shots at
  // once; the UI fallback works through them one modal at a time.
  function jobData(src) {
    return {
      firstName: src.firstName || "", lastName: src.lastName || "",
      email: src.email || "", flat: src.flat || ""
    };
  }
  function buildJobs(cfg) {
    var out = [];
    var m0 = hhmmToMinutes(cfg.targetTime);
    if (m0 >= 0) out.push({ id: "a", time: cfg.targetTime, timeMin: m0, data: jobData(cfg) });
    var s = cfg.second;
    if (s && s.time) {
      var m1 = hhmmToMinutes(s.time);
      // Same time twice would just make two jobs fight over one slot.
      if (m1 >= 0 && m1 !== m0) out.push({ id: "b", time: s.time, timeMin: m1, data: jobData(s) });
    }
    out.forEach(function (j) {
      j.label = j.time + (j.data.firstName ? " (" + j.data.firstName + ")" : "");
      j.prepared = false; j.directWon = false; j.done = false; j.ok = false;
    });
    return out;
  }
  function jobTimes(jobs) {
    return jobs.map(function (j) { return j.label; }).join(" + ");
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
  // Direct shot: build the booking request this early. Later = younger token
  // at fire time (~18s old with a 20s lead; TTL is ~120s). Deliberately tight:
  // capture typically takes 3-6s, leaving one fast retry; a slow capture or a
  // challenge means no direct shot that night — the UI path is unaffected.
  // Fire this long after corrected midnight (cushion for residual clock
  // error — too early and the server rejects it AND the single-use token is
  // spent).
  var DIRECT_PREP_LEAD_MS = 20000;
  // Captures are strictly sequential (one modal in the DOM at a time), so each
  // extra slot needs its own window of lead time. Only the FIRST token pays the
  // full wait; later ones are younger.
  var DIRECT_PREP_PER_JOB_MS = 12000;
  function directPrepLeadMs(n) { return DIRECT_PREP_LEAD_MS + Math.max(0, n - 1) * DIRECT_PREP_PER_JOB_MS; }
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
  async function prepareDirectBooking(td, job, cfg, myGen, isGrabbed) {
    try {
      setStatus("Готовлю прямой запрос для " + job.label + "…");
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
      var tCand = targetEpochCandidates(td, job.timeMin);
      var pMs = parseInt(pCand[0], 10), tMs = parseInt(tCand[0], 10);
      if (!pMs || !tMs || pMs === tMs) { log("direct prep: bad epochs", pMs, tMs); await closeModal(); return false; }
      if (!(await fillForm(job.data))) { log("direct prep: form did not fill"); await closeModal(); return false; }
      if (!live(myGen) || isGrabbed()) { await closeModal(); return false; }
      // Arm the swallow and WAIT for the ack: the Book click below can reach
      // xhr.send synchronously, before an unacked postMessage would arrive —
      // and then the sacrificial slot would get booked for real.
      var ack = await awaitMsg(suppressWaiters, 1500, function () {
        toInject({ cmd: "suppress-booking-on", needle: job.data.email || "" });
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
        // we capture as usual. Keep the swallow alive while they solve — but
        // only for the time actually left before the fire moment.
        var solveMs = Math.min(45000, msUntilCourtMidnightCorrected() - 8000);
        if (solveMs > 3000) {
          toInject({ cmd: "suppress-extend", ttl: solveMs + 10000 });
          setStatus("Капча на прогреве! Реши её — токен нужен до полуночи", "error");
          notify("⚠️ Padel: капча на прогреве", "Реши капчу в открытой вкладке календаря — прямой запрос ждёт токен.", true);
          cap = await awaitMsg(captureWaiters, solveMs);
        }
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
        toInject({ cmd: "prepare-direct", id: job.id, repl: repl });
      }, byId(job.id));
      if (!prep || !prep.ok) { log("direct prep: epoch rewrite failed", prep && prep.counts); return false; }
      log("direct shot prepared for " + job.label + ", replacement counts:", prep.counts);
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

  // Capture one request per job, sequentially (single modal in the DOM). Each
  // job gets its own reCAPTCHA token because tokens are single-use. Stops early
  // if midnight gets too close to finish another capture safely.
  async function prepareDirectShots(td, jobs, cfg, myGen, isGrabbed) {
    for (var i = 0; i < jobs.length; i++) {
      var job = jobs[i];
      if (job.prepared) continue;
      if (msUntilCourtMidnightCorrected() < 9000) {
        log("direct prep: not enough time left for " + job.label);
        break;
      }
      job.prepared = await prepareDirectBooking(td, job, cfg, myGen, isGrabbed);
      if (!live(myGen) || isGrabbed()) return;
    }
  }

  async function scheduleMidnightFire(td, jobs, cfg, myGen, isGrabbed) {
    var fireAt = Date.now() + msUntilCourtMidnightCorrected() + DIRECT_SEND_DELAY_MS;
    log("midnight fire scheduled in " + (fireAt - Date.now()) + "ms " +
        "(clock offset " + Math.round(clockOffset()) + "ms, send delay " + DIRECT_SEND_DELAY_MS + "ms), armed jobs: " +
        (jobTimes(jobs.filter(function (j) { return j.prepared; })) || "none"));
    while (Date.now() < fireAt) {
      if (!live(myGen) || isGrabbed()) { log("fire cancelled before midnight (grab already running or disarmed)"); return; }
      await sleep(Math.min(40, Math.max(4, fireAt - Date.now())));
    }
    if (!live(myGen)) return;
    log("FIRE (scheduled drift " + (Date.now() - fireAt) + "ms)");
    // The shots go out first — every ms counts — then the fallback burst:
    // select the target day so the app fetches/renders it, and give the radar
    // immediate samples instead of waiting out its cadence.
    var armed = jobs.filter(function (j) { return j.prepared; });
    var sentAt = Date.now();
    var shots = armed.map(function (j) {
      // All shots leave in the same tick: two slots are booked truly in
      // parallel, each arriving one RTT after the rollover.
      return awaitMsg(directWaiters, 4000, function () {
        log("direct-book sent for " + j.label);
        toInject({ cmd: "direct-book", id: j.id });
      }, byId(j.id)).then(function (res) {
        log("direct-book result for " + j.label + ": status " + ((res && res.status) || "timeout") +
            " after " + (Date.now() - sentAt) + "ms" + ((res && res.error) ? " error=" + res.error : "") +
            ((res && res.body) ? " body=" + String(res.body).slice(0, 200) : ""));
        return { job: j, res: res };
      });
    });
    if (armed.length) {
      setStatus(armed.length > 1
        ? "Полночь — " + armed.length + " прямых запроса ушли ⚡"
        : "Полночь — прямой запрос ушёл ⚡");
    }
    if (!isGrabbed()) {
      var cell = dateCellButton(ymd(td));
      if (cell && !cell.disabled && cell.getAttribute("aria-disabled") !== "true") cell.click();
      toInject("replay");
      setTimeout(function () { if (live(myGen)) toInject("replay"); }, 150);
      setTimeout(function () { if (live(myGen)) toInject("replay"); }, 320);
    }
    if (!shots.length) return;

    var settled = await Promise.all(shots);
    if (!live(myGen)) return;
    settled.forEach(function (s) {
      if (!(s.res && s.res.status === 200)) {
        log("direct shot for " + s.job.label + " failed (status " + (s.res && s.res.status) +
            " " + ((s.res && s.res.error) || "") + ") — UI grab continues");
      }
    });
    // A 200 can still hide an in-body error, so believe it only once
    // availability shows the slot gone. One replay verifies every job.
    var chk = await replayOnce(1600);
    if (!live(myGen)) return;
    var body = (chk && chk.body) || "";
    var wonJobs = [], lostJobs = [];
    settled.forEach(function (s) {
      var gone = !(body && bodiesContainTarget([body], td, s.job.timeMin));
      log("verify " + s.job.label + ": http=" + ((s.res && s.res.status) || 0) +
          " slotStillOpen=" + (!gone) + " -> " + (s.res && s.res.status === 200 && gone ? "WON" : "not won"));
      if (s.res && s.res.status === 200 && gone) { s.job.directWon = true; wonJobs.push(s.job); }
      else lostJobs.push(s.job);
    });
    if (wonJobs.length) {
      var names = wonJobs.map(function (j) { return j.label; }).join(" + ");
      setStatus("✅ " + names + " забронирован прямым запросом!", "ok");
      notify("✅ Padel забронирован", "Слот " + cfg.targetDate + " " + names + " занят прямым запросом. Проверь почту.", true);
    }
    // Nothing of ours got through and the slots are gone too -> a rival won.
    if (!wonJobs.length && lostJobs.length && body && !isGrabbed()) {
      var stolen = lostJobs.filter(function (j) { return !bodiesContainTarget([body], td, j.timeMin); });
      if (stolen.length) {
        setStatus("Слот перехватили раньше нас", "error");
        notify("Padel: слот перехвачен", "Кто-то забронировал " +
          stolen.map(function (j) { return j.time; }).join(", ") + " первым.", true);
      }
    }
    // Don't disarm while a UI grab is still working — it reports its own result.
    if (!isGrabbed() && wonJobs.length === jobs.length) await setState("idle");
  }

  async function startPolling(myGen) {
    var st = await get([CFG_KEY]);
    if (!live(myGen)) return;
    var cfg = st[CFG_KEY] || {};
    var td = parseTargetDate(cfg.targetDate);
    var jobs = buildJobs(cfg);
    if (!td || !jobs.length) { setStatus("Заполни дату и время в popup", "error"); return; }

    setStatus("Жду открытия " + jobTimes(jobs) + " на " + cfg.targetDate + " (радар " + REPLAY_MS + "мс)…");

    var grabbed = false;
    // Detection MUST be time-specific: look for the EXACT slot's epoch in the
    // response. A day-level "date is available" check falsely fires when the
    // day already has OTHER times open (e.g. 8:30/2:30 exist but 1:00pm doesn't).
    // With two jobs the whole day opens in one response, so the first hit for
    // ANY job starts the booking queue for all of them.
    function tryDetect(bodies) {
      if (grabbed || !live(myGen)) return false;
      var hit = jobs.filter(function (j) {
        return !j.done && bodiesContainTarget(bodies, td, j.timeMin);
      });
      if (!hit.length) return false;
      grabbed = true;
      onSlotsBody = null;
      log("slot detected in ListAvailableSlots response:", jobTimes(hit));
      runGrabs(td, jobs, cfg, myGen);
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
      var directCtl = { attempts: 0, scheduled: false };
      var prepLead = directPrepLeadMs(jobs.length);
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
        var pending = jobs.some(function (j) { return !j.prepared; });
        if (opensTonight && pending && directCtl.attempts < 2 &&
            leftMs <= prepLead && leftMs > 9000) {
          directCtl.attempts++;
          await prepareDirectShots(td, jobs, cfg, myGen, function () { return grabbed; });
          if (!live(myGen) || grabbed) return;
          var ready = jobs.filter(function (j) { return j.prepared; });
          if (ready.length === jobs.length) setStatus("Прямой запрос готов (" + jobTimes(ready) + ") — жду полночь ⚡", "ok");
          else if (ready.length) setStatus("Готов прямой запрос только для " + jobTimes(ready) + " — остальное обычной схемой", "warn");
          else if (directCtl.attempts >= 2) setStatus("Прямой запрос не собрался — бронирую по обычной схеме", "warn");
          parkedYmd = 0;                    // the sacrificial modal click moved focus
          continue;
        }
        if (opensTonight && !directCtl.scheduled && leftMs <= 6000) {
          directCtl.scheduled = true;
          scheduleMidnightFire(td, jobs, cfg, myGen, function () { return grabbed; });
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
            setStatus("Жду открытия " + jobTimes(jobs) + " на " + cfg.targetDate + "…");
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
    var beat = { n: 0, ok: 0, since: Date.now(), lastStatus: 0 };
    while (live(myGen) && !grabbed) {
      var t0 = Date.now();
      var rep = await replayOnce(2000);
      if (!live(myGen) || grabbed) return;
      // Radar runs ~3x/s for hours, so per-request logging is a heartbeat
      // outside the rollover window and full detail inside it, where every
      // response is worth seeing.
      beat.n++;
      beat.lastStatus = (rep && rep.status) || 0;
      if (beat.lastStatus === 200) beat.ok++;
      if (inTurboWindow()) {
        log("radar replay: status " + beat.lastStatus + ", " + ((rep && rep.body) || "").length +
            "b, target " + (bodiesContainTarget([rep && rep.body], td, jobs[0].timeMin) ? "PRESENT" : "absent") +
            ", " + (Date.now() - t0) + "ms");
      } else if (Date.now() - beat.since >= 10000) {
        log("radar heartbeat: " + beat.ok + "/" + beat.n + " ok in " +
            ((Date.now() - beat.since) / 1000).toFixed(0) + "s, midnight in " +
            (msUntilCourtMidnightCorrected() / 1000).toFixed(0) + "s");
        beat = { n: 0, ok: 0, since: Date.now(), lastStatus: beat.lastStatus };
      }
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
  async function fillForm(data) {
    var start = Date.now();
    var end = start + 1500;
    var did = { first: false, last: false, mail: false, note: false };
    while (Date.now() < end) {
      var f = formInputs();
      if (!did.first && f.texts[0]) { setNativeValue(f.texts[0], data.firstName || ""); did.first = true; }
      if (!did.last && f.texts[1]) { setNativeValue(f.texts[1], data.lastName || ""); did.last = true; }
      if (!did.mail && f.emails[0]) { setNativeValue(f.emails[0], data.email || ""); did.mail = true; }
      if (!did.note && f.areas[0]) { setNativeValue(f.areas[0], data.flat || ""); did.note = true; }
      if (did.first && did.last && did.mail && did.note) return true;
      // Last name / notes may simply not exist on this form. Only accept that
      // after a grace period, or a late-rendering field would go unfilled.
      if (did.first && did.mail && bookButton() && Date.now() - start > 400) return true;
      await sleep(40);
    }
    return did.first && did.mail;
  }

  // Book ONE job through the UI. Returns an outcome string; the caller owns
  // status/notifications/state so a queue of jobs can be reported as a whole:
  //   ok | captcha | taken | manual | unrendered | noform | unconfirmed | aborted
  async function grabJob(td, job, cfg, myGen) {
    var timeMin = job.timeMin;
    setStatus("Слот " + job.label + " открылся! Бронирую…", "ok");
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
    // The modal must match the target day AND this job's time — with two jobs
    // in play, a leftover modal for the other slot must not be filled in here.
    function modalIsThisJob() {
      return modalMatchesTarget(td) && !modalShowsOtherTime(timeMin);
    }

    var opened = false;
    var filled = false;
    // An open dialog swallows every click below, so deal with it first. If it
    // already IS this job's, there's nothing to click — go straight to filling.
    if (dialogEl()) {
      if (modalIsThisJob()) {
        opened = true;
        setStatus("Заполняю данные…");
        filled = await fillForm(job.data);
      } else {
        await closeModal();
      }
      if (!live(myGen)) return "aborted";
    }
    var deadline = Date.now() + 15000;
    while (Date.now() < deadline && !opened) {
      if (!live(myGen)) return "aborted";
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
        await ensureMonth(td); if (!live(myGen)) return "aborted";
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
      if (!live(myGen)) return "aborted";
      // Try each same-time button; verify the modal is actually the target day
      // (the multi-day column view can show the same time on a neighbouring day).
      for (var i = 0; i < cands.length; i++) {
        if (!live(myGen)) return "aborted";
        cands[i].click();
        // No dialog at all means the click hit a detached node (a turbo redraw
        // landed between the query and the click) — retry fast instead of
        // sitting out the full modal-open patience below.
        if (!(await waitFor(dialogEl, 800, 30))) continue;
        if (!(await waitFor(modalDateRendered, 2000, 40))) continue;
        if (!modalIsThisJob()) {          // wrong day/time -> skip this button
          tried.push(cands[i]);
          await closeModal();
          continue;
        }
        opened = true;
        setStatus("Заполняю данные…");
        log("modal open for " + job.label + " (candidate " + (i + 1) + "/" + cands.length + ")");
        filled = await fillForm(job.data);  // starts as soon as the first input exists
        log("form filled=" + filled + " for <" + job.data.email + "> кв." + job.data.flat);
        break;
      }
      if (!opened) await sleep(150);
    }

    if (!live(myGen)) return "aborted";
    if (!opened) return "unrendered";

    if (!filled) {              // late-rendering inputs: one more pass
      filled = await fillForm(job.data);
      if (!live(myGen)) return "aborted";
      if (!filled) return "noform";
    }

    if (!cfg.autoBook) return "manual";

    var book = bookButton();
    if (!book) return "nobutton";

    setStatus("Жму Book…");
    var resultP = nextBookingResult(20000);
    var clickedAt = Date.now();
    book.click();
    log("Book clicked for " + job.label);

    var outcome = await Promise.race([
      resultP.then(function (r) { return { kind: "rpc", data: r }; }),
      waitFor(captchaVisible, 20000, 300).then(function (v) { return v ? { kind: "captcha" } : null; }),
      waitFor(bookingConfirmed, 20000, 400).then(function (v) { return v ? { kind: "confirmed" } : null; }),
      waitFor(slotTakenText, 20000, 250).then(function (v) { return v ? { kind: "taken" } : null; })
    ]);
    if (!outcome || (outcome.kind === "rpc" && outcome.data && outcome.data.status !== 200)) {
      if (captchaVisible()) outcome = { kind: "captcha" };
    }

    log("Book outcome for " + job.label + ": " + ((outcome && outcome.kind) || "nothing") +
        (outcome && outcome.kind === "rpc" ? " http=" + ((outcome.data && outcome.data.status) || 0) +
          ((outcome.data && outcome.data.body) ? " body=" + String(outcome.data.body).slice(0, 200) : "") : "") +
        " after " + (Date.now() - clickedAt) + "ms");
    if (outcome && outcome.kind === "captcha") return "captcha";
    if (outcome && outcome.kind === "taken") return "taken";
    var ok = (outcome && outcome.kind === "confirmed") ||
             (outcome && outcome.kind === "rpc" && outcome.data && outcome.data.status === 200);
    return ok ? "ok" : "unconfirmed";
  }

  // After a booking completes, the page can sit on a confirmation view. Get
  // back to the slot grid so the next job has something to click.
  async function backToGrid(myGen) {
    if (slotButtonsAll().length) return true;
    await closeModal();
    if (!live(myGen)) return false;
    if (slotButtonsAll().length) return true;
    clickByText(["Done", "Close", "Book another time", "Listo", "Cerrar", "Готово", "Закрыть"]);
    var seen = await waitFor(function () { return slotButtonsAll().length ? true : null; }, 3000, 80);
    return !!seen;
  }

  function reportJob(job, out, cfg) {
    var when = cfg.targetDate + " " + job.time;
    if (out === "ok") {
      setStatus("✅ Слот " + job.label + " забронирован!", "ok");
      notify("✅ Padel забронирован", "Слот " + when + " успешно занят.", true);
    } else if (out === "captcha") {
      setStatus("КАПЧА — нужен ты. Открой вкладку и добей вручную", "error");
      notify("⚠️ Padel: капча!", "Автобронь остановлена. Открой вкладку календаря и реши капчу вручную.", true);
    } else if (out === "taken") {
      if (job.directWon) {
        // "Taken" by ourselves: our own direct shot landed first. Not an error.
        setStatus("✅ Слот " + job.label + " уже забронирован прямым запросом", "ok");
      } else {
        setStatus("Слот " + job.label + " перехватили раньше нас", "error");
        notify("Padel: слот перехвачен", "Кто-то успел забронировать " + job.time + " первым.", true);
      }
    } else if (out === "manual") {
      setStatus("Форма готова — нажми Book вручную", "warn");
      notify("Padel: форма готова", "Слот " + job.time + " заполнен. Нажми Book.", true);
    } else if (out === "noform") {
      setStatus("Поля формы не заполнились — проверь вкладку", "error");
      notify("Padel: заполни форму", "Слот " + job.time + " открыт, но поля не заполнились. Открой вкладку.", true);
    } else if (out === "nobutton") {
      setStatus("Кнопка Book не найдена — стоп", "error");
      notify("Padel: проверь вкладку", "Кнопка Book не найдена для " + job.time + ".", true);
    } else if (out === "unrendered") {
      setStatus("Слот " + job.label + " не отрисовался вовремя", "warn");
    } else if (out === "unconfirmed") {
      if (job.directWon) {
        setStatus("✅ Слот " + job.label + " уже забронирован прямым запросом", "ok");
      } else {
        setStatus("Не удалось подтвердить бронь " + job.label + " — проверь вкладку", "error");
        notify("Padel: проверь бронь", "Не удалось подтвердить результат для " + job.time + ". Открой вкладку.", true);
      }
    }
  }

  // Work the jobs one at a time — there is a single modal in the DOM, so UI
  // bookings cannot overlap. Jobs already won by a direct shot are skipped.
  async function runGrabs(td, jobs, cfg, myGen) {
    var did = 0;
    log("UI booking queue starts: " + jobTimes(jobs) + " on " + cfg.targetDate);
    for (var i = 0; i < jobs.length; i++) {
      var job = jobs[i];
      if (!live(myGen)) return;
      if (job.done) continue;
      if (job.directWon) { log("skip " + job.label + " — already won by the direct shot"); job.done = true; job.ok = true; continue; }
      if (did > 0 && !(await backToGrid(myGen))) {
        if (!live(myGen)) return;
        log("could not get back to the slot grid before " + job.label);
        job.done = true;
        setStatus("Не удалось вернуться к сетке — забронируй " + job.label + " вручную", "error");
        notify("Padel: добей вручную", "Слот " + job.time + " не забронирован — открой вкладку.", true);
        continue;
      }
      var out = await grabJob(td, job, cfg, myGen);
      if (!live(myGen) || out === "aborted") return;
      did++;
      job.done = true;
      job.out = out;
      job.ok = (out === "ok");
      reportJob(job, out, cfg);
      // A captcha challenge or a half-filled form blocks everything behind it.
      if (out === "captcha" || out === "manual" || out === "noform" || out === "nobutton") {
        log("queue stops after " + job.label + " (" + out + ") — needs a human");
        break;
      }
    }
    if (!live(myGen)) return;
    var okJobs = jobs.filter(function (j) { return j.ok || j.directWon; });
    if (jobs.length > 1) {
      setStatus(okJobs.length === jobs.length
        ? "✅ Забронировано: " + jobTimes(okJobs)
        : "Забронировано " + okJobs.length + " из " + jobs.length + " (" + jobTimes(okJobs) + ")",
        okJobs.length === jobs.length ? "ok" : "warn");
    }
    // Nothing booked and the only thing that went wrong was a slot failing to
    // render: detection may have been early, so keep waiting rather than
    // disarming. Any conclusive outcome (taken, captcha, form trouble) must NOT
    // re-arm, or we'd wait forever for a slot a rival already holds. Never
    // re-arm after a success either — rebuilt jobs lose their state and would
    // book the same slot twice.
    var conclusive = jobs.some(function (j) { return j.out && j.out !== "unrendered"; });
    var anyUnrendered = jobs.some(function (j) { return j.out === "unrendered"; });
    if (!okJobs.length && anyUnrendered && !conclusive &&
        (await get([STATE_KEY]))[STATE_KEY] === "armed" && live(myGen)) {
      setStatus("Слот не отрисовался вовремя — продолжаю ждать", "warn");
      startPolling(myGen);
      return;
    }
    await setState("idle");
  }

  async function grabNow(myGen) {
    var st = await get([CFG_KEY]);
    if (!live(myGen)) return;
    var cfg = st[CFG_KEY] || {};
    var td = parseTargetDate(cfg.targetDate);
    var jobs = buildJobs(cfg);
    if (!td || !jobs.length) { setStatus("Заполни дату и время в popup", "error"); await setState("idle"); return; }
    await runGrabs(td, jobs, cfg, myGen);
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
