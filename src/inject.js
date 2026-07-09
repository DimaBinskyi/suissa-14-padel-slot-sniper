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
      fetch(template.url, {
        method: template.method,
        headers: template.headers,
        body: template.body,
        credentials: "include"
      }).then(function (r) {
        return r.text().then(function (t) {
          post({ type: "slots", status: r.status, body: t, replayed: true });
        });
      }).catch(function (err) {
        post({ type: "slots", status: 0, body: "", replayed: true, error: String(err) });
      });
    } else if (d.cmd === "ping") {
      post({ type: "pong", hasTemplate: !!template });
    }
  });

  post({ type: "ready" });
})();
