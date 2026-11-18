# Pair a phone: the phone as the scorer's keyboard (and later, remote)

Status: phase 1 implemented on `feat/phone-keyboard` (draft PR, not merged, not deployed). Phase 2 is a design
only (section 8).

Owner ask (17.11.2026, after scoring a league match on a Samsung Galaxy Tab A7 Lite): typing remarks on the
tablet's keyboard is painful, let the scorer type on their phone. Then (same day): *not per-field one-time codes,
"all fields, literally control the app"*: one pairing per scoring device, and the phone types into whatever text
field is focused; remote control of the app's buttons comes later (phase 2).

## 1. What the scorer does

1. Match menu → **Devices and data → Pair a phone (keyboard)**.
2. The panel shows a QR code and an 8-symbol code (`ABCD-EFGH`). The phone scans the QR, or opens the shown
   address (`…/pair/`) and types the code. Link and code work for 10 minutes and for one phone only.
3. The tablet says **Phone connected**; a small "Phone keyboard" pill stays at the bottom left on every screen.
4. Tap any text field on the tablet (remarks, a correction remark, the protest text, names in match setup and
   roster editing, match info...). The phone shows the field's label and its current text in a large text box,
   with the phone's own keyboard, autocorrect, word suggestions and dictation. What is typed goes live into the
   tablet's field. **Previous / Next field** move the focus on the tablet; **Enter** (one-line fields) is the
   tablet's Enter. While a phone is paired the tablet's own on-screen keyboard stays closed (switch in the panel).
5. The pairing ends on **Unpair** (the pill or the panel), when the match is approved / final, when the tab or app
   closes, 5 minutes after the tablet stopped calling, or after 6 hours. The phone page then says so.

PIN, password, one-time-code and token fields are never typed into from the phone and their text is never sent
to it (by `type`, `autocomplete`, or a name / id / label / test-id word: pin, password, passwort, passcode,
passkey, token, secret, otp; and `data-ov-phone="off"`). The phone then shows "Tap a text field on the tablet".

