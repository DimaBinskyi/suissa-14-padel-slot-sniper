// content.js — ISOLATED world orchestrator for the midnight DIRECT SHOT.
//
// States (persisted in chrome.storage.local under "state"):
//   idle  -> do nothing
//   armed -> wait for the midnight rollover that opens the target date, then:
//            * ~30s before server-corrected midnight, capture the page's own
//              booking request per job: fill the form on a SACRIFICIAL open
//              slot, click Book, and let inject.js swallow the request before
//              it reaches the network. It carries the reCAPTCHA token the page
//              just minted; its slot epochs are rewritten to the target;
//            * fire every prepared request ~120ms after corrected midnight from
//              inject.js's own timer — the booking lands one RTT after the
//              rollover;
//            * read each shot's HTTP result, check availability to confirm it,
//              persist the outcome (status + lastShot) and disarm.
//            Until then the tab only keeps an open day parked in view (the
//            capture needs a slot button on screen) and refreshes the replay
//            template every ~35s for the post-shot check.
//
// There is no UI booking path: if the shot misses, nothing else books.
(function () {
  "use strict";

  var CFG_KEY = "cfg";
  var STATE_KEY = "state";
  // Shown in the popup next to the extension's own version: a mismatch means
  // this tab still runs the old engine and needs a reload.
  var VERSION = chrome.runtime.getManifest().version;

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
    var d = msToRollover();
    if (d > 120000 || d < -120000) return "";
    return d >= 0 ? " T-" + (d / 1000).toFixed(3) + "s" : " T+" + (-d / 1000).toFixed(3) + "s";
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
  var slotWaiters = [];      // resolved by replayed availability responses
  var captureWaiters = [];   // resolved when inject captures a booking template
  var suppressWaiters = [];  // resolved when inject acks suppress-booking-on
  var preparedWaiters = [];  // resolved when inject finishes prepare-direct
  var directWaiters = [];    // resolved by a direct-book result

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
      if (d.dateHeader) noteClockSample(d.dateHeader, d.tSent, d.tRecv);
      flushWaiters(slotWaiters, d);
    } else if (d.type === "clock-sample") {
      if (d.dateHeader) noteClockSample(d.dateHeader, d.tSent, d.tRecv);
      else if (!clockProbeWarned) {
        clockProbeWarned = true;
        log("clock probe returned no Date header (" + (d.error || "status " + d.status) +
            ") — scheduling on the LOCAL clock");
      }
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


  // Each replay carries its own id, so a reply can only resolve the call that
  // asked for it: a timed-out verification and its retry can both be in
  // flight, and the stale reply must not answer the fresh request.
  var replaySeq = 0;
  function replayOnce(timeoutMs) {
    var rid = ++replaySeq;
    return new Promise(function (res) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; res({ body: "", status: 0, timeout: true }); } }, timeoutMs || 5000);
      slotWaiters.push({
        pred: function (d) { return d && d.rid === rid; },
        fn: function (d) { if (!done) { done = true; clearTimeout(t); res(d); } }
      });
      toInject({ cmd: "replay", rid: rid });
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
  // Building an Intl.DateTimeFormat costs ~27µs; these run on every
  // availability response (~3/s all night) and on every log line, so the
  // formatters are built once and reused.
  var FMT_MINUTE = new Intl.DateTimeFormat("en-GB", {
    timeZone: COURT_TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  });
  var FMT_CLOCK = new Intl.DateTimeFormat("en-GB", {
    timeZone: COURT_TZ, hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  var FMT_DAY = new Intl.DateTimeFormat("en-GB", {
    timeZone: COURT_TZ, year: "numeric", month: "2-digit", day: "2-digit"
  });
  // The candidates for a given slot never change, and the detector compares
  // against them on every response — memoise per target.
  var epochCache = {};
  function targetEpochCandidates(td, timeMin) {
    var key = ymd(td) + "@" + timeMin;
    if (epochCache[key]) return epochCache[key];
    var out = targetEpochCandidatesUncached(td, timeMin);
    epochCache[key] = out;
    return out;
  }
  function targetEpochCandidatesUncached(td, timeMin) {
    var hh = Math.floor(timeMin / 60), mm = timeMin % 60;
    var want = td.y + "-" + pad(td.m) + "-" + pad(td.d) + " " + pad(hh) + ":" + pad(mm);
    var fmt = FMT_MINUTE;
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
  // is when the new day's slots appear — the moment the direct shot aims at.
  // `now` is passed in so the caller's sub-second correction is taken from the
  // same instant; reading the clock twice can straddle a second boundary and
  // put the result a full second out.
  function msUntilCourtMidnight(now) {
    var p = {};
    FMT_CLOCK.formatToParts(new Date(now || Date.now())).forEach(function (x) { p[x.type] = x.value; });
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
  var clockProbeWarned = false;
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
          (msToRollover() / 1000).toFixed(1) + "s");
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
    var now = Date.now();
    return msUntilCourtMidnight(now) - (now % 1000) - clockOffset();
  }
  // SIGNED distance to the rollover: negative once it has passed.
  //
  // msUntilCourtMidnightCorrected() counts to the NEXT midnight, so it jumps
  // from ~0 to ~86,400,000 the instant the rollover happens. Every gate that
  // means "is the rollover near / has it passed" must use this form — reading
  // the unsigned value there inverts the test at exactly the wrong moment.
  function msToRollover() {
    var left = msUntilCourtMidnightCorrected();
    return left > 43200000 ? left - 86400000 : left;
  }
  // Which rollover opens the target: before midnight the next one reveals
  // today+2; just after, the day that opened is today+1 because the court date
  // has already advanced. Deriving this from courtYmdPlus(2) alone made the
  // whole direct-shot path switch itself off the moment midnight passed.
  function targetOpensAtThisRollover(td) {
    return ymd(td) === courtYmdPlus(msToRollover() > 0 ? 2 : 1);
  }
  // Court-timezone date `days` ahead as "YYYYMMDD". The upcoming midnight
  // rollover opens courtYmdPlus(2): entering day X+1 reveals day X+2.
  function courtYmdPlus(days) {
    var p = {};
    FMT_DAY.formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
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

  // The LAST visible dialog, never the first.
  //
  // Measured on the live page: clicking a second slot while a modal is open
  // STACKS a new [role=dialog] instead of swapping the existing one — both end
  // up visible at the same position, each with its own form and Book button.
  // querySelector() returns the stale one, so filling and submitting through it
  // would book the slot the user is no longer looking at.
  function dialogEl() {
    var all = document.querySelectorAll('[role="dialog"]');
    for (var i = all.length - 1; i >= 0; i--) if (visible(all[i])) return all[i];
    return null;
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
  // Skips disabled buttons: Cancel is disabled while a booking is submitting
  // (measured on the live page), and clicking it would silently do nothing
  // while we counted it as a successful close.
  function clickByText(labels, scope) {
    var btns = (scope || document).querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var t = (b.textContent || "").trim();
      if (!visible(b) || labels.indexOf(t) === -1) continue;
      if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
      b.click();
      return true;
    }
    return false;
  }
  async function closeModal() {
    // Scoped to the topmost dialog: with dialogs stacked, an unscoped search
    // would hit the buried one's Cancel and leave the visible one open.
    clickByText(["Cancel", "Cancelar", "Отмена"], dialogEl() || document);
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
  function notify(title, message, sound) {
    log("notify:", title, "|", message);
    try { chrome.runtime.sendMessage({ type: "notify", title: title, message: message, sound: !!sound }); } catch (e) {
      log("notify FAILED (service worker gone?)", String(e));
    }
  }

  // ---------- view parking (keep an open slot on screen for the capture) ----------
  // The capture clicks Book on a sacrificial open slot, so the strip must show
  // an open day. We park on the latest available date at/before the target and
  // leave the view alone. forceRefetch() runs rarely — its only job is to
  // trigger one app-initiated call so inject.js re-captures the availability
  // template with fresh time-bound credentials (SAPISIDHASH); the post-shot
  // check replays that template.
  var parkedYmd = 0;

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
  // the parked view.
  async function forceRefetch(td) {
    var avs = anchorCells(td);
    if (!avs.length) { await parkView(td); return; }
    if (avs.length > 1) {
      avs[1].btn.click();
      await sleep(500);
    } else {
      var nd = navButton(/next day/i), pd = navButton(/previous day/i);
      if (nd) { nd.click(); await sleep(300); }
      var pd2 = navButton(/previous day/i) || pd;
      if (pd2) { pd2.click(); await sleep(300); }
    }
    avs[0].btn.click();
    parkedYmd = avs[0].ymd;
  }

  // ---------- jobs ----------
  // One job = one slot to book with one identity. A midnight rollover opens
  // exactly ONE new day, so every job shares cfg.targetDate and differs only
  // in time + form data. Each job captures its own request (a reCAPTCHA token
  // is single-use) and all prepared shots fire together.
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
      j.prepared = false;
    });
    return out;
  }
  function jobTimes(jobs) {
    return jobs.map(function (j) { return j.label; }).join(" + ");
  }

  // ---------- single owner ----------
  // Every calendar tab runs this script and every one reacts to the same
  // storage state, so two open tabs meant two captures and two direct shots
  // per job fired at the same millisecond — systematic duplicate bookings,
  // plus one tab disarming while the other was mid-capture. One tab claims the
  // run; the others stay passive and say so.
  var TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var OWNER_KEY = "owner";
  var OWNER_STALE_MS = 8000;
  var OWNER_BEAT_MS = 3000;
  var lastBeat = 0;

  async function claimOwnership() {
    var cur = (await get([OWNER_KEY]))[OWNER_KEY];
    var fresh = cur && cur.id && (Date.now() - (cur.ts || 0) < OWNER_STALE_MS);
    if (fresh && cur.id !== TAB_ID) return false;
    await set({ owner: { id: TAB_ID, ts: Date.now() } });
    // Re-read: two tabs can pass the check together, and the last write wins.
    await sleep(60 + Math.floor(Math.random() * 120));
    var after = (await get([OWNER_KEY]))[OWNER_KEY];
    if (!after || after.id !== TAB_ID) return false;
    lastBeat = Date.now();
    return true;
  }
  function beatOwnership() {
    if (Date.now() - lastBeat < OWNER_BEAT_MS) return;
    lastBeat = Date.now();
    set({ owner: { id: TAB_ID, ts: Date.now() } });
  }

  // ---------- run control ----------
  // Every start captures runGen; any state change bumps runGen, so a running
  // loop bails at its next checkpoint. This makes "Выключить" stop instantly.
  var runGen = 0;
  function live(myGen) { return myGen === runGen; }

  // ---------- timing ----------
  var MAINTENANCE_MS = 35000;  // how often to force an app fetch (template freshness)
  // One thread for everything: a click runs Google's handlers (and possibly a
  // grid re-render) synchronously on the thread the shot needs, so parking and
  // refetching stand still this close to the rollover.
  var QUIET_MS = 10000;
  // Build the booking request this early. Later = younger token at fire time
  // (~18s old with a 20s lead; TTL is ~120s). Deliberately tight: capture
  // typically takes 3-6s, leaving one fast retry; a slow capture or a
  // challenge means no shot that night.
  var DIRECT_PREP_LEAD_MS = 20000;
  // Captures are strictly sequential (one modal in the DOM at a time), so each
  // extra slot needs its own window of lead time. Only the FIRST token pays the
  // full wait; later ones are younger.
  var DIRECT_PREP_PER_JOB_MS = 12000;
  function directPrepLeadMs(n) { return DIRECT_PREP_LEAD_MS + Math.max(0, n - 1) * DIRECT_PREP_PER_JOB_MS; }
  // Least time in which a capture is worth starting. Kept tight on purpose: the
  // capture aborts itself (closing its modal) if it would otherwise still be
  // open at the rollover.
  var DIRECT_PREP_MIN_MS = 7000;
  var CAPTURE_ABORT_MS = 1800;
  // How far past the rollover a prepared shot is still worth firing.
  var FIRE_LATE_GRACE_MS = 60000;
  // Fire this long after corrected midnight (cushion for residual clock
  // error — too early and the server rejects it AND the single-use token is
  // spent).
  var DIRECT_SEND_DELAY_MS = 120;

  // ---------- direct shot ----------
  // Shortly before midnight we let the page build a COMPLETE booking request
  // for a sacrificial already-open slot (real form data, real Book click, so
  // the page mints its own reCAPTCHA token), swallow it before it reaches the
  // network, rewrite the slot epochs to the target, and fire it at corrected
  // midnight — the booking arrives one RTT after the rollover.
  async function prepareDirectBooking(td, job, myGen) {
    try {
      setStatus("Готовлю прямой запрос для " + job.label + "…");
      if (dialogEl()) { await closeModal(); if (!live(myGen)) return false; }
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
      if (!live(myGen)) { await closeModal(); return false; }
      var pd = parseModalDate();
      if (!pd || btnMin < 0) { log("direct prep: could not read sacrificial date/time"); await closeModal(); return false; }
      var pCand = targetEpochCandidates(pd, btnMin);
      var tCand = targetEpochCandidates(td, job.timeMin);
      var pMs = parseInt(pCand[0], 10), tMs = parseInt(tCand[0], 10);
      if (!pMs || !tMs || pMs === tMs) { log("direct prep: bad epochs", pMs, tMs); await closeModal(); return false; }
      if (!(await fillForm(job.data))) { log("direct prep: form did not fill"); await closeModal(); return false; }
      if (!live(myGen)) { await closeModal(); return false; }
      // Point of no return: past here we arm the swallow and wait on the page.
      // If the rollover is about to land, abandon the capture now rather than
      // hold a modal open through the fire moment.
      if (msToRollover() < CAPTURE_ABORT_MS) {
        log("direct prep: aborting, rollover too close to finish the capture");
        await closeModal();
        return false;
      }
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
        var solveMs = Math.min(45000, msToRollover() - 8000);
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
      // click later. The catch path can reach here with the modal still open
      // (setStatus/notify throw synchronously on "extension context
      // invalidated"), so close it here rather than trusting every path above.
      try { if (dialogEl()) await closeModal(); } catch (e2) { /* nothing left to do */ }
      toInject("suppress-booking-off");
    }
  }

  // Capture one request per job, sequentially (single modal in the DOM). Each
  // job gets its own reCAPTCHA token because tokens are single-use. Stops early
  // if midnight gets too close to finish another capture safely.
  async function prepareDirectShots(td, jobs, myGen) {
    for (var i = 0; i < jobs.length; i++) {
      var job = jobs[i];
      if (job.prepared) continue;
      if (msToRollover() < DIRECT_PREP_MIN_MS) {
        log("direct prep: not enough time left for " + job.label);
        break;
      }
      job.prepared = await prepareDirectBooking(td, job, myGen);
      if (!live(myGen)) return;
    }
  }

  // Signed offset to corrected midnight, the number to compare across nights.
  function fmtT(ms) { return (ms >= 0 ? "T+" : "T-") + (Math.abs(ms) / 1000).toFixed(3) + "s"; }

  // inject gets the deadline SECONDS in advance and fires from its own timer
  // (see arm-fire): a "fire now" postMessage would cost an event-loop turn and
  // could queue behind the app's rendering at exactly the wrong moment.
  //
  // Every outcome goes to storage (status + lastShot), not just the console.
  // The console dies with the tab: on 2026-10-05 both shots missed and the
  // only record of what the server answered was gone with it.
  async function scheduleMidnightFire(td, jobs, cfg, myGen) {
    var armed = jobs.filter(function (j) { return j.prepared; });
    if (!armed.length) {
      setStatus("Прямой запрос не подготовлен — в эту полночь выстрела нет", "error");
      notify("Padel: выстрела не было", "Прямой запрос на " + cfg.targetDate + " не собрался.", true);
      await setState("idle");
      return;
    }
    var midnightAt = Date.now() + msToRollover();   // corrected midnight on the local clock
    // Math.max: if the rollover already passed, fire now rather than at a
    // deadline in the past.
    var fireAt = Math.max(Date.now(), midnightAt) + DIRECT_SEND_DELAY_MS;
    var offset = Math.round(clockOffset());
    // Send times are reported against midnight on THIS machine's clock, not
    // the corrected one: against the estimate every shot reads ~T+0.120s by
    // construction, which hides exactly the error worth seeing — the Date-
    // header estimate itself drifts by 100ms+ from night to night.
    var wallMidnightAt = midnightAt + offset;
    log("midnight fire scheduled in " + (fireAt - Date.now()) + "ms " +
        "(clock offset " + offset + "ms from " + clockOffsets.length + " samples, send delay " +
        DIRECT_SEND_DELAY_MS + "ms), armed jobs: " + jobTimes(armed));

    // Result waiters first, then arm: the reply can arrive one RTT after the
    // deadline, which may be sooner than this function is resumed.
    var shots = armed.map(function (j) {
      return awaitMsg(directWaiters, Math.max(8000, fireAt - Date.now() + 5000), null, byId(j.id))
        .then(function (res) {
          log("fire result for " + j.label + ": status " + ((res && res.status) || "timeout") +
              ((res && res.error) ? " error=" + res.error : "") +
              ((res && res.body) ? " body=" + String(res.body).slice(0, 200) : ""));
          return { job: j, res: res };
        });
    });
    toInject({ cmd: "arm-fire", ids: armed.map(function (j) { return j.id; }), at: fireAt });
    setTimeout(function () {
      if (!live(myGen)) return;
      setStatus(armed.length > 1
        ? "Полночь — " + armed.length + " прямых запроса ушли ⚡"
        : "Полночь — прямой запрос ушёл ⚡");
    }, Math.max(0, fireAt - Date.now()) + 60);

    var settled = await Promise.all(shots);
    if (!live(myGen)) return;
    // A 200 can still hide an in-body error, so a win needs POSITIVE evidence
    // that the slot is gone. An empty body means the check itself failed
    // (timeout, network error) — one retry, since this runs in the congested
    // second after the rollover.
    var chk = await replayOnce(1600);
    if (!live(myGen)) return;
    if (!(chk && chk.body)) {
      log("verification replay came back empty — retrying once");
      chk = await replayOnce(2500);
      if (!live(myGen)) return;
    }
    var body = (chk && chk.body) || "";
    var verified = !!body;
    if (!verified) log("verification UNAVAILABLE — reporting the raw HTTP results only");

    var lines = [], report = [];
    settled.forEach(function (s) {
      var r = s.res || {};
      var http = r.status || 0;
      var stillOpen = verified && bodiesContainTarget([body], td, s.job.timeMin);
      var gone = verified && !stillOpen;
      var why = (s.res ? "HTTP " + http : "нет ответа") + (r.error ? " " + r.error : "") +
                ", отправлен " + (r.sentAt ? fmtT(r.sentAt - wallMidnightAt) : "?") +
                (r.ms != null ? ", ответ за " + r.ms + "мс" : "");
      var server = r.body ? ": " + String(r.body).slice(0, 120) : "";
      var verdict, line;
      if (http === 200 && gone) {
        verdict = "won";
        line = "✅ " + s.job.label + " забронирован (" + why + ")";
      } else if (http === 200) {
        verdict = verified ? "200-still-open" : "200-unverified";
        line = "⚠️ " + s.job.label + ": ответ 200, но " + (verified ? "слот всё ещё свободен" : "проверить слот не вышло") +
               " — проверь почту (" + why + ")";
      } else if (gone) {
        verdict = "taken";
        line = "❌ " + s.job.label + ": слот заняли раньше нас (" + why + ")" + server;
      } else if (stillOpen) {
        verdict = "rejected-open";
        line = "❌ " + s.job.label + ": сервер отклонил, а слот ЕЩЁ СВОБОДЕН — бронируй руками! (" + why + ")" + server;
      } else {
        verdict = "failed";
        line = "❌ " + s.job.label + ": не вышло, проверить слот не удалось (" + why + ")" + server;
      }
      log("verify " + s.job.label + ": http=" + http + " verified=" + verified + " slotStillOpen=" + stillOpen + " -> " + verdict);
      lines.push(line);
      report.push({ job: s.job.label, verdict: verdict, http: http, error: r.error || "",
                    sentT: r.sentAt ? r.sentAt - wallMidnightAt : null, ms: r.ms != null ? r.ms : null,
                    body: String(r.body || "").slice(0, 400) });
    });
    jobs.filter(function (j) { return !j.prepared; }).forEach(function (j) {
      lines.push("❌ " + j.label + ": прямой запрос не был подготовлен");
      report.push({ job: j.label, verdict: "unprepared" });
    });

    var won = report.filter(function (x) { return x.verdict === "won"; }).length;
    var maybe = report.some(function (x) { return x.http === 200; });
    setStatus(lines.join("\n"), won === jobs.length ? "ok" : (won || maybe) ? "warn" : "error");
    set({ lastShot: {
      ts: Date.now(), version: VERSION, date: cfg.targetDate,
      wallMidnightAt: wallMidnightAt, midnightAt: midnightAt, fireAt: fireAt,
      fireT: fireAt - wallMidnightAt, clockOffsetMs: offset, clockSamples: clockOffsets.length,
      verified: verified, jobs: report
    } });
    notify(won === jobs.length ? "✅ Padel забронирован" : "Padel: результат выстрела", lines.join("\n"), true);
    await setState("idle");
  }

  // A date that is already bookable (or past) never gets a shot: the shot only
  // exists at the rollover that opens the date. msToRollover stays negative for
  // hours after midnight, so "opens at this rollover" alone does not rule it out.
  function shotWindowPassed(td) {
    var inShotWindow = targetOpensAtThisRollover(td) && msToRollover() > -FIRE_LATE_GRACE_MS;
    return +ymd(td) <= +courtYmdPlus(1) && !inShotWindow;
  }
  function refuseOpenDate(cfg) {
    setStatus("Дата " + cfg.targetDate + " уже открыта — прямой запрос стреляет только в полночь её открытия. Выключаю.", "error");
    return setState("idle");
  }

  // The rollover that opens td is the midnight that STARTS the day before it.
  function shotNightLabel(td) {
    var d = new Date(Date.UTC(td.y, td.m - 1, td.d - 1));
    return "00:00 " + pad(d.getUTCDate()) + "." + pad(d.getUTCMonth() + 1);
  }

  async function startPolling(myGen) {
    var st = await get([CFG_KEY]);
    if (!live(myGen)) return;
    var cfg = st[CFG_KEY] || {};
    var td = parseTargetDate(cfg.targetDate);
    var jobs = buildJobs(cfg);
    if (!td || !jobs.length) { setStatus("Заполни дату и время в popup", "error"); return; }
    // Adding a profile blanks the identity fields, and the popup autosaves
    // that without touching `state` — so an armed run could reach Book with an
    // empty form (fillForm reports success for empty strings). Refuse instead.
    var blank = jobs.filter(function (j) { return !j.data.email || !j.data.firstName; });
    if (blank.length) {
      setStatus("Нет имени/email для " + jobTimes(blank) + " — заполни профиль", "error");
      log("refusing to run: blank identity for", jobTimes(blank));
      return;
    }

    if (!(await claimOwnership())) {
      log("another calendar tab owns this run — staying passive");
      setStatus("Бронирует другая вкладка календаря (эта в резерве)", "warn");
      return;
    }
    if (!live(myGen)) return;
    if (shotWindowPassed(td)) { await refuseOpenDate(cfg); return; }

    setStatus("Жду полночь " + shotNightLabel(td) + ": прямой запрос на " + jobTimes(jobs) + ", " + cfg.targetDate);

    var attempts = 0;
    var prepLead = directPrepLeadMs(jobs.length);
    var nextMaint = 0;          // refetch on the first pass: the post-shot check needs a template
    var nextProbe = 0;
    while (live(myGen)) {
      var leftMs = msToRollover();
      var opensTonight = targetOpensAtThisRollover(td);
      // Armed across a rollover without firing (e.g. the tab was asleep).
      if (shotWindowPassed(td)) { await refuseOpenDate(cfg); return; }
      beatOwnership();   // let a second tab see this run is alive
      // Keep the server-clock estimate fresh; tighter as the rollover nears,
      // since that estimate is what the whole shot is scheduled against.
      if (Date.now() >= nextProbe) {
        nextProbe = Date.now() + (Math.abs(leftMs) < 120000 ? 5000 : 60000);
        toInject("clock-probe");
      }
      // Upkeep comes first so a capture (or its retry) starts from a parked
      // view with an open slot on screen — and none of it near the rollover.
      if (Math.abs(leftMs) > QUIET_MS) {
        // A dialog left open (a stray click, an aborted capture) would swallow
        // the parking clicks and the next capture's slot click.
        if (dialogEl()) { await closeModal(); if (!live(myGen)) return; }
        await ensureMonth(td); if (!live(myGen)) return;
        if (Date.now() >= nextMaint) {
          nextMaint = Date.now() + MAINTENANCE_MS;
          await forceRefetch(td);
        } else {
          await parkView(td);
        }
        if (!live(myGen)) return;
        leftMs = msToRollover();          // the upkeep can take a second
      }
      if (opensTonight) {
        var pending = jobs.filter(function (j) { return !j.prepared; });
        if (pending.length && attempts < 2 && leftMs <= prepLead && leftMs > DIRECT_PREP_MIN_MS) {
          attempts++;
          await prepareDirectShots(td, jobs, myGen);
          if (!live(myGen)) return;
          var missing = jobs.filter(function (j) { return !j.prepared; });
          if (!missing.length) setStatus("Прямой запрос готов (" + jobTimes(jobs) + ") — жду полночь ⚡", "ok");
          else setStatus("Не собрался прямой запрос для " + jobTimes(missing) +
                         (attempts < 2 && msToRollover() > DIRECT_PREP_MIN_MS ? " — пробую ещё раз" : ""), "warn");
          parkedYmd = 0;                    // the sacrificial modal click moved focus
          continue;
        }
        // Schedule from 6s out, and still schedule if a slow capture pushed us
        // just past the rollover — the slot is open NOW, so firing immediately
        // is exactly right. Only the token's own lifetime limits how late.
        if (leftMs <= 6000 && leftMs > -FIRE_LATE_GRACE_MS) {
          if (leftMs < 0) log("rollover already passed by " + (-leftMs) + "ms — firing as soon as possible");
          await scheduleMidnightFire(td, jobs, cfg, myGen);
          return;
        }
      }
      await sleep(leftMs < 40000 && leftMs > -FIRE_LATE_GRACE_MS ? 250 : 1000);
    }
  }

  // ---------- booking form (used by the capture) ----------
  // The modal header reads e.g. "Wednesday, July 8, 4:00 – 5:30pm". Once ANY
  // month name is rendered, parseModalDate() can read the sacrificial date.
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

  // ---------- lifecycle ----------
  // A config edit while armed used to be invisible to the running loop (which
  // snapshots jobs at start) yet WAS adopted by a reload or a re-arm — so what
  // got booked depended on invisible timing. Now an edit restarts the run,
  // debounced because the popup autosaves on every keystroke.
  var cfgRestartTimer = null;
  function scheduleCfgRestart() {
    if (cfgRestartTimer) clearTimeout(cfgRestartTimer);
    cfgRestartTimer = setTimeout(async function () {
      cfgRestartTimer = null;
      var st = await get([STATE_KEY]);
      if (st[STATE_KEY] !== "armed") return;
      // Not in the last stretch: restarting there would throw away prepared
      // shots (jobs are rebuilt with prepared=false) with no time to redo them.
      var left = msToRollover();
      if (left > 0 && left < directPrepLeadMs(2) + 5000) {
        log("config changed close to the rollover — keeping the armed snapshot for tonight");
        setStatus("Изменения применятся после полуночи — сейчас стреляю по старым настройкам", "warn");
        return;
      }
      runGen++;
      log("config changed — restarting the run (runGen " + runGen + ")");
      toInject("cancel-fire");
      startPolling(runGen);
    }, 2000);
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes[CFG_KEY] && !changes[STATE_KEY]) { scheduleCfgRestart(); return; }
    if (!changes[STATE_KEY]) return;
    var s = changes[STATE_KEY].newValue;
    runGen++;                    // bump => a running loop bails at once
    log("state changed ->", s, "(runGen " + runGen + ")");
    // inject owns the fire timer, so it cannot see runGen. Any state change
    // invalidates a pending shot — without this, "Выключить" at 23:59:58 would
    // still book at midnight. startPolling re-arms it when appropriate.
    toInject("cancel-fire");
    if (s === "armed") startPolling(runGen);
    // idle: nothing to start; the runGen bump already halted the loop.
  });

  async function boot() {
    log("engine v" + VERSION + " loaded");
    set({ engine: { version: VERSION, ts: Date.now() } });
    var st = await get([STATE_KEY]);
    var s = st[STATE_KEY] || "idle";
    log("boot, state =", s);
    runGen++;
    if (s === "armed") startPolling(runGen);
    else if (s !== "idle") {
      // Only idle/armed exist now. A leftover from an older version (the
      // retired "grab") must not sit there looking like a run in progress.
      log("unknown state '" + s + "' at load — clearing it");
      await setState("idle");
    }
  }

  boot();
})();
