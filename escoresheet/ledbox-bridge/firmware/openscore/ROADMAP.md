# openscore — roadmap

Four phases from "runnable skeleton" to "the vendor renderer is gone from the board". Each phase
has a concrete **exit criterion** you can check.

Legend: ✅ done · 🟡 in progress · ⬜ not started

---

## Phase 1 — Protocol-complete stub  ✅ (this pass)

A Python-3 server on `:8889` that the bridge can talk to end-to-end, validated headless.

- ✅ gzip/JSON framing + `StreamDecoder` (one self-delimiting member per message).
- ✅ `Init` handshake (version 2), `noresend:false`, `error_message` field, vendor error codes
  (`1/5/6/8/9`).
- ✅ Full working command set: `Init, SetLayout, SetSection, SetSections, GetSections, GetLayout,
  ReloadLayout, Info, showInfo, Horn, Clear, StopAllProcess, ChangeWaiting, Disconnect`; unknown
  commands → error 1. Per-command logging.
- ✅ Layout model + robust XML loader (`layout/` + `layout/system/`, glob, bad-file-tolerant).
- ✅ Renderer for **all** section types: `text` (shrink-to-fit), `image`, `rectangle`,
  `circle/ellipse`, `bar` (provisional) → `www/buffer.png` (atomic).
- ✅ Behaviours: idle/`waiting`, `showInfo`, countdown/break layouts, software-blink-friendly
  section writes, horn.
- ✅ Client-lifecycle fix (no `:8889` wedge) and the RLock deadlock fix.
- ✅ `selftest.py` (real socket: handshake + parse + 4 error paths + 192×64 render) — **15/15**.
- ✅ `render_samples.py` (every screen → `samples/*.png`).

**Exit criterion (met):** `python3 selftest.py` prints `15/15 checks passed`, and pointing the
real bridge at the server (`LEDBOX_HOST/LEDBOX_PORT`) completes the `Init → SetLayout →
SetSections` handshake against it. See README §"Prove the handshake".

## Phase 2 — PNG-render parity (calibration)  🟡 next

Make the headless PNGs look *right* — the protocol is done, this is pixels. All off-hardware.

- ⬜ **Font choice & metrics.** The vendor uses bitmap fonts on a discrete `fontsize` ladder; we
  render scalable TTF, so sizes won't match 1:1. Pick the font (DejaVuSans-Bold today; consider
  bundling the panel's own `ARIAL.TTF` whose advance widths the bridge already encodes in
  `volleyballMapper.js`) and settle the size mapping.
- ⬜ **Per-section calibration** of the score/set/timeout/sub boxes in `volleyball_matchscore_02`
  and the break/countdown layouts: baseline (note the intentional negative `y`), centering,
  rectangle inclusive-vs-exclusive edge (Pillow `rectangle` is inclusive → boxes are +1 px).
- ⬜ **Golden-image tests.** Commit reference PNGs for the key screens and diff `render_samples.py`
  output against them in CI, so future changes can't silently regress the layout.
- ⬜ **Snapshot review** with the operator against the current vendor output for the same state.

**Exit criterion:** side-by-side, `render_samples.py` output is judged equivalent to the vendor
renderer for: match scoreboard, timeout/break, set interval, club idle, crest, waiting.

## Phase 3 — flushBuffer2 hardware integration (on the board)  ⬜

Run openscore on the board driving the real panel through the already-verified flushBuffer2.
**Requires eyes on the physical panel** — a wrong render is invisible over the network.

- ⬜ Install Pillow on the board (`apt install python3-pil`, or `pip3 install
  --break-system-packages pillow`).
- ⬜ Copy `openscore.py` + `layout/` + `media/` into place; point its `buffer_path` at the same
  `www/buffer.png` flushBuffer2 already polls (or run `openscore --base-dir /home/pi/ledbox`).
- ⬜ Start openscore **alongside** the still-running vendor stack on a **spare port** first
  (e.g. `--port 18889`), point a test bridge at it, and confirm on the glass that its `buffer.png`
  renders correctly through flushBuffer2 — **without** yet taking over `:8889`.
- ⬜ Verify the client-lifecycle fix on real hardware: kill a client without `Disconnect`, confirm
  `:8889` (test port) keeps accepting — the vendor bug is gone.
- ⬜ Confirm horn wiring (map `horn_cmd` to whatever sounds the buzzer on the board).

**Exit criterion:** with the vendor `ledbox.py` still installed as fallback, openscore on a test
port renders every Phase-2 screen correctly **on the physical panel** via flushBuffer2.

## Phase 4 — Cutover on the board  ⬜

Make openscore the `:8889` service; retire the vendor renderer.

- ⬜ Back up the vendor `ledbox.py` + start scripts **outside** `layout/` (never leave a `.bak`
  inside `layout/` — the vendor scanner hangs on multi-dot filenames).
- ⬜ Edit `bin/startledbox` to launch `python3 -u openscore.py` instead of `ledbox.py`; leave
  `bin/startled` (flushBuffer2) untouched.
- ⬜ Restart via the watchdog / reboot; watch the panel through a full match rehearsal (idle →
  scoreboard → point blink → timeout countdown → set interval → horn → idle).
- ⬜ Soak: confirm no port wedge across bridge reconnects/Pi reboots over a session.
- ⬜ Update the board-migration + firmware memory notes; keep the vendor renderer archived (not in
  `layout/`) as an instant rollback for one more event, then remove it.

**Exit criterion:** the board runs **only** open software end to end
(bridge → openscore → flushBuffer2 → panel); the private repo can go public.

---

### Deferred / optional (post-cutover)

- Native `animation` engine (`scroller_*` marquee for long names, native `blinking`).
- `Upload`/media service (`:12345`) if a non-bridge client ever needs custom-layout upload at
  runtime; today layouts are installed by dropping XML in `layout/`.
- `GetClients`, `SetConfig(s)` network config, playlist/practice plugins — only if a new client
  needs them.
- Drive the panel directly from Python via the `rpi-rgb-led-matrix` bindings (dropping the PNG
  hop) — only if the file hop ever proves too slow; at ~62 fps it currently does not.
