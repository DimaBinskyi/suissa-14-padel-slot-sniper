# Handoff: Padel Slot Sniper — Chrome extension auto-booking Google Calendar padel slots

## Session Metadata
- Created: 2026-07-07 13:55:38
- Project: /Users/admin/Documents/dev/padel-slot-sniper
- Branch: not a git repo (dev/ is not under git; project is a plain folder)
- Session duration: ~1 full session (design → build → live DOM test → UI polish)

### Recent Commits (for context)
  - none (not a git repo)

## Handoff Chain

- **Continues from**: None (fresh start)
- **Supersedes**: None

> First handoff for this task.

## Current State Summary

Built a complete Manifest V3 Chrome extension that watches a Google Calendar
Appointment Schedule (the "Padel Suiza 14" court booking page) and, when a slot
opens at midnight, books it automatically through the real UI. All code is
written and syntax-valid. The DOM booking logic (date pick → time match → form
fill → locate Book) was **validated live** against the real page via browser
automation, stopping at Cancel/Discard — **no real booking was ever submitted**.
UI is finalized: date as day/month/year dropdowns, time as a dropdown of the 9
court slots, read-only calendar link with an "open in active tab" button, and a
custom racket+ball icon. **Not yet loaded into a real Chrome**, and three things
remain unverifiable without an actual booking: the real Book click, captcha
challenge detection, and success detection.

## Codebase Understanding

## Architecture Overview

MV3 extension, state machine persisted in `chrome.storage.local` under `state`
(`idle` | `armed` | `booking`) plus `cfg` (config) and `status` (UI text).

- **inject.js** (MAIN world, `run_at: document_start`): hooks XHR + fetch BEFORE
  the Calendar bundle boots, captures the `ListAvailableSlots` gRPC-web request as
  a verbatim replay template, replays it on demand ("radar B"), and posts every
  availability response + booking-RPC result to content.js via `window.postMessage`.
- **content.js** (ISOLATED world): orchestrator. When `armed`, polls by asking
  inject to replay `ListAvailableSlots` (no reload); slow 15s cadence, 2.5s in the
  midnight hot-window. On detecting the target slot it flips to `booking` and does
  **one** `location.reload()`. On the fresh load it drives the DOM: navigate month
  → click date → click exact time → fill form → click Book → race captcha vs success.
- **background.js**: service worker turning content messages into
  `chrome.notifications` (with sound).
- **popup.***: config UI over chrome.storage.

## Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| manifest.json | MV3 config; 2 content scripts (MAIN + ISOLATED); `host_permissions: calendar.google.com` | High |
| src/inject.js | MAIN-world XHR/fetch hook; capture + replay ListAvailableSlots; post to content | High |
| src/content.js | Orchestrator: poll, month/date/slot selection, form fill, Book, captcha/success detection | **Highest** |
| src/popup.html / popup.js / popup.css | Config UI: date dd/mm/yyyy, time dropdown, info fields, read-only calendar link, toggle | High |
| src/background.js | chrome.notifications relay | Medium |
| README.md | Full architecture + install + "needs live tuning" notes | High |
| icons/icon{16,48,128}.png | Racket+ball on teal (rgb 13,148,136) | Low |

### Key Patterns Discovered (reconnaissance of the live page)

- Availability = gRPC-web **XHR** `ListAvailableSlots` on
  `calendar-pa.clients6.google.com/$rpc/google.internal.calendar.v1.AppointmentBookingService/ListAvailableSlots`
  (a **public** API key is embedded in the request URL — not a secret; do not treat as one).
- The Calendar bundle **caches `XMLHttpRequest.prototype.send` at load**, so a hook
  installed after boot never fires — MUST be MAIN world + `document_start`. Verified:
  post-hoc hooks (fetch and XHR) captured nothing; performance timing confirmed XHR.
- Date buttons: `aria-label` like `"8, Wednesday"` (available) vs
  `"9, Thursday, no available times"` (none) vs `"7, Tuesday, today"`.
- Slot buttons: visible text like `"7:00pm"` / `"8:30am"`. Parse to minutes-since-midnight
  and match the target time; **booking is gated on an exact time match** → it can
  never book the wrong slot even if the radar over-fires.
