// background.js — service worker. Turns content-script requests into desktop
// notifications. The default (non-silent) notification plays the system sound,
// which is enough to wake you for a captcha.
// Logs land in the service worker console (chrome://extensions -> this
// extension -> "service worker"). The engine's own logs are in the calendar
// tab's console.
function log() {
  var d = new Date();
  var t = d.toTimeString().slice(0, 8) + "." + ("00" + d.getMilliseconds()).slice(-3);
  console.log.apply(console, ["[padel bg " + t + "]"].concat([].slice.call(arguments)));
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== "notify") return;
  log("notification:", msg.title, "|", msg.message);
  chrome.notifications.create("padel-" + Date.now(), {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: msg.title || "Padel Slot Sniper",
    message: msg.message || "",
    priority: 2,
    requireInteraction: !!msg.sound, // keep important alerts on screen
    silent: false
  });
});

// Google's own millisecond clock — the endpoint Chrome's network-time service
// uses. A Date header only has whole seconds; this has ms, so one sample pins
// the server offset to within its round trip (±~20ms here vs ±73-97ms from
// Date headers). It sends no CORS headers, so only this service worker (with
// the host permission) can read it, not the page.
var TIME_URL = "https://clients2.google.com/time/1/current";
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== "time-probe") return;
  var n = Math.max(1, Math.min(10, +msg.n || 4));
  (async function () {
    var out = [];
    // Back to back on one connection: the first sample pays the handshake,
    // the later ones are the tight ones.
    for (var i = 0; i < n; i++) {
      var tSent = Date.now();
      try {
        var r = await fetch(TIME_URL, { cache: "no-store", credentials: "omit" });
        var txt = await r.text();
        var tRecv = Date.now();
        var m = txt.match(/"current_time_millis"\s*:\s*(\d+)/);
        if (!m) { out.push({ error: "no time in reply (HTTP " + r.status + ")" }); break; }
        out.push({ tSent: tSent, tRecv: tRecv, server: +m[1] });
      } catch (e) {
        out.push({ error: String(e) });
        break;
      }
    }
    sendResponse({ samples: out });
  })();
  return true;   // answer asynchronously
});

// Clicking a notification focuses the calendar tab if we can find it.
chrome.notifications.onClicked.addListener(function () {
  log("notification clicked — focusing the calendar tab");
  chrome.tabs.query({ url: "https://calendar.google.com/calendar/*/appointments/schedules/*" }, function (tabs) {
    if (tabs && tabs[0]) {
      chrome.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId != null) chrome.windows.update(tabs[0].windowId, { focused: true });
    }
  });
});
