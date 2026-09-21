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

  var FIRE_SPIN_MS = 6;   // busy-wait tail that absorbs timer lateness
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
    var p = fetch(req.url, {
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

  // Replace a number/date string only at non-digit boundaries, so an epoch is
  // never rewritten inside a longer number.
  function replaceNum(body, find, repl) {
    var n = 0;
    var re = new RegExp("(^|[^0-9])" + find + "(?=[^0-9]|$)", "g");
    var out = body.replace(re, function (m, pre) { n++; return pre + repl; });
    return { body: out, n: n };
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
    if (kind === "book" && suppressActive()) {
      captureBooking(this.__pUrl, this.__pMethod, this.__pHeaders, body);
      // Swallow EVERY booking-service call while capture is armed: the page
      // must never actually book the sacrificial slot.
      log("SWALLOWED the page's booking XHR (nothing was booked)");
      return;
    }
    if (kind === "book") log("page is sending its own booking XHR (real booking)");
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
      this.addEventListener("load", function () {
        var text = "";
        try { text = self.responseText || ""; } catch (e) { /* opaque */ }
        if (kind === "slots") {
          post({ type: "slots", status: self.status, body: text, replayed: false });
        } else {
          post({ type: "booking-result", status: self.status, body: text.slice(0, 800) });
        }
      });
      this.addEventListener("error", function () {
        post({ type: kind === "slots" ? "slots" : "booking-result", status: 0, body: "", error: "xhr-error" });
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
      if (kind === "book" && suppressActive()) {
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
      if (!template) { post({ type: "slots", status: 0, body: "", replayed: true, note: "no-template" }); return; }
      var tSent = Date.now();
      fetch(template.url, {
        method: template.method,
        headers: template.headers,
        body: template.body,
        credentials: "include"
      }).then(function (r) {
        // The Date header lets the content script sync to GOOGLE's clock: the
        // midnight rollover happens on the server's time, not this machine's.
        var dh = r.headers.get("date");
        return r.text().then(function (t) {
          post({ type: "slots", status: r.status, body: t, replayed: true, dateHeader: dh, tSent: tSent, tRecv: Date.now() });
        });
      }).catch(function (err) {
        post({ type: "slots", status: 0, body: "", replayed: true, error: String(err) });
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
      if (!bookingTemplate) { post({ type: "direct-prepared", id: id, ok: false, counts: [] }); return; }
      var pb = bookingTemplate.body, counts = [];
      (d.repl || []).forEach(function (pair) {
        var r2 = replaceNum(pb, pair[0], pair[1]);
        pb = r2.body;
        counts.push(r2.n);
      });
      // counts[0]/[2] are the start epoch in ms/seconds form — one must have hit,
      // otherwise we don't understand the body and must not fire it.
      var okPrep = ((counts[0] || 0) + (counts[2] || 0)) >= 1;
      if (okPrep) prepared[id] = { url: bookingTemplate.url, method: bookingTemplate.method, headers: bookingTemplate.headers, body: pb };
      else delete prepared[id];
      log("prepare-direct[" + id + "]: " + (okPrep ? "OK" : "FAILED — start epoch not found in body") +
          ", replacements per pattern = [" + counts.join(",") + "], armed jobs now: [" + Object.keys(prepared).join(",") + "]");
      // Consumed: the next job must capture its own token rather than reuse it.
      bookingTemplate = null;
      post({ type: "direct-prepared", id: id, ok: okPrep, counts: counts });
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
        // Machine slept, or the tab was frozen straight through the rollover:
        // the slot situation is no longer what the request was built for.
        if (Date.now() > at + 5000) {
          log("fire skipped: " + (Date.now() - at) + "ms late (tab throttled or machine asleep?)");
          return;
        }
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
