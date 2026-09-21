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
  // preparedRequest, which direct-book fires verbatim at midnight.
  var bookingTemplate = null;
  var preparedRequest = null;
  var suppress = null;          // { needle, until }

  function suppressActive() {
    // Dead-man switch: if the content script dies mid-capture, a stuck
    // suppress would swallow the user's REAL booking clicks forever.
    if (suppress && Date.now() > suppress.until) suppress = null;
    return !!suppress;
  }

  function captureBooking(url, method, headers, body) {
    if (typeof body !== "string" || bookingTemplate) return;
    if (suppress.needle && body.indexOf(suppress.needle) === -1) return;
    bookingTemplate = { url: url, method: method || "POST", headers: headers || {}, body: body };
    post({ type: "booking-captured", ok: true });
  }

  // Replace a number/date string only at non-digit boundaries, so an epoch is
  // never rewritten inside a longer number.
  function replaceNum(body, find, repl) {
    var n = 0;
    var re = new RegExp("(^|[^0-9])" + find + "(?=[^0-9]|$)", "g");
    var out = body.replace(re, function (m, pre) { n++; return pre + repl; });
    return { body: out, n: n };
  }

  function post(msg) {
    msg.__padel = "inject";
    try { window.postMessage(msg, "*"); } catch (e) { /* noop */ }
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
      return;
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
      // and single-use.
      bookingTemplate = null;
      preparedRequest = null;
      post({ type: "suppress-ack", on: true });
    } else if (d.cmd === "suppress-extend") {
      if (suppress) suppress.until = Date.now() + (d.ttl || 60000);
    } else if (d.cmd === "suppress-booking-off") {
      suppress = null;
    } else if (d.cmd === "prepare-direct") {
      if (!bookingTemplate) { post({ type: "direct-prepared", ok: false, counts: [] }); return; }
      var pb = bookingTemplate.body, counts = [];
      (d.repl || []).forEach(function (pair) {
        var r2 = replaceNum(pb, pair[0], pair[1]);
        pb = r2.body;
        counts.push(r2.n);
      });
      // counts[0]/[2] are the start epoch in ms/seconds form — one must have hit,
      // otherwise we don't understand the body and must not fire it.
      var okPrep = ((counts[0] || 0) + (counts[2] || 0)) >= 1;
      preparedRequest = okPrep ? { url: bookingTemplate.url, method: bookingTemplate.method, headers: bookingTemplate.headers, body: pb } : null;
      post({ type: "direct-prepared", ok: okPrep, counts: counts });
    } else if (d.cmd === "direct-book") {
      if (!preparedRequest) { post({ type: "direct-book-result", status: 0, body: "", error: "not-prepared" }); return; }
      fetch(preparedRequest.url, {
        method: preparedRequest.method,
        headers: preparedRequest.headers,
        body: preparedRequest.body,
        credentials: "include"
      }).then(function (r) {
        return r.text().then(function (t) {
          post({ type: "direct-book-result", status: r.status, body: t.slice(0, 800) });
        });
      }).catch(function (err) {
        post({ type: "direct-book-result", status: 0, body: "", error: String(err) });
      });
    } else if (d.cmd === "ping") {
      post({ type: "pong", hasTemplate: !!template });
    }
  });

  post({ type: "ready" });
})();
