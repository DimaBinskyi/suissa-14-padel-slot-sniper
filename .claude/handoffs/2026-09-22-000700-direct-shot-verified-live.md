# Handoff: Direct-shot booking verified live; booking-RPC pattern fixed; two-slot UI queue working

## Session Metadata
- Created: 2026-09-22 00:07:00
- Project: /Users/admin/Documents/dev/padel-slot-sniper
- Branch: main (synced with origin/main)
- Session duration: one long session (log forensics → direct shot → 2-slot booking → audit → live testing)

### Recent Commits (for context)
  - 12ba447 Fix three failures found by running the extension against the live page
  - f5aba74 Fix the booking-RPC URL pattern: the swallow never once fired
  - 45d1698 Overlap the UI queue: hand off a job once its request is sent
  - b50deb6 Take the LAST dialog, not the first: Google stacks booking modals
  - 493f229 Fix the critical and high findings from the logic audit
  - 741e82e Tighten direct-shot capture to T-20s
  - fd547ee Capture the direct-shot request at T-45s
  - cfe6e92 Run the direct shot and the UI grab fully independently
  - 30d0df8 Add direct-shot booking

## Handoff Chain

- **Continues from**: [2026-07-07-135538-padel-slot-sniper-extension.md](./2026-07-07-135538-padel-slot-sniper-extension.md)
  - Previous title: Padel Slot Sniper — Chrome extension auto-booking Google Calendar padel slots
- **Supersedes**: None. The July handoff is still useful for original recon, but several of its
  claims are now WRONG — see "Corrections to the previous handoff" below.

> Review the previous handoff for original recon context, but trust THIS document where they conflict.

## Current State Summary

The extension went from v0.1 (UI-only, ~650ms to book) to v0.4 with a "direct shot": it captures the
page's own booking request before midnight (swallowing it so nothing is booked), retargets the slot
epoch, and fires it from `inject.js`'s own pre-armed timer ~120ms after a server-corrected midnight —
reaching Google in ~150-190ms. It also books TWO slots at one midnight, each with its own profile.
Everything is committed and pushed. The direct-shot mechanism and the two-slot UI queue were both
VERIFIED against the live booking page this session (real bookings made, all cancelled). What has NOT
been exercised is an actual midnight rollover — the clock sync, `arm-fire` scheduling and rollover
gates are covered only by unit assertions.

Trigger for the work: the 2026-09-21 midnight run lost the slot despite clicking Book at +557ms,
recovered from the extension's storage log (see "Where the logs live").

## Codebase Understanding

### Architecture Overview

Unchanged two-part design, plus a third worker:

- `inject.js` — MAIN world, `document_start`. Hooks XHR+fetch. Captures the `ListAvailableSlots`
  replay template, swallows/captures the booking request for the direct shot, owns the midnight
  fire timer (`arm-fire` / `cancel-fire` / `firePrepared`), serves `clock-probe`.
- `content.js` — ISOLATED world orchestrator. Radar (replay every 300ms), view parker, turbo poking,
  direct-shot prep, the midnight schedule, and the UI booking queue over 1-2 "jobs".
- `background.js` — notifications relay. `popup.*` — config UI (per-booking blocks).

Key concepts added this session:
- **jobs**: one job = one slot + one identity. Job "a" from `cfg.targetTime` + cfg's own name/email;
  job "b" from `cfg.second`. A rollover opens exactly ONE new day, so both jobs share `targetDate`.
- **direct shot**: capture -> retarget -> fire. Per-job `prepared[id]` in inject.
- **handoff**: a UI job returns as soon as its request is SENT (not completed) so the next slot's
  modal opens ~1s earlier; its result is collected in the background by request `seq`.
- **single owner**: one tab claims the run via `storage.owner` + heartbeat; other tabs go passive.

### Critical Files

| File | Purpose | Relevance |
|------|---------|-----------|
| src/inject.js | Net hooks, swallow/capture, epoch rewrite, fire timer, clock probe | **Highest** |
| src/content.js | Jobs, radar, prep, midnight schedule, UI queue, handoff | **Highest** |
| src/popup.html/js/css | Per-booking blocks, second-slot profile picker + preview | High |
| src/background.js | chrome.notifications relay (logs to SW console) | Low |
| README.md | Now documents the direct shot, one-thread design, logging, two slots | High |
| ~/.claude/projects/-Users-admin-Documents-dev-padel-slot-sniper/memory/padel-live-dom-facts.md | Measured live DOM + network facts | **Highest** |

### Key Patterns Discovered

**Live network facts (measured, not assumed):**
- Booking RPC: `.../$rpc/google.internal.calendar.v1.AppointmentBookingService/BookSlot?...`
  Note the **DOT** before the service name.
