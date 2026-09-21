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
2. **Capture (~T−20 s)** — open the booking modal on any *currently open*
   (sacrificial) slot, fill the real data, and click **Book** while the network
   hook **swallows** the outgoing booking RPC. The page itself validates the
   form and mints its own invisible-reCAPTCHA token; we keep the complete
   request it built (headers incl. fresh SAPISIDHASH + body incl. the token)
   and discard the modal. Nothing is booked. If a captcha *challenge* pops up
   here, you get a notification and whatever time remains before midnight
   (~10 s with the tight 20 s lead) to solve it — solving lets the capture
   complete; the tool never solves or bypasses it. A slow capture or an
   unsolved challenge just means no direct shot that night; the UI path is
   unaffected.
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

## Two slots at once (v0.3)

Tick **«Второй слот»** in the popup to book two times on the same date at one
midnight, each with its own profile (e.g. a different resident). A rollover
opens exactly one new day, so both jobs share the date and differ in time +
identity.

The two paths scale very differently, which is the whole point:

- **Direct shot — truly parallel.** Captures are sequential (one modal in the
  DOM, and a reCAPTCHA token is single-use), so each extra slot pushes the
  capture lead back by 12 s — `T−20 s` for one slot, `T−32 s` for two. Only the
  first token pays the full wait. At the rollover **both requests leave in the
  same tick**, so both bookings land ~one RTT after midnight.
- **UI fallback — sequential.** One modal at a time: the first slot lands at
  ~T+0.6 s, the second at ~T+2.5 s. Between jobs it returns to the grid
  (dismiss dialog → *Done*/*Close* → wait for slot buttons); if the
  confirmation view can't be dismissed it tells you to finish that one by hand.

Jobs the direct shot already won are skipped by the UI queue, and a modal left
open by the other slot is never filled in for the wrong job — the 90-minute end
time in the header (`8:30 – 10:00pm`) identifies which slot a dialog belongs to.
Notifications and the final status report per slot (`Забронировано 2 из 2`).

Note: firing two booking RPCs in the same millisecond is a stronger bot signal
than one. Your logs show the schedule accepts two bookings for the same date
from one session (2026-08-09: 20:30 and 16:00 both booked with one email), so
separate Google accounts aren't needed — but if challenges start appearing,
staggering the shots is the first thing to try.

Caveats needing one live pass: the booking RPC body format (epoch replacement
counts are logged as `direct shot prepared`), whether the token survives ~20 s
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

## One thread (why the fire path looks the way it does)

The page, `inject.js` (MAIN world) and `content.js` (ISOLATED world) all run on
the renderer's **single main thread**. Network I/O does not: once `fetch()` is
called the request is handed to the network stack and flies regardless of what
JS does next. So the only thing that can cost us the race is delaying the
*moment* `fetch()` is called — and UI work does exactly that, because a date
click runs Google's own handlers and grid re-render synchronously.

That drives four decisions:

- **`inject.js` owns the fire timer.** `content.js` sends `arm-fire` with the
  absolute deadline ~6 s ahead, and inject fires from its own timer.
  A "fire now" `postMessage` costs an event-loop turn, so it could queue behind
  whatever the app is rendering at midnight.
- **A 6 ms busy-wait tail** absorbs timer lateness (measured: 2–3 ms of
  scheduler jitter → 0 ms). Nothing may preempt us between the deadline and the
  send.
- **The fallback burst is deferred** to `fireAt + 60 ms`. Previously the date
  click ran synchronously *before* inject's queued message was delivered, so
  our own burst delayed our own request.
- **The turbo poker stands still** within ±250 ms of the send, so we don't
  hand the thread to a grid re-render at the worst possible moment.

Remaining exposure: if the Calendar app is *already* mid-render when the
deadline passes, we wait for it to finish — unavoidable with one thread. The
blocking is asymmetric, though: the shot is ~1 ms of work and never meaningfully
delays the UI path, and the UI grab only starts after detection (≥ one RTT after
the rollover), by which time the shots are long gone.

Safety: any state change sends `cancel-fire`, so disarming at 23:59:58 cannot
leave a booking to go off at midnight, and a fire more than 5 s late (machine
asleep, tab frozen) is skipped rather than sent against stale availability.

## Reading the logs

Everything goes through `console.log`, tagged and timestamped to the
millisecond. Once the clock is synced, lines also carry the signed offset to
the court's midnight (`T-12.345s` / `T+0.150s`) — that offset is the number to
look at when tuning the shot.

| Tag | Where to open it |
|-----|------------------|
| `[padel …]` | engine (calendar tab → DevTools console) |
| `[padel/net …]` | network hooks, MAIN world (same console) |
| `[padel popup …]` | popup (right-click the popup → Inspect) |
| `[padel bg …]` | notifications (`chrome://extensions` → *service worker*) |

The radar replays ~3×/s, so outside the rollover window it logs a 10-second
heartbeat (`radar heartbeat: 33/33 ok in 10s, midnight in 214s`); inside the
turbo window every response is logged individually. Key lines to look for on a
live night: `clock sync: server offset …`, `booking request CAPTURED`,
`prepare-direct[a]: OK, replacements per pattern = [1,1,0,0,2]`,
`FIRE (scheduled drift …)`, `direct-book[a] <- 200 in 74ms`, and
`verify 20:30 (Dmytro): http=200 slotStillOpen=false -> WON`.

## Scope / ethics

Personal booking automation for a single court reservation. It books through the
normal UI and does **not** attempt to solve or bypass captchas — it defers to you
when one appears. Automating Google Calendar may be against Google's Terms of
Service; use on your own account and at your own risk.
