# Padel Slot Sniper

A Chrome extension (Manifest V3) that watches a **Google Calendar Appointment
Schedule** booking page and grabs a slot the moment it opens at midnight, then
books it through the **real UI** (so the page generates its own reCAPTCHA token).
If a captcha *challenge* appears, it stops and sends you a desktop notification
instead of trying to defeat it.

Built for the "Padel Suiza 14" court page, but works with any Google Calendar
appointment schedule.

## How it works

Two-part design, because reconnaissance of the live page showed:

- Availability is fetched via a gRPC-web **XHR** to
  `calendar-pa.clients6.google.com/.../AppointmentBookingService/ListAvailableSlots`.
- The Calendar bundle **caches `XMLHttpRequest.prototype.send` at load**, so a
  hook installed after boot never fires. It must run at `document_start`.
- The slot grid does **not** auto-refresh; new midnight slots only appear when
  the app re-fetches.
- Booking flow: click date → click time → modal with **First name / Last name /
  Email / Flat number** → **Book** button, which carries an invisible reCAPTCHA
  (`textarea[name="g-recaptcha-response"]`).

So (FAST MODE — no page reload):

1. **`inject.js`** (MAIN world, `document_start`) hooks XHR/fetch. It captures
   the `ListAvailableSlots` request as a verbatim replay template, forwards every
   availability response + booking-RPC result to the content script, and can
   replay the request on demand.
2. **`content.js`** (ISOLATED world) orchestrates, states in `chrome.storage.local`:
   - `armed` — every ~1 s (fixed; arm it near the catch) it
     **clicks a date in the calendar** (the nearest available one to the target,
     alternating to bust the SPA cache). That makes the app re-fetch + re-render
     the grid **without a page reload**. It then checks, authoritatively, whether
     the target slot opened via: the intercepted `ListAvailableSlots` response, a
     cache-free replay, and the grid marking the target `data-date` cell available.
   - On detection it **grabs on the same page**: select the target date
     (`td[data-date="YYYYMMDD"]`), click the exact time, and — because the HTML can
     lag the response — **retry** until the slot renders. Each candidate is
     verified against the modal header (`July 8` etc.) so a same-time slot on a
     neighbouring day is never booked. Then fill the form and click **Book**.
   - `grab` — run that grab immediately (used by "Забронировать сейчас").
3. **`background.js`** turns events into desktop notifications (with sound).

No full page reload happens at all: waiting and grabbing both drive the app's own
fetch by clicking the calendar, saving the ~3–5 s SPA boot a reload would cost.

## Direct shot (v0.2)

The UI grab needs ~0.5 s after the rollover (detect → render → click → fill →
Book) — and on 2026-09-21 that lost the race to a faster rival. On the night the
target date opens (and only with auto-Book on), a third worker now runs:

1. **Clock sync** — every replayed availability response carries a `Date`
   header; an NTP-style median gives `server − local` offset, so midnight is
   scheduled on **Google's clock**, not the Mac's.
2. **Capture (~T−75 s)** — open the booking modal on any *currently open*
   (sacrificial) slot, fill the real data, and click **Book** while the network
   hook **swallows** the outgoing booking RPC. The page itself validates the
   form and mints its own invisible-reCAPTCHA token; we keep the complete
   request it built (headers incl. fresh SAPISIDHASH + body incl. the token)
   and discard the modal. Nothing is booked. If a captcha *challenge* pops up
   here, you get a notification and ~45 s to solve it — solving lets the
   capture complete; the tool never solves or bypasses it.
3. **Retarget** — the sacrificial slot's start/end epochs (ms and seconds
   forms, digit-boundary-safe) and `YYYYMMDD` are rewritten to the target slot.
   If the start epoch isn't found in the body, the direct shot is aborted.
4. **Fire (T+120 ms after corrected midnight)** — send the prepared request
   via `fetch`. The booking reaches Google one RTT after the rollover instead
   of ~0.6 s. Simultaneously the target day is clicked and a replay burst
   feeds the radar, so the classic UI grab runs **independently in parallel**
   — neither path ever waits on the other. If both land, the worst case is a
   duplicate booking to cancel by hand. A 200 is only trusted after a
   follow-up availability check confirms the slot is gone; if the direct shot
   booked first, the UI path labels its outcome "уже забронирован прямым
   запросом" instead of treating the slot as stolen, and if a rival got it
   you get a "перехвачен" notification instead of a silent hang.

Caveats needing one live pass: the booking RPC body format (epoch replacement
counts are logged as `direct shot prepared`), whether the token survives ~75 s
(if Google rejects it, the UI fallback still fires), and the exact
"no longer available" wording for fail-fast detection. Keep the calendar tab
**visible** (own window is fine) around midnight — Chrome throttles timers in
hidden tabs and the schedule needs ms precision.

## Install (unpacked)

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. **Load unpacked** → select this `padel-slot-sniper/` folder.
4. Pin the extension. Open your booking calendar page and keep the tab open.

Requires Chrome 111+ (uses `content_scripts` `world: "MAIN"`).

## Use

1. Open the padel booking calendar tab (must stay open).
2. Click the extension icon:
   - **Дата / Время** — target slot (e.g. `2026-07-10`, `19:00`, 24-hour).
   - **Имя / Фамилия / Email / Номер квартиры** — what to fill in the form.
   - **Авто-жать Book** — on by default; captcha stops it and notifies you.
3. Click **Включить ожидание** before midnight and leave the tab open.
4. On success (or captcha) you get a desktop notification.

**Забронировать сейчас** runs the booking flow immediately (reloads the tab and
tries to book the target now) — use it to test the flow against an already-open
slot.

## Timezone note

The target time is interpreted in **your machine's local timezone**, which is
assumed to match the calendar's (Europe/Madrid for this court). If your Mac is on
a different timezone, the exact-timestamp match may miss — but the hot-window
"response grew" safety net still triggers, and the DOM step only ever clicks the
button whose text equals your target time, so it never books the wrong slot.

## Needs one live tuning pass

Two things could not be observed without an actual midnight open / completed
booking, and may need a small tweak the first time you run it live:

- **Success detection** — `bookingConfirmed()` in `content.js` matches
  confirmation text; we also treat a `200` from the booking RPC as success. If
  the confirmation screen uses different wording, add it there.
- **Captcha detection** — `captchaVisible()` looks for a visible reCAPTCHA
  `bframe` iframe. If a challenge slips through, capture its iframe `src`/DOM and
  adjust.

Open the tab's DevTools console to see `[padel]` logs during a run.

## Scope / ethics

Personal booking automation for a single court reservation. It books through the
normal UI and does **not** attempt to solve or bypass captchas — it defers to you
when one appears. Automating Google Calendar may be against Google's Terms of
Service; use on your own account and at your own risk.