- BookSlot body: `[null,null,"<scheduleId>",null,[[<startEpochSECONDS>],90],null,["<title>",...]]`
  — a start epoch in **seconds** plus a **duration in minutes**. There is NO end epoch, which is why
  the observed epoch-replacement counts are `[0,0,1,0]`.
- Body ~3.5KB; only ONE request header is set via `setRequestHeader` (api key + content-type ride in
  the `$httpHeaders` query param). Auth is **cookies**, so a replay needs `credentials: "include"`.
  The reCAPTCHA token is NOT in the body.
- Cancel RPC: same service, `CancelBookedSlot`, body `[null,null,"<bookingId>"]`,
  `content-type: application/x-www-form-urlencoded;charset=UTF-8`. Returns `[]`.
  BookSlot returns `[null,null,"<bookingId>"]` — keep that id if you ever need to undo a test.

**Live DOM facts:**
- Modal header: `Tuesday, September 22 · 11:30am – 1:00pm`. The START time carries its own meridiem
  when it differs from the end, and omits it when it matches (`8:30 – 10:00pm`).
- **Dialogs STACK, they never swap.** Clicking a second slot with a modal open creates a SECOND
  `[role=dialog]`; both visible, same rect, each with its own form and Book button. Always take the
  LAST one.
- **No `inert` anywhere**; the dialog wrapper is `pointer-events:none`. Synthetic `.click()` on
  background elements works — a modal does NOT block programmatic clicks.
- **Cancel is `disabled` while a booking submits.** Closing a modal mid-flight is impossible; stacking
  is the way past it.
- Success DOM: `Booking confirmed` + `Email sent to <email>`; buttons `Cancel your appointment` / `Close`.
- Cancel flow: `Cancel your appointment` -> `Cancel appointment?` -> `Confirm` -> `Appointment cancelled`.

**Timing invariants:**
- `msToRollover()` is SIGNED. The raw "ms until midnight" jumps from ~0 to ~86,400,000 the instant the
  rollover passes; every gate meaning "is it near / has it passed" must use the signed form.
- A win needs POSITIVE evidence: an empty verification body means the check failed, NOT that we got it.

### Where the logs live