**The official remarks** (`data-ov-phone="official"`: the scoreboard's remarks box and the match-end remarks)
take the phone's text live like any field, and the tablet shows what arrived ("From the phone into
«Remarks recording»" with the added text) for 6 s. Nothing new is saved by the phone itself: the remarks box is
saved as before, when the scorer closes it (scoreboard, which also logs the `remark` event with the added lines:
the sheet's history) or taps Save (match end).

## 2. Transport

The same as Sign on phone (`docs/qr-signing-spec.md`): HTTP JSON with long-polls on the relay the tablets use.

- **Internet:** `backend.openvolley.app` (start needs a signed-in scorer, referee or admin account and a match
  stored on the server that the account writes, exactly the Sign on phone rule D2).
- **Hall network:** the laptop's / board's own relay (Tauri `relay.rs`, `server.js` on a board or Pi, the Vite dev
  relay, `backend/server.js --local`): the relay host itself, or the game PIN of a match the relay holds
  (`X-OV-Match-Pin`, wrong PINs counted in the existing limiter; on `--local` only from the device that holds the
  room). Rule D3 of Sign on phone, reused (`signOwner`, `sign_owner`).

Why not the WebSocket: the role socket is on another port than HTTP on the LAN relays, the phone page loads no app
bundle, and long-poll is the same 30 lines on the three runtimes that are kept in sync by hand (qr-signing-spec
4.6). One input per typing pause (60 ms) is a few requests a second; the wait wakes at once.

The phone page sends the field's **whole text**, not keystrokes: autocorrect, word suggestions, swipe typing and
IME composition replace words, which a keystroke stream cannot carry.

## 3. Protocol (identical on `backend/server.js`, `lanRelayCore.cjs`, `relay.rs`)

Core: `frontend/electron/pairSessionCore.cjs` (dependency-free CommonJS; `backend/lib/pairSessions.js` is
generated from it by `frontend/scripts/make-sign-core.mjs`; Rust port `src-tauri/src/pair.rs`). Shared vectors:
`frontend/electron/__fixtures__/pair-vectors.json` (run by vitest, node:test and cargo test); shared HTTP scenario:
`pairHttpScenario.mjs` (server.js, Vite plugin, Tauri binary, `--local`, cloud).

All `POST`, JSON, `Cache-Control: no-store`; answers `{ ok, … }` or `{ ok:false, code, message }`. No secret in a
URL path or query.

| Endpoint | Caller | Auth | Body | 2xx answer |
|---|---|---|---|---|
| `/api/pair/start` | tablet | as `/api/sign/start` | `{ matchKey?, context: { home, away, matchNo?, when?, lang? } }` | 201 `{ token, code, watch, joinBy, endsAt, path:'/pair' }` |
| `/api/pair/wait` | tablet | watch | `{ watch, knownState?, after?, knownPhone? }` | `{ state, seq, inputs:[{seq,n,field,text?,action?,base?}], phone:{connected}, endsAt, joinBy?, pairedAt? }`; at once on news, else ≤ 25 s |
| `/api/pair/focus` | tablet | watch | `{ watch, field: null \| { id, label?, kind?:'line'\|'multiline', text?, maxLength? }, applied? }` | `{ v }` |
| `/api/pair/close` | tablet | watch | `{ watch }` | `{ ok }` (unpair; idempotent) |
| `/api/pair/join` | phone | token or code, once | `{ k }` or `{ code }` | `{ phone, state:'paired', context, endsAt, app? }` |
| `/api/pair/poll` | phone | phone secret | `{ phone, known? }` | `{ state, v, field, applied, endsAt }`; at once when `known ≠ v`, else ≤ 25 s |
| `/api/pair/input` | phone | phone secret | `{ phone, n, field, text?, action?:'next'\|'prev'\|'enter'\|'done', base? }` | `{ seq }` (`duplicate:true` for a retried `n`) |

- **Secrets:** token, watch and phone secret: 32 CSPRNG bytes, base64url (43 chars). Code: 40 bits, 8 symbols of
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (typed case-insensitively, spaces and dashes ignored). Only SHA-256 hashes
  (`k:`/`w:`/`p:`/`c:` prefixed) are kept, in memory. The token is in the URL **fragment** and leaves the phone's
  address bar on load; the phone keeps its own secret in `sessionStorage` only.
- **One phone:** `join` turns `pending → paired`; any later join (token or code) is `409 OV_PAIR_USED`.
- **Lifetimes:** join within 10 min; paired until `close`, 6 h after start, or 5 min after the tablet's last call
  (a held wait counts as a call). Ended pairings answer `closed` / `expired` (wait, poll) or
  `409 OV_PAIR_CANCELLED` / `410 OV_PAIR_EXPIRED` (join, input) for 60 s, then 404.
- **Fields:** `id` `[A-Za-z0-9_.:-]{1,64}` chosen by the tablet per element; text NFC, CR LF / CR / U+2028/9 → LF
  (`line`: a space), tab → space, other C0/C1 and bidi controls removed, not trimmed; cut to the field's cap
  (≤ 8000 code points, the `matches.remarks` CHECK) in `focus`, refused over the cap in `input`
  (`OV_PAIR_TEXT_TOO_LONG`, never cut). An input for another field than the focused one: `409 OV_PAIR_STALE`; none
  focused: `409 OV_PAIR_NO_FIELD`. A text after a text for the same field replaces it in the queue (≤ 64 entries).
- **`base`:** 8 hex, FNV-1a (32 bit, UTF-16 units) of the text the phone typed on. The tablet keeps the last 32
  texts of each field by hash and merges three-way (`utils/phonePair/merge.js`): only the phone changed → the
  phone's text; only the tablet → the tablet's; both appended → both; anything else → **the tablet's text stays**
  and the phone gets it back. A phone never overwrites text it was not shown (found by the e2e: the phone typed on
  an older copy and the "Actual game start" line went missing).
- **Caps** (cloud / LAN): live pairings 1000 / 60 (relay host keeps 10); per owner 5; starts per owner 20 / 30
  per 5 min; phone requests per IP 3000 / 6000 per 5 min; typed codes per IP 30 / 60 per 5 min (every typed code
  counts); inputs per pairing 30 per second; held requests 2000 / 120; bodies 64 KB on `focus` and `input`, 4 KB
  otherwise (413 `OV_PAIR_TOO_LARGE`). Over a cap: 429 `OV_PAIR_RATE_LIMITED` with `Retry-After`, a full table
  503 `OV_PAIR_BUSY`.
- **Codes:** `OV_PAIR_BAD_REQUEST, _CONTEXT, _FIELD, _TEXT_TOO_LONG, _STALE, _NO_FIELD, _FORBIDDEN, _MATCH,
  _PIN_INVALID, _NOT_FOUND, _USED, _CANCELLED, _EXPIRED, _TOO_LARGE, _RATE_LIMITED, _BUSY, _UNAVAILABLE`,
  `OV_AUTH_REQUIRED`.
- **Logging:** one line per transition, `pair.start|join|close|expire ref=<8 hex> via=cloud|lan`. Never a secret,
  the code, the context, a label or any text (tested on `--local` and cloud).
- **Phone page:** `/pair/` (`frontend/public/pair/`, ~27 KB with the five-language table; cloud copy
  `backend/lib/pairPage.js`, generated), the `/sign` page's strict CSP (`connect-src 'self'`, no inline script),
  `no-referrer`, `no-cache`; not precached, `/pair` on the service worker's navigate denylist.
- **Off switch:** `OV_PAIR_DISABLED=1` on the backend (503 `OV_PAIR_UNAVAILABLE`).

## 4. Security notes

| Threat | Mitigation |
|---|---|
| Token / code guessing | 256-bit token; 40-bit code valid 10 min, one use, 30 (cloud) / 60 (LAN) typed codes per IP per 5 min. |
| A second phone, a leaked QR | One phone per pairing (`OV_PAIR_USED`); the tablet shows "Phone connected"; Unpair ends it at once. |
| Phone reads secrets | PIN / password / code / token fields are not reported and not writable (section 1). |
| Phone overwrites the record | Three-way merge with `base`; the tablet wins a conflict; official remarks are saved only by the scorer's own close / Save, with the existing history. |
| Logs | Transitions only, with an 8-hex ref. |
| Plain HTTP in the hall | As every LAN relay call (qr-signing-spec 7.1); the internet way is HTTPS. |
| Memory | Caps, a sweeper (created lazily, `unref`'d, disposed on relay close), tombstones with hashes only. |

## 5. App side (files)

| File | What |
|---|---|
| `src/lib/phonePairApi.js` | start / wait / focus / close, the QR link (`/pair/#k=`) and code display. |
| `src/utils/phonePair/fields.js` | which fields, labels, writing like typing (native setter + `input` event), next / prev, Enter. |
| `src/utils/phonePair/merge.js` | `textHash`, `mergeText`, the per-field text history. |
| `src/utils/phonePair/controller.js` | one pairing per tab: focus tracking, applying inputs, `inputmode="none"` while paired, unpair. |
| `src/components/phonePair/*` | store (`openPhonePair`), panel, host (pill, arrival line, unpair on match closed / pagehide). |
| `main.jsx` | mounts `PhonePairHost` beside the app. |
| `matchMenu.jsx`, `Scoreboard.jsx` | the menu row; the remarks textarea gets `aria-label` and `data-ov-phone="official"`. |
| `MatchEnd.jsx` | the remarks textarea gets `data-ov-phone="official"`. |

Transport choice reuses Sign on phone's `usePhoneSignTransports` (cloud vs hall network, the hall address, the
remembered choice).

## 6. Tests

- `src/utils/__tests__/pairSessionCore.test.js` (vectors, secrets, logging, long-polls, 6 h, timers),
  `lanRelayPair.test.js` (start rule, body caps, timers, server.js + Vite plugin + Tauri binary scenario),
  `signCoreCopy.test.js` (generated copies), `pwaWorkbox.test.js`, `utils/phonePair/__tests__/phonePair.test.js`
  (fields, merge, controller), `components/phonePair/__tests__`, `matchMenu.test.jsx`, i18n tests.
- Backend: `tests/pairSessions.test.js` (vectors on the generated copy), `tests/pair.local.e2e.test.js`
  (`--local`), `tests/pair.e2e.test.js` (cloud, throwaway Postgres).
- Rust: `pair::tests` (vectors, wake-ups) and a router test in `relay.rs`.
- Two-browser Playwright run (tablet 1005×600, phone 390×844, deviceScaleFactor 2) against the Vite dev relay:
  pair from the Match menu, live typing into the remarks both ways, backspace, both typing at once, the tablet's
  keyboard kept closed, a short viewport, the saved remark and its event, a second phone refused by link and by
  code, unpair, the dead link.

## 7. Deploy

- Backend image: `lib/pairSessions.js`, `lib/pairPage.js`, routes; no migration, no new secret. Cloudflare does
  not cache POST; `/pair*` is `no-cache`.
- Apps (web, desktop, Android, boards): the next release. An older relay answers 404 on `/api/pair/start`: the
  panel says it could not start.

## 8. Phase 2: remote control of the app's actions (design only)

Goal: from the paired phone, the scorer taps the same actions as on the tablet (point A / B, time-out,
substitution, menus), seeing a mirror of the scorer's screen state.

**Principles (owner):** needs the pairing **and** an explicit approval on the tablet; every action is logged as
coming from the paired phone; never bypasses the app's own confirmations.

1. **Approval:** a second step on the tablet: "Allow this phone to control scoring?" (`confirmDialog`, verb
   "Allow"), off by default, ends with the pairing. The relay stores `control: true` on the pairing only after a
   `POST /api/pair/control { watch, allow }` from the tablet; phone requests for actions are refused (`403
   OV_PAIR_CONTROL_OFF`) otherwise.
2. **What the phone sees:** not a screenshot. The tablet publishes a small **action model** through
   `focus`-like reports (`POST /api/pair/screen { watch, screen: { title, actions: [{ id, label, kind,
   enabled, danger? }], dialog?: { title, text, actions } } , v }`), built from the same handlers the toolbar uses
   (`matchMenuSections`, the scoring buttons' props). Team colours, the score and the serve come from the
   existing live state (`live-state-update`), so the phone renders big point buttons in the team colours.
3. **Actions:** `POST /api/pair/input { phone, n, action: 'tap', target: '<action id>', screenV }`. The tablet
   applies it only if `screenV` is the screen version it published (no tap on a stale screen) and the action is
   enabled; it calls **the same handler** a tap would (`handlePoint(side)`, `handleTimeout(side)`...), so every
   rule check and every confirmation dialog runs unchanged. A confirmation opened by a phone action appears on
   the tablet **and** is mirrored to the phone as `dialog`; either side may answer it, the tablet stays the
   authority.
4. **Logging:** the event payload gets `source: { kind: 'phone', ref: '<8 hex>' }` (the pairing ref, never a
   secret) in the action log and the activity log, and the scoresheet's undo works as for a tap.
5. **Safety:** inputs per second as today; destructive actions (stop the match, undo of a set end, reopen) stay
   tablet-only in the first version; the rally tap guard (`useRallyTapGuard`) applies to phone taps too; a lost
   phone connection pauses nothing on the tablet.
6. **Parity:** the same three relays; the core gets `screen` / `control` beside `focus`; vectors and the HTTP
   scenario extended; the phone page grows a second view behind the approval.

Not prototyped on purpose: the action model needs agreement on which actions are phone-safe, and the scoring
screen is under active change in other PRs.