- Booking modal fields, in order: `input[type=text]` (First), `input[type=text]`
  (Last), `input[type=email]` (Email), `textarea` (Flat). IDs are dynamic (`c12`…),
  so select by **type + order within `[role=dialog]`** (the form also renders a
  hidden duplicate set — scope to the visible dialog).
- **Invisible reCAPTCHA** on Book: `textarea[name="g-recaptcha-response"]` present.
  A challenge shows as a **visible reCAPTCHA `bframe` iframe** (detector in `captchaVisible()`).
- Clicking **Cancel** on a *filled* form pops a "Discard unsaved changes?" dialog
  (irrelevant to our flow — we click Book, not Cancel).
- Synthetic `.click()` works on these Material buttons (verified on date/slot/cancel).
- Court's 90-min slot set: `8:30am,10:00am,11:30am,1:00pm,2:30pm,4:00pm,5:30pm,7:00pm,8:30pm`
  = values `08:30,10:00,11:30,13:00,14:30,16:00,17:30,19:00,20:30`.
- **Rolling window**: at 00:00 exactly one new day (tomorrow) opens; can't book further ahead.

## Work Completed

### Tasks Finished

- [x] Live reconnaissance of the booking page (endpoint, DOM, form fields, captcha).
- [x] Full MV3 extension built (manifest, inject, content, background, popup, icons, README).
- [x] Popup UI: date = day/month/year dropdowns; time = dropdown of the 9 slots;
      autosave to storage on input; init guarded by `document.readyState` (not just DOMContentLoaded).
- [x] Read-only ("зафиксирована") calendar link + "Открыть календарь" opens it in the
      **active tab** (`chrome.tabs.update`); added `host_permissions` for calendar.google.com.
- [x] Custom racket+ball icon (canvas-generated PNGs, 16/48/128) on the original teal bg.
- [x] Live-validated the DOM booking logic end-to-end minus the final submit
      (date pick, time parse+match incl. safe skip of an unavailable 19:00, form
      fill with test data, Book button located) → closed via Discard, no booking.
- [x] Memory updated: `padel-slot-sniper-project.md` + MEMORY.md index line.

## Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| manifest.json | MV3; MAIN+ISOLATED content scripts; host_permissions | Core extension config + tab access |
| src/inject.js | XHR/fetch capture + replay of ListAvailableSlots | Radar B without reloads; must run at document_start |
| src/content.js | Full orchestrator + DOM booking + detection | Heart of the tool |
| src/popup.html/js/css | dd/mm/yyyy date, slot dropdown, read-only link + open button, autosave, readyState init | User-requested UI |
| src/background.js | chrome.notifications | Desktop alerts (success/captcha) |
| icons/icon{16,48,128}.png | Racket+ball on teal | User-requested icon |
| README.md | Full docs incl. live-tuning caveats | Onboarding |

## Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Separate project (NOT inside padel-reservas) | inside vs separate | User explicitly required separation |
| Radar B = replay endpoint; book via UI | raw booking request vs UI | Booking request carries reCAPTCHA token/anti-bot params; UI mints them natively |
| Single reload only at detection | reload-poll (A) vs endpoint-poll (B) | Honors "don't constantly reload" while booking against fresh DOM |
| Target by specific date + time | weekday+time vs date vs both | User chose specific date+time |
| Desktop chrome.notifications (with sound) | native vs Telegram | User chose desktop; zero setup |
| Auto-click Book; captcha → stop+notify | auto vs manual | User chose auto; never bypass captcha |
| Date via 3 dropdowns (day/month/year) | native date input vs dropdowns | Native `<input type=date>` display order is locale-locked (showed MM/DD); dropdowns are unambiguous |
| Calendar URL read-only, fixed | editable vs fixed | User requested it be non-editable; constant `DEFAULT_URL` in popup.js |

## Pending Work

## Immediate Next Steps

1. **Load unpacked in real Chrome** (`chrome://extensions` → Developer mode → Load
   unpacked → this folder). Verify popup populates (date selects fill, saved cfg
   restores), the read-only link shows the URL, and "Открыть календарь" navigates
   the active tab. Requires Chrome 111+ (content_scripts `world: MAIN`).
2. **Real single-booking test**: open the calendar, fill data, hit "Забронировать
   сейчас" on an actually-available slot to click Book once. Capture the
   confirmation-screen DOM/wording and confirm `bookingConfirmed()` and/or the
   booking-RPC 200 path fire. Adjust `bookingConfirmed()` text matches if needed.