The extension writes no log files, but every `setStatus` since July survives in Chrome's extension
storage WAL:
`~/Library/Application Support/Google/Chrome/Profile 7/Local Extension Settings/bpfeeaekdfekkgafiecmhdnpnpdcppoe/000003.log`
(extension id found via that profile's `Secure Preferences` -> `extensions/settings/*/path`). Plain
grep misses data (Snappy); parse LevelDB log records (32KB blocks, 7-byte headers, batch = seq+count+puts)
or extract UTF-8 runs. This is how the 2026-09-21 loss was diagnosed.

## Work Completed

### Tasks Finished

- [x] Diagnosed the 2026-09-21 loss from the storage WAL (Book at +557ms, no confirmation, 17s silent hang).
- [x] Built the direct shot: swallow+capture, single-pass epoch rewrite, `arm-fire` from inject's own timer.
- [x] Server clock sync with a same-origin `clock-probe` fallback (`Date` is not CORS-exposed on the RPC host).
- [x] Two slots at one midnight, each with its own profile; parallel direct shots, sequential UI queue.
- [x] Split the popup into per-booking blocks + second-slot identity preview.
- [x] Comprehensive `console.log` instrumentation in all four scripts, with signed `T±` offsets.
- [x] Four-way parallel logic audit; fixed all critical + high findings (commit 493f229).
- [x] **Live-verified the direct shot**: captured a 2:30pm request, swallowed it, retargeted to 4:00pm,
      fired -> HTTP 200 + booking id; 4:00pm went unavailable, 2:30pm stayed free. Cancelled.
- [x] **Live-verified the two-slot UI queue** running the real `content.js`+`inject.js`:
      `✅ Забронировано: 11:30 (ZZ) + 16:00 (ZZ)`, correct per-job identities. Cancelled.
- [x] Fixed the booking-RPC URL pattern (f5aba74) — see "Important Context", this was project-breaking.
- [x] Fixed 3 failures found only by live running (12ba447).
- [x] All 7 test bookings cancelled; all four slots confirmed restored.

### Files Modified

| File | Changes | Rationale |
|------|---------|-----------|
| src/inject.js | BOOK pattern fix, swallow pass-through, single-pass rewrite + leftover check, `arm-fire`/`cancel-fire`/`firePrepared`, `clock-probe`, `booking-sent`/`seq`, rid-tagged replays, origFetch for shot+replay | Direct shot + correlation + the pattern fix |
| src/content.js | jobs model, `msToRollover`, `targetOpensAtThisRollover`, prep/schedule/fire, handoff + `untilTrue`, `dialogEl` last-dialog, modal range guard, owner election, cfg-change restart, logging | Core of everything this session |
| src/popup.html/js/css | Per-booking fieldsets, second-slot picker + preview, validation, default date today+2, logging | UI was "stupidly merged"; validation gaps |
| src/background.js | Logging | Visibility |
| README.md | Direct shot, two slots, one-thread design, log guide, verified network facts | Docs matched reality |
| manifest.json | 0.1.0 -> 0.3.0 | Version bump (NOTE: not bumped for 0.4-level changes since) |

### Decisions Made

| Decision | Options Considered | Rationale |
|----------|-------------------|-----------|
| Capture the page's own request rather than mint a token | `grecaptcha.execute()` + persisted body | The page builds a complete, signed request; we never solve or bypass a captcha |
| Fire from inject's own pre-armed timer | postMessage "fire now" at T+0 | One shared JS thread; a postMessage costs an event-loop turn and can queue behind the app's rendering |
| Direct shot and UI path fully INDEPENDENT (no gating) | Gate the UI on the shot's outcome | User's explicit priority: getting the slot beats avoiding a duplicate (duplicates are cancellable) |
| Late fire is SENT, not skipped | Skip if >5s late | A stale token is merely rejected; not firing guarantees no booking. Only past the ~110s TTL do we give up |
| Capture lead T-20s (+12s per extra job) | T-75s / T-45s | User wanted the youngest possible token; captures are sequential so each job needs its own window |
| Stack a new dialog rather than close the old one | Cancel/Escape, or remove the node from the DOM | Measured: Cancel is disabled mid-submit; stacking is native behaviour and needs no DOM surgery |
| Match the booking RPC by method name (`BookSlot`) | Service-wide match | Precise, and leaves `CancelBookedSlot`/`GetAppointmentServiceDefinition` alone |
| One tab owns the run | Let every tab run | Two tabs meant two radars and two shots per job — systematic duplicates |

## Pending Work

### Immediate Next Steps

1. **Reload the extension** at `chrome://extensions` before arming. The build on disk is materially
   different from whatever is loaded; without the `f5aba74` fix, arming would book a random slot at
   T-20s and fire nothing.
2. **Arm it for one real midnight and read the console**, in this order:
   `clock sync: server offset …` (if absent, the clock probe is failing -> scheduling on the local
   clock), `Прямой запрос готов`, `arm-fire: [a] in …ms`, `FIRE`, `fire[a] POST … issued`,
   `fire[a] <- 200 in …ms`, `verify … -> WON`. Whichever line is missing names the next bug.
3. **Check whether the handoff engages** (`handoff: … is in flight after …ms — queue moves on`).
   It never engaged in testing because that browser's reCAPTCHA took 6-26s to send; a warm real
   profile should send in <1s. If it still doesn't, raise `SEND_WAIT_MS` (content.js ~797).
4. Consider bumping `manifest.json` to 0.4.0 — several releases' worth of change since 0.3.0.

### Blockers/Open Questions

- [ ] **The midnight path has never run.** Clock sync, `arm-fire` timing, the rollover gates and the
      turbo window are covered by 45 unit assertions only.
- [ ] **Does `clock-probe` actually return a readable `Date`?** `Date` is not CORS-safelisted, so the
      probe uses a same-origin `/favicon.ico`. Untested live. If it fails you'll see
      `clock probe returned no Date header` and everything schedules on the Mac's clock.
- [ ] **Will Google accept TWO shots in the same millisecond?** One retargeted shot was accepted;
      two simultaneously is a stronger bot signal and is untested.
- [ ] **Token age tolerance unknown.** The accepted shot used a ~2-minute-old capture, which is
      reassuring, but the relationship between age and acceptance is unmeasured.

### Deferred Items

- The no-free-slot night: if every slot of the next day is taken, there is nothing to capture from and
  the direct shot silently sits out (UI path still works). Deliberately not solved — a
  `grecaptcha.execute()` workaround was judged ~25% likely to work and risky.
- An early warning at arm time when no sacrificial slot exists (~15 lines, zero risk).
- Compressing the UI path further by removing `backToGrid` entirely now that stacking is proven.

## Context for Resuming Agent

### Important Context

**1. The bug that mattered most.** `inject.js`'s `classify()` matched `"/AppointmentBookingService/"`
with a leading SLASH, but the real path has a DOT (`v1.AppointmentBookingService/`). It matched
NOTHING, so for the entire life of the direct-shot feature: the swallow never fired (so the capture
step clicked Book on a sacrificial slot and **booked it for real**, every time, while producing no
request to fire), and `booking-result` was never delivered (so the UI path ran on DOM text alone —
which explains the two `Не удалось подтвердить бронь` runs in the stored history). Fixed in f5aba74.
The lesson: **verify network patterns against the live page, never from a previous handoff's prose.**

**2. I made two real bookings by accident.** Both cancelled. The first because I installed a safety
swallow AFTER page load — the bundle caches `XMLHttpRequest.prototype.send` at boot, which is exactly
why `inject.js` must be `document_start`. If you test on the live page, install hooks via
`page.addInitScript` BEFORE `goto`, and keep the BookSlot response's booking id so you can cancel via
`CancelBookedSlot`.

**3. Ethics boundary, unchanged.** The tool never solves or bypasses a captcha. A visible challenge
stops it and notifies the user. Keep it that way.

**4. The user's stated priority.** Getting the booking beats caution. Late fire: send. Duplicate risk:
accepted. Do not re-introduce gating between the two paths without asking.

**5. Chat in English.** The user's global CLAUDE.md requires English replies even when they write in
Russian. UI strings and status text are Russian by design.

### Corrections to the previous handoff

- It says booking goes to `/AppointmentBookingService/` — the leading slash is wrong (see above).
- It says the state machine is `idle|armed|booking` and that a `location.reload()` happens at
  detection. Neither is true any more: states are `idle|armed|grab` and nothing ever reloads.
- It says `bookingConfirmed()` and `captchaVisible()` are unverified. `bookingConfirmed()` is now
  verified — `Booking confirmed` is the real wording. `captchaVisible()` is still unverified: no
  visible challenge ever appeared, even in an automated browser.

### Assumptions Made

- Court timezone is Europe/Madrid and slots are always 90 minutes (`DUR = 5400000`, and the live body
  confirmed a literal `90`).
- The rolling window opens exactly one new day at midnight, so both jobs share `targetDate`.
- The page UI is English (month names, `Book`, `Cancel`).
- A booking id is a capability token — cancelling worked from a different browser context than the one
  that booked.

### Potential Gotchas

- **Tab must stay visible at midnight.** Chrome throttles hidden-tab timers to 1s+, which would wreck
  the scheduled fire.
- **Two inject instances** will appear if you call `addInitScript` twice in one Playwright context;
  both answer every command and you may read the wrong reply. Use a fresh context per test run.
- **`browser_run_code_unsafe` echoes the whole script**, so a harness with embedded sources blows the
  output limit. Write the harness to a file inside the repo root (the tool refuses `/tmp`), return only
  small summaries, and parse the saved tool-result file with python.
- **The automated browser is ~20-50x slower** than real Chrome for the Book click (reCAPTCHA scrutiny):
  6-26s to send vs ~0.5s. Don't calibrate timeouts from it.
- A `capturePending` guard makes "Забронировать сейчас" wait up to 7s if a capture is mid-flight — by
  design, so it cannot disarm the swallow underneath a pending sacrificial Book click.
- `.padel-harness.tmp.js` and `.playwright-mcp/` are test scratch; both were removed and the tree is clean.

## Environment State

### Tools/Services Used

- Playwright MCP (real Chromium) for live-page testing; `page.addInitScript` to emulate
  `world: MAIN, run_at: document_start`, plus a `chrome.storage` stub to run the real `content.js`.
- Unit harnesses (kept in /tmp, regenerate if needed): `/tmp/padel_test.js` (34 assertions on the
  signed rollover, gates, single-pass rewrite, modal guard, jobs), `/tmp/turbo_test.js` (turbo window
  and log offsets across midnight), `/tmp/handoff_test.js` (8 assertions on send/result correlation).
  They extract real function sources from the files, so they test the shipped code, not copies.
- git remote is SSH; the repo was RENAMED on GitHub to `suissa-14-padel-slot-sniper` and the remote
  URL was updated. Push with:
  `GIT_SSH_COMMAND='ssh -i ~/.ssh/id_github -o IdentitiesOnly=yes' git push origin main`

### Active Processes

- None. No servers left running; Playwright contexts closed; the extension's own state was never armed
  from this session.

### Environment Variables

- None required. `GIT_SSH_COMMAND` is set per-command, not persisted.
- No secrets in the repo. The Google API key visible in request URLs is a public client key.

## Related Resources

- README.md — direct shot, two slots, one-thread rationale, log reading guide, verified network facts.
- Auto-memory: `padel-live-dom-facts.md` (measured DOM + network), `padel-sniper-logs-and-direct-shot.md`
  (WAL location, design, tuning items), `MEMORY.md` index.
- Previous handoff: `.claude/handoffs/2026-07-07-135538-padel-slot-sniper-extension.md`.
- Booking page: the public appointment-schedule URL in `DEFAULT_URL` at the top of `src/popup.js`.
- GitHub: `git@github.com:DimaBinskyi/suissa-14-padel-slot-sniper.git`

---

**Security Reminder**: No secrets included. Test bookings used `@example.invalid` addresses only.
