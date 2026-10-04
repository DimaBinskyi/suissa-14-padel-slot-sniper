# Padel Slot Sniper

A Chrome extension (Manifest V3) for a **Google Calendar Appointment Schedule**
booking page. At the midnight a date opens, it fires a booking request it
captured from the page itself ~30 s earlier — the booking reaches Google one
round-trip after the rollover. If a captcha *challenge* appears during the
capture, it stops and sends you a desktop notification instead of trying to
defeat it.

Built for the "Padel Suiza 14" court page, but works with any Google Calendar
appointment schedule.

**Direct shot only (v0.4).** There is no UI booking path any more — no radar,
no click-through-the-grid fallback, no "book now" button. If the shot misses,
nothing else books; the popup tells you exactly what the server answered.

## What the live page looks like

- Availability is fetched via a gRPC-web **XHR** to
  `calendar-pa.clients6.google.com/.../AppointmentBookingService/ListAvailableSlots`.
- Booking is
  `.../google.internal.calendar.v1.AppointmentBookingService/BookSlot` (note the
  **dot** before the service name). Its body carries `[[<startEpochSeconds>], 90]`
  — a start epoch in **seconds** plus a duration in minutes. Auth rides on
  cookies, which is why the shot needs `credentials: "include"`.
- The Calendar bundle **caches `XMLHttpRequest.prototype.send` at load**, so a
  hook installed after boot never fires. It must run at `document_start`.
- Booking modal: **First name / Last name / Email / Flat number** → **Book**,
  which carries an invisible reCAPTCHA. The page mints the token itself.

## How it works

1. **`inject.js`** (MAIN world, `document_start`) hooks XHR/fetch. It keeps the
   `ListAvailableSlots` request as a replay template, swallows the page's own
   `BookSlot` request during a capture, and fires prepared requests on a
   deadline.
2. **`content.js`** (ISOLATED world) orchestrates. States in `chrome.storage.local`:
   `idle` and `armed`. While armed:
   - **Waiting** — keep an open day parked in view (the capture needs a slot
     button on screen) and force one app fetch every ~35 s so the replay
     template's time-bound credentials stay fresh.
   - **Clock sync** — `Date` headers from a same-origin probe give an NTP-style
     `server − local` offset; midnight is scheduled on that estimate.
   - **Capture (T−20 s, +12 s per extra slot)** — open the booking modal on any
     *currently open* (sacrificial) slot, fill the real data, and click **Book**
     while the hook **swallows** the outgoing request. We keep the complete
     request the page built (headers + body incl. the fresh token). Nothing is
     booked. A captcha challenge here notifies you and waits for whatever time
     remains; the tool never solves or bypasses it.
   - **Retarget** — the sacrificial slot's epochs (ms and seconds forms,
     digit-boundary-safe, single pass) and `YYYYMMDD` are rewritten to the
     target. Any sacrificial id left in the body aborts that shot.
   - **Fire (corrected midnight + 120 ms)** — all prepared requests leave in the
     same tick.
   - **Report** — a 200 counts as a win only once an availability replay shows
     the slot gone. Each slot's verdict, HTTP status, send time and the server's
     answer go to the popup status, a notification, and `lastShot` in storage.
     Then the extension disarms.
3. **`background.js`** turns events into desktop notifications (with sound).

A date that is already bookable (or whose midnight has passed) is refused at
arm time: the shot only exists at the rollover that opens it.

## Two slots at once

Tick **«Вторая бронь»** in the popup to book two times on the same date at one
midnight, each with its own profile. A rollover opens exactly one new day, so
both jobs share the date. Captures are sequential (one modal in the DOM, and a
reCAPTCHA token is single-use), so the second one starts 12 s earlier —
`T−32 s` for two slots. At the rollover both requests leave together.

The schedule accepts two bookings for the same date from one session
(2026-08-09: 20:30 and 16:00 both booked with one email).

## Install (unpacked)

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. **Load unpacked** → select this `padel-slot-sniper/` folder.
4. Pin the extension. Open your booking calendar page and keep the tab open.

