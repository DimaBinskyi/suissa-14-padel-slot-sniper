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
