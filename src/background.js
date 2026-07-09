// background.js — service worker. Turns content-script requests into desktop
// notifications. The default (non-silent) notification plays the system sound,
// which is enough to wake you for a captcha.
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== "notify") return;
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

// Clicking a notification focuses the calendar tab if we can find it.
chrome.notifications.onClicked.addListener(function () {
  chrome.tabs.query({ url: "https://calendar.google.com/calendar/*/appointments/schedules/*" }, function (tabs) {
    if (tabs && tabs[0]) {
      chrome.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId != null) chrome.windows.update(tabs[0].windowId, { focused: true });
    }
  });
});