Requires Chrome 111+ (uses `content_scripts` `world: "MAIN"`).

**After an update:** reload the extension, then **reload the calendar tab** — an
open tab keeps running the engine it was loaded with. The popup shows the
extension version next to its title and, underneath, the version the calendar
tab is running (`Вкладка календаря: v0.4.0 ✓`). If they differ, reload the tab.

## Use

1. Open the padel booking calendar tab (must stay open and **visible** around
   midnight — Chrome throttles timers in hidden tabs).
2. Click the extension icon, set **Дата** (the date that opens at the coming
   midnight, i.e. today + 2), **Время** and the profile(s).
3. Click **Включить ожидание** any time before ~T−40 s.
4. After the shot you get a notification and a per-slot report in the popup, e.g.
   `❌ 20:30 (Pavlo): слот заняли раньше нас (HTTP 400, отправлен T+0.154s, ответ за 90мс): …`

`отправлен T+…` is measured against midnight on **this Mac's** clock (NTP-synced),
not the corrected estimate — it is the number to compare across nights.

## One thread (why the fire path looks the way it does)

The page, `inject.js` and `content.js` all run on the renderer's **single main
thread**. Once `fetch()` is called the request flies regardless of what JS does
next, so the only thing that can cost the race is delaying the *moment*
`fetch()` is called — and DOM work does exactly that.

- **`inject.js` owns the fire timer.** `content.js` sends `arm-fire` with the
  absolute deadline ~6 s ahead; a "fire now" `postMessage` would cost an
  event-loop turn.
- **A 6 ms busy-wait tail** absorbs timer lateness.
- **No DOM work within ±10 s of the rollover** (parking and refetching stand
  still).

Invariants that were bugs once:

- **Time to the rollover is signed** (`msToRollover()`). "ms until midnight"
  jumps from ~0 to ~86,400,000 the instant the rollover passes; every gate uses
  the signed form.
- **A win needs positive evidence.** An empty verification body means the check
  failed, not that we got it.

Only one tab runs the engine: each claims ownership in `chrome.storage`
(`owner`, heartbeat every 3 s), and the others go passive rather than firing a
duplicate shot per job. Any state change sends `cancel-fire`, so disarming at
23:59:58 cannot leave a booking to go off at midnight. A **late** fire is still
sent (a stale token merely gets rejected) unless it is past the reCAPTCHA TTL
(~110 s, e.g. the machine slept).

## Reading the logs

The outcome of every shot is persisted, so it survives the tab closing:

- `status` — what the popup shows (the per-slot report after a shot).
- `lastShot` — `{ fireT, clockOffsetMs, clockSamples, verified, jobs: [{ verdict,
  http, sentT, ms, body }] }`. Verdicts: `won`, `taken`, `rejected-open` (the slot
  is still free — book it by hand), `200-unverified`, `200-still-open`,
  `failed`, `unprepared`.
- `engine` — the version the calendar tab last booted with.

Everything else goes through `console.log`, tagged and timestamped to the
millisecond; once the clock is synced, engine lines carry the signed offset to
the court's midnight (`T-12.345s` / `T+0.150s`).

| Tag | Where to open it |
|-----|------------------|
| `[padel …]` | engine (calendar tab → DevTools console) |
| `[padel/net …]` | network hooks, MAIN world (same console) |
| `[padel popup …]` | popup (right-click the popup → Inspect) |
| `[padel bg …]` | notifications (`chrome://extensions` → *service worker*) |

Key lines on a live night: `engine v0.4.0 loaded`, `clock sync: server offset …`,
`booking request CAPTURED`, `prepare-direct[a]: OK, replacements per pattern = …`,
`arm-fire: [a,b] in …ms`, `fire[a] <- 200 in 74ms`, and
`verify 20:30 (Pavlo): http=200 verified=true slotStillOpen=false -> won`.

## Scope / ethics

Personal booking automation for a single court reservation. It uses requests
the page builds itself and does **not** attempt to solve or bypass captchas — it
defers to you when one appears. Automating Google Calendar may be against
Google's Terms of Service; use on your own account and at your own risk.