3. **If a captcha challenge appears**, capture the `bframe` iframe `src`/DOM and
   verify/tune `captchaVisible()`.
4. **Real armed midnight run**: confirm the replay-based detection (`targetOpen()`
   epoch match + hot-window growth safety net) triggers; tune if it misses.

### Blockers/Open Questions

- [ ] Cannot test the actual Book submit / captcha / success without a real booking;
      the extension can't be loaded into the cmux WKWebView browser — needs real Chrome.
- [ ] `bookingConfirmed()` (success text) and `captchaVisible()` (challenge iframe)
      are unverified against the real post-Book DOM.
- [ ] Timezone assumption (see below) — epoch match may miss if machine TZ ≠ Madrid.

### Deferred Items

- Optional "target = tomorrow (auto)" mode to auto-fill the date for the rolling
  window — offered to the user, awaiting their decision.

## Context for Resuming Agent

## Important Context

- **The extension books via the real UI and does NOT bypass captcha** — it defers to
  the user (stop + desktop notification) when a challenge appears. Keep this ethic.
- **State machine** (`chrome.storage.local`): popup writes `state`/`cfg`; content
  reacts via `storage.onChanged` and on load via `boot()`. `booking` state survives
  the single reload — content re-runs on the fresh page and continues the flow.
- **To change the court/calendar**: edit the `DEFAULT_URL` constant at the top of
  `src/popup.js` (the link is read-only in the UI by design).
- **Never books the wrong slot**: the final action clicks only the slot button whose
  parsed time equals the target; if absent after reload, it returns to polling.
- Chat in Russian, code/docs in English (see memory `comms-language`).

## Assumptions Made

- Page UI is in **English** (month header `"July 2026"`, button text `"Book"`).
  `bookButton()` also matches `Reservar`/`Забронировать`; month parsing assumes
  English month names — localized UI would need selector updates.
- Machine timezone == calendar timezone (**Europe/Madrid**, GMT+2 in summer). The
  epoch-substring detection builds the target time in local time. A mismatch is
  mitigated by the hot-window "response grew" safety net + the exact-time DOM gate.

## Potential Gotchas

- **Do not hammer the page with many automated reloads from one tab** — during
  testing Google started returning empty pages (throttle); a fresh tab recovered.
  The extension's gentle poll + single reload avoids this, but keep it in mind when
  testing manually.
- The **cmux browser is WKWebView**: no network interception (used `performance` +
  eval hooks instead), eval races right after `goto` (binds to old document), and
  `chrome.*` is undefined in `file://` previews so `popup.js` `restore()` no-ops
  there — that's a preview artifact only; production is fine.
- The booking form renders a **hidden duplicate** input set; always scope to the
  visible `[role=dialog]` (content.js does via `dialogScope()`).
- Popup init is `readyState`-guarded — don't revert it to a bare
  `DOMContentLoaded` listener, or selects may not build if the script runs late.

## Environment State

### Tools/Services Used

- cmux browser automation (WKWebView) for live reconnaissance + DOM-logic testing.
- Target Chrome MV3 (Chrome 111+ for `world: "MAIN"`).
- Python3 used to generate icon PNGs (pure zlib initially, then canvas via browser).

### Active Processes

- cmux browser surfaces left open (preview only, safe to close):
  - surface:17 — calendar tab (may be in a throttled/blank state)
  - surface:18 — `file://` popup preview
  - surface:19 — working calendar tab (last used for the DOM test)

### Environment Variables

- None required by the extension. No secrets involved. (Config lives in
  `chrome.storage.local`; the calendar URL is a public shareable booking link.)

## Related Resources

- README.md — full architecture, install, and "needs one live tuning pass" section.
- Auto-memory: `padel-slot-sniper-project.md` (status + recon facts), MEMORY.md index,
  `comms-language`, `padel-reservas-project` (the separate PWA — do NOT merge into it).
- Live booking page: the public appointment-schedule URL stored as `DEFAULT_URL` in
  `src/popup.js` (`…/appointments/schedules/AcZssZ10yTRRi6q…`).
- Test data the user provided: name "Dima"/"K.", email dimabinskyi@gmail.com, flat 86.

---

**Security Reminder**: No secrets included. The Google API key seen in the page's
network calls is a public client key and was intentionally NOT copied here.
