// inject.js — runs in the MAIN world at document_start.
//
// Why MAIN + document_start: the Google Calendar bundle caches a reference to
// XMLHttpRequest.prototype.send at load time, so a hook installed *after* the
// app boots is bypassed. Installing it before the bundle runs is the only way
// to observe (and replay) the gRPC-web availability calls. Verified on the live
// page: ListAvailableSlots is an XHR, not fetch.
//
// Responsibilities:
//   1. Capture the ListAvailableSlots request as a replay template (verbatim
//      url + method + headers + body, so auth/API-key are preserved).
//   2. Forward every availability response and booking-RPC result to the
//      ISOLATED content script via window.postMessage.
//   3. Replay the captured request on demand (the "radar B" poll) without
//      reloading the page.
(function () {
  "use strict";

  var SLOTS = "ListAvailableSlots";
  var SERVICE = "/AppointmentBookingService/";
  var DEF = "GetAppointmentServiceDefinition";

  // Latest captured request template. Refreshed on every app-initiated call so
  // credentials (e.g. SAPISIDHASH, which is time-bound) stay fresh.
  var template = null;

  // Direct-shot support: while `suppress` is armed, the page's own Book click
  // is swallowed before it reaches the network, and the request it built
  // (headers + body incl. the FRESH reCAPTCHA token the page just minted) is
  // kept as bookingTemplate. prepare-direct rewrites its slot epochs into
  // prepared[id], which direct-book fires verbatim at midnight.
  //
  // prepared is keyed by job id so several slots can be armed at once (each
  // from its own capture, since a reCAPTCHA token is single-use) and fired
  // together at the rollover.
  var bookingTemplate = null;
  var prepared = {};
  var suppress = null;          // { needle, until }

  function suppressActive() {
    // Dead-man switch: if the content script dies mid-capture, a stuck
    // suppress would swallow the user's REAL booking clicks forever.
    if (suppress && Date.now() > suppress.until) suppress = null;
    return !!suppress;
  }

  function captureBooking(url, method, headers, body) {
    if (typeof body !== "string" || bookingTemplate) {
      log("swallowed a booking call but did not capture it (" +
          (bookingTemplate ? "already have one" : "body is not a string") + ")");
      return;
    }
    if (suppress.needle && body.indexOf(suppress.needle) === -1) {
      log("swallowed a booking call that does not carry the expected email — not captured");
      return;
    }
    bookingTemplate = { url: url, method: method || "POST", headers: headers || {}, body: body };
    log("booking request CAPTURED: " + body.length + "b, " +
        Object.keys(headers || {}).length + " headers, token=" +
        (/g-recaptcha|recaptcha/i.test(body) ? "present" : "NOT VISIBLE in body"));
    post({ type: "booking-captured", ok: true });
  }

  var FIRE_SPIN_MS = 6;       // busy-wait tail that absorbs timer lateness
  var TOKEN_TTL_MS = 110000;  // reCAPTCHA tokens live ~2min; past that a send is pointless
  // Bumped by every arm-fire and cancel-fire, so a pending timer that is no
  // longer the current intent fires nothing.
  var fireGen = 0;

  // Send one prepared booking request. Nothing but the fetch() call happens
  // before the request is handed to the network stack — logging comes after,
  // because this runs at the single most latency-sensitive moment of the night.
  function firePrepared(id) {
    var req = prepared[id];
    if (!req) {
      log("fire[" + id + "] REFUSED: nothing prepared for this job");
      post({ type: "direct-book-result", id: id, status: 0, body: "", error: "not-prepared" });
      return;
    }
    delete prepared[id];      // single-use token; never fire the same one twice
    var t0 = Date.now();
    // origFetch, NOT the patched window.fetch: the hook would classify our own
    // shot as a booking call and post a booking-result, which a UI grab waiting
    // on its own Book click would consume as its result.
    var p = (origFetch || fetch).call(window, req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      credentials: "include"
    });
    log("fire[" + id + "] POST " + req.body.length + "b issued");
    p.then(function (r) {
      return r.text().then(function (t) {
        log("fire[" + id + "] <- " + r.status + " in " + (Date.now() - t0) + "ms: " + t.slice(0, 300));
        post({ type: "direct-book-result", id: id, status: r.status, body: t.slice(0, 800) });
      });
    }).catch(function (err) {
      log("fire[" + id + "] network error after " + (Date.now() - t0) + "ms: " + String(err));
      post({ type: "direct-book-result", id: id, status: 0, body: "", error: String(err) });
    });
  }

  // Rewrite every sacrificial identifier to its target counterpart in ONE pass.
  //
  // A pass per pattern would re-match text an earlier pattern just wrote: with a
  // sacrificial slot 90 min before the target, pattern 0 turns the start epoch
  // into the target's, and pattern 1 (looking for sacrificial-start + 90 min,
  // which now equals it) rewrites it again — producing a request that books the
  // wrong slot while still looking like a success. Alternation in one pass
  // cannot do that. Longest needle first so the seconds form never matches
  // inside the milliseconds form.
  function replaceAllNums(body, pairs) {
    var map = {}, alts = [];
    pairs.forEach(function (p) {
      if (!p || !p[0] || map[p[0]] !== undefined) return;
      map[p[0]] = p[1];
      alts.push(String(p[0]));
    });
    if (!alts.length) return { body: body, counts: {} };
    alts.sort(function (a, b) { return b.length - a.length; });
    var counts = {};
    var re = new RegExp("(^|[^0-9])(" + alts.join("|") + ")(?=[^0-9]|$)", "g");
    var out = body.replace(re, function (m, pre, hit) {
      counts[hit] = (counts[hit] || 0) + 1;
      return pre + map[hit];
    });
    return { body: out, counts: counts };
  }

  // Same console as the content script (both log into the page), tagged so the
  // MAIN-world half of a run can be told apart.
  function log() {
    var d = new Date();
    var t = d.toTimeString().slice(0, 8) + "." + ("00" + d.getMilliseconds()).slice(-3);
    console.log.apply(console, ["[padel/net " + t + "]"].concat([].slice.call(arguments)));
  }

  function post(msg) {
    msg.__padel = "inject";
    try { window.postMessage(msg, "*"); } catch (e) { log("postMessage failed", String(e)); }
  }

  function classify(url) {
    if (!url) return null;
    if (url.indexOf(SLOTS) !== -1) return "slots";
    if (url.indexOf(SERVICE) !== -1 && url.indexOf(DEF) === -1) return "book";
    return null;
  }

  // ---- XHR hook ----
  var XO = XMLHttpRequest.prototype.open;
  var XS = XMLHttpRequest.prototype.send;
  var XH = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__pMethod = method;
    this.__pUrl = url;
    this.__pHeaders = {};
    return XO.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { this.__pHeaders[k] = v; } catch (e) { /* noop */ }
    return XH.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var kind = classify(this.__pUrl);
    if (kind === "book" && suppressActive() && !bookingTemplate) {
      captureBooking(this.__pUrl, this.__pMethod, this.__pHeaders, body);
      // Swallow the call we are here to capture: the page must never actually
      // book the sacrificial slot. Only the FIRST one — see below.
      log("SWALLOWED the page's booking XHR (nothing was booked)");
      return;
    }
    // Once a capture has been taken, stop swallowing. A second booking call
    // during the swallow window is a booking the user actually wants (the UI
    // grab, or a manual click), and eating it would silently lose the slot.
    if (kind === "book" && suppressActive()) {
      log("booking XHR passed through — capture already taken, this one is real");
    } else if (kind === "book") {
      log("page is sending its own booking XHR (real booking)");
    }
    if (kind === "slots") {
      template = {
        url: this.__pUrl,
        method: this.__pMethod || "POST",
        headers: this.__pHeaders || {},
        body: (typeof body === "string") ? body : null
      };
      post({ type: "captured" });
    }
    if (kind) {
      var self = this;
      // sentAt lets the content script ignore a booking result belonging to a
      // request that was already in flight before it started waiting — without
      // it, one job's response resolves the next job's wait and reports a
      // booking that never happened.
      var sentAt = Date.now();
      this.addEventListener("load", function () {
        var text = "";
        try { text = self.responseText || ""; } catch (e) { /* opaque */ }
        if (kind === "slots") {
          post({ type: "slots", status: self.status, body: text, replayed: false });
        } else {
          post({ type: "booking-result", status: self.status, body: text.slice(0, 800), sentAt: sentAt });
        }
      });
      this.addEventListener("error", function () {
        if (kind === "slots") post({ type: "slots", status: 0, body: "", error: "xhr-error" });
        else post({ type: "booking-result", status: 0, body: "", error: "xhr-error", sentAt: sentAt });
      });
    }
    return XS.apply(this, arguments);
  };

  // ---- fetch hook (belt & suspenders; the app currently uses XHR) ----
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var url = (input && input.url) ? input.url : input;
      var kind = classify(typeof url === "string" ? url : "");
      if (kind === "book" && suppressActive() && !bookingTemplate) {
        captureBooking(url, init && init.method, init && init.headers, init && init.body);
        return new Promise(function () {}); // swallowed; never settles
      }
      var p = origFetch.apply(this, arguments);
      if (kind) {
        p.then(function (res) {
          if (kind === "slots" && template === null) {
            template = {
              url: url,
              method: (init && init.method) || "POST",
              headers: (init && init.headers) || {},
              body: (init && typeof init.body === "string") ? init.body : null
            };
            post({ type: "captured" });
          }
          res.clone().text().then(function (t) {
            if (kind === "slots") post({ type: "slots", status: res.status, body: t, replayed: false });
            else post({ type: "booking-result", status: res.status, body: t.slice(0, 800) });
          }).catch(function () {});
        }).catch(function () {});
      }
      return p;
    };
  }

  // ---- replay command from content script ----
  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__padel !== "content") return;

    if (d.cmd === "replay") {
      // rid pairs each reply with its request: several replays can be in flight
      // at once (the radar plus the midnight verification), and without it the
      // first response to arrive resolves every waiter.
      var rid = d.rid || 0;
      if (!template) { post({ type: "slots", status: 0, body: "", replayed: true, rid: rid, note: "no-template" }); return; }
      var tSent = Date.now();
      // origFetch, so our own replay is not re-observed by the fetch hook
      // (which would double-post it and re-run detection on every response).
      (origFetch || fetch).call(window, template.url, {
        method: template.method,
        headers: template.headers,
        body: template.body,
        credentials: "include"
      }).then(function (r) {
        // `Date` is NOT a CORS-safelisted response header and this endpoint is
        // cross-origin, so this is usually null — see clock-probe for the
        // same-origin fallback that actually works.
        var dh = null;
        try { dh = r.headers.get("date"); } catch (e2) { dh = null; }
        return r.text().then(function (t) {
          post({ type: "slots", status: r.status, body: t, replayed: true, rid: rid, dateHeader: dh, tSent: tSent, tRecv: Date.now() });
        });
      }).catch(function (err) {
        post({ type: "slots", status: 0, body: "", replayed: true, rid: rid, error: String(err) });
      });
    } else if (d.cmd === "clock-probe") {
      // A same-origin request whose only purpose is a READABLE Date header, so
      // the rollover is scheduled on Google's clock instead of this machine's.
      var pSent = Date.now();
      (origFetch || fetch).call(window, location.origin + "/favicon.ico", { method: "GET", cache: "no-store" })
        .then(function (r) {
          var dh2 = null;
          try { dh2 = r.headers.get("date"); } catch (e3) { dh2 = null; }
          post({ type: "clock-sample", dateHeader: dh2, tSent: pSent, tRecv: Date.now(), status: r.status });
        }).catch(function (err) {
          post({ type: "clock-sample", dateHeader: null, tSent: pSent, tRecv: Date.now(), error: String(err) });
        });
    } else if (d.cmd === "suppress-booking-on") {
      suppress = { needle: d.needle || "", until: Date.now() + 20000 };
      // Each capture must be fresh — the reCAPTCHA token inside is short-lived
      // and single-use. Already-prepared jobs are left alone.
      bookingTemplate = null;
      log("swallow ARMED (booking calls will be captured, not sent)");
      post({ type: "suppress-ack", on: true });
    } else if (d.cmd === "suppress-extend") {
      if (suppress) suppress.until = Date.now() + (d.ttl || 60000);
      log("swallow extended by " + (d.ttl || 60000) + "ms");
    } else if (d.cmd === "suppress-booking-off") {
      if (suppress) log("swallow DISARMED (real bookings go through again)");
      suppress = null;
    } else if (d.cmd === "prepare-direct") {
      var id = d.id || "a";
      if (!bookingTemplate) {
        delete prepared[id];
        post({ type: "direct-prepared", id: id, ok: false, counts: [] });
        return;
      }
      var pairs = d.repl || [];
      var res = replaceAllNums(bookingTemplate.body, pairs);
      var counts = pairs.map(function (p) { return res.counts[p[0]] || 0; });
      // The start epoch must have been rewritten (otherwise we do not
      // understand this body at all) AND no sacrificial identifier may survive
      // anywhere in it. The second half is the real safety property: a body
      // that still names the sacrificial slot could book it instead of the
      // target. Anything else — a duration field we failed to find, an opaque
      // slot token — leaves a needle behind and we refuse to fire.
      var startHit = ((counts[0] || 0) + (counts[2] || 0)) >= 1;
      // Values the rewritten body is SUPPOSED to contain. A sacrificial id can
      // coincide with one of them — the target's start epoch equals the
      // sacrificial end epoch whenever the two slots are adjacent — and then
      // its presence is correct, not a leftover.
      var targetVals = {};
      pairs.forEach(function (p) { if (p) targetVals[String(p[1])] = true; });
      var leftovers = [];
      pairs.forEach(function (p) {
        var find = String(p[0]);
        if (targetVals[find]) return;
        if (new RegExp("(^|[^0-9])" + find + "(?=[^0-9]|$)").test(res.body)) leftovers.push(find);
      });
      var okPrep = startHit && !leftovers.length;
      if (okPrep) prepared[id] = { url: bookingTemplate.url, method: bookingTemplate.method, headers: bookingTemplate.headers, body: res.body };
      else delete prepared[id];
      log("prepare-direct[" + id + "]: " + (okPrep ? "OK" : "FAILED — " +
            (!startHit ? "start epoch not found in body" : "sacrificial ids still present: " + leftovers.join(","))) +
          ", replacements per pattern = [" + counts.join(",") + "], armed jobs now: [" + Object.keys(prepared).join(",") + "]");
      // Consumed: the next job must capture its own token rather than reuse it.
      bookingTemplate = null;
      post({ type: "direct-prepared", id: id, ok: okPrep, counts: counts, leftovers: leftovers });
    } else if (d.cmd === "arm-fire") {
      // MAIN and ISOLATED worlds share ONE thread, and postMessage delivery
      // costs an event-loop turn — a "fire now" message would have to queue
      // behind whatever the Calendar app happens to be rendering at midnight.
      // So take the deadline ahead of time and fire from our own timer: then
      // the only requirement at T+0 is that the thread is free.
      var ids = (d.ids || []).slice();
      var at = +d.at || 0;
      if (!ids.length || !at) { log("arm-fire ignored (no ids or no deadline)"); return; }
      var myFireGen = ++fireGen;
      log("arm-fire: [" + ids.join(",") + "] in " + (at - Date.now()) + "ms");
      setTimeout(function () {
        // Disarmed (or re-armed) in the meantime — the content script owns that
        // decision, and a shot nobody asked for would book against the user.
        if (myFireGen !== fireGen) { log("fire[" + ids.join(",") + "] cancelled"); return; }
        // Late (throttled tab, machine asleep) is NOT a reason to hold back:
        // a stale token just gets rejected, while not firing guarantees no
        // booking. Only give up past the reCAPTCHA TTL, where it cannot work.
        // Double-booking is not a concern here — a completed booking flips the
        // state, and every state change sends cancel-fire.
        var late = Date.now() - at;
        if (late > TOKEN_TTL_MS) {
          log("fire skipped: " + (late / 1000).toFixed(1) + "s late, past the token TTL (tab throttled or machine asleep?)");
          return;
        }
        if (late > 200) log("fire is " + late + "ms LATE — sending anyway");
        // Busy-wait the last few ms: a timer can be late by more than that,
        // and nothing may preempt us between here and the send.
        while (Date.now() < at) { /* spin */ }
        ids.forEach(function (id) { firePrepared(id); });
      }, Math.max(0, at - Date.now() - FIRE_SPIN_MS));
    } else if (d.cmd === "cancel-fire") {
      if (fireGen) log("pending fire cancelled");
      fireGen++;
    } else if (d.cmd === "direct-book") {
      firePrepared(d.id || "a");
    } else if (d.cmd === "ping") {
      post({ type: "pong", hasTemplate: !!template });
    }
  });

  log("net hooks installed (XHR + fetch) at document_start");
  post({ type: "ready" });
})();
