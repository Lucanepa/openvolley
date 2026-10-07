# Sign on phone (QR signing): implementation spec

Status: implemented on `feat/qr-signing` (not pushed, not deployed), with D1–D8 as proposed below,
for the owner to confirm. What differs from this spec:

- No migration: sessions are in memory (D4), so `db/` is unchanged.
- The phone page is about 23 KB, not 15 KB. Most of it is the five-language string table.
- The 45 s hall hint shows its "Show network options" link only where a screen passes
  `phone.onOpenConnectTablets`. No screen does yet, so today it is the hint text alone.
- The hall address is not read from Connect tablets, which never stored it. The panel takes the
  first hall address and offers a switch when there are several. `lanMode` (hall or laptop) is
  read from `ov_connect_tablets_view`.
- A page on a cloud domain whose backend override is a LAN relay (`isLanBackendUrl`) is not
  offered the LAN way. Only a page served by the relay is.
- The manual checks of 8.6 (a real hall, the Android emulator, a mixed PDF) are still to do.

Branch `feat/qr-signing`, from `main` (66b43636). This
document is the contract between four parts that can be built in parallel: the cloud backend
(`escoresheet/backend/**`), the Node LAN relays (`frontend/electron/lanRelayCore.cjs` and its
users), the Rust relay (`frontend/src-tauri/src/relay.rs`) and the app UI
(`frontend/src/**`, plus the static phone page in `frontend/public/sign/`). Section 4 is the
interface. Its paths, bodies, responses and error codes are exact and are the same on all three
relays.

Production rules still apply. Never push, tag or deploy, and never touch production. Postgres tests
run only against a throwaway `postgres:17-alpine` container (tmpfs, `--rm`, random port, unique
name) with an `OV_PIN_SECRET` of at least 40 characters. Stop the container afterwards. Never use
`pkill -f` or `pgrep -f`. Never pass `--no-verify` (gitleaks). Stage paths explicitly and never
commit `node_modules`. Put Cargo target dirs under `/home/lucanepa/.cache/openvolley/`. UI uses
the /volleyui kit and `backdropDismiss`. Every new string ships in en, de, de-CH, fr and it.

---

## 0. Owner request → design

Luca: *"also add the possibility like in svrz_rc to QR code sign please"*.

In svrz_rc a person signs on their own phone. The app shows a QR code, the phone opens a signing
page, the person draws, and the signature lands back in the open form. This spec brings the same
feature to every signature slot in OpenVolley. It has to work online and at a venue without
internet, which svrz_rc never needed.

| # | Design | In one line |
|---|---|---|
| 1 | **Every pad gets "Sign on phone"** | The shared `SignaturePad` modal gains a "Sign on phone" button. It shows a QR code, the link to copy or share, and a live status. All signature slots get it: post-match captains, assistant scorer, scorer, 2nd and 1st referee, pre-match coaches and captains (coin toss and match setup), and the scoreboard's post-match captain pads. |
| 2 | **Two transports, one protocol** | (a) **Cloud:** `backend.openvolley.app`. (b) **Venue LAN:** the laptop's own relay (Tauri, Electron, `server.js`, `backend/server.js --local`), with the phone on the hall Wi-Fi or on the laptop's own Wi-Fi. The endpoints, bodies and codes are identical on all three relay implementations. |
| 3 | **Short-lived single-use capability** | 256-bit random token, valid 10 minutes, one submit only. The relay stores only its SHA-256. It rides in the URL **fragment**, so it never reaches a server log. The waiting device holds a second secret, the **watch** secret, and only that secret can read the result. |
| 4 | **The phone sends strokes, not an image** | The phone sends its pen strokes as integer coordinates. The waiting device draws them with the same black 4 px round pen as the local pad and stores the result as the same transparent PNG data URL in the same field. The relays never parse an image. |
| 5 | **The waiting device long-polls** | `POST /api/sign/wait` holds for up to 25 s and returns on any state change. No WebSocket change is needed on any relay (reasons in 4.6). |
| 6 | **Tiny standalone phone page** | `/sign` is three static files (HTML, JS, CSS, about 15 KB). It loads no app bundle, no service worker, no fonts and no account. It shows the match and the role ("Sign as captain of Team A, match #4711"), a large pad that works in portrait, and "Clear" / "Done". |
| 7 | **Same data, same PDF** | The image goes through the same `onSave(dataUrl)` path as a drawn one. The PDF code does not change. "Signed on phone" is recorded beside the signature in `match.signatureSources` and in the approval JSON, not on the PDF. |
| 8 | **Clear when impossible** | When neither transport is possible, the button stays visible but disabled, with one sentence saying why and what to do. Signing on the device always stays available. |

Decisions this spec makes. Each is flagged so the owner can overrule it:

- **D1 Strokes instead of PNG or SVG upload.** The brief asked for "PNG/SVG sanitised". Not accepting any image at all is stricter: no PNG chunk walker in Rust, no SVG sanitiser, no polyglot files, and the result is pixel-identical in style to a local signature. The cost: a phone signature can't carry pressure or colour, and neither can the local pad.
- **D2 Cloud start needs a signed-in account** with a scorer or referee role (indoor or beach), or admin. This is the same caller rule as account approval (R2). Phones never need an account. An anonymous web scorer on `app.openvolley.app` has no relay of its own, so it sees "Sign in to sign on a phone" there. svrz_rc has the same rule: starting needs the coach session.
- **D3 LAN start** needs the request to come from the relay host itself (the existing `isLocal` check behind register-main), **or** the match's **game PIN** in `X-OV-Match-Pin` for a match that relay holds. A wrong PIN counts toward the existing per-IP wrong-PIN limiter. A scorer on a Pi or `server.js` relay is a different machine and proves the game PIN. The Tauri and Electron app is the host itself.
- **D4 Sessions live in memory** on every relay. Nothing goes to Postgres. A backend restart during the 10 minutes ends the session, and the dialog says "Link expired, make a new one". This keeps signatures out of the database and the backups, and the code is the same shape on all three relays. The cloud backend is one process today. If it ever runs several instances, sessions move to a table that holds only hashes (section 9).
- **D5 Preview before use.** When the strokes arrive, the dialog shows the rendered signature with "Use signature" and "Discard". It does not fill the slot silently as svrz_rc does. A link copied into a chat could otherwise put a stranger's signature on the result. It costs the same single tap as "Save" on the local pad.
- **D6 Cloud first when both transports work.** A phone with mobile data reaches the cloud without joining any Wi-Fi. When the laptop has a LAN relay and is also online, the dialog offers a two-way switch, "Internet" or "Hall network". The choice is remembered per device.
- **D7 One phone session at a time, per open dialog.** Closing the dialog cancels the session, as in svrz_rc: the session is watched only while the dialog is open. MatchEnd's signing order already makes the officials sequential. Running both captains' phones in parallel is listed under later (section 9).
- **D8 Out of scope:** `UploadRosterApp` (team managers already sign there on their own device and have no scorer account), and the `scoresheet_pdf` `SignatureModal` in `FooterSection` `Roster`. That modal keeps signatures in React state only and never saves them, so it is a print-view scratch pad, not a slot. OpenVolley has no protest or remarks signature today (no "protest" anywhere in `src/` or `scoresheet_pdf/`). If one is added, it uses the same `SignaturePad` prop and gets this feature for free.

### 0.1 Found while studying (fix as part of this branch)

- **B1** `Scoreboard.jsx` (~28081) renders `<SignaturePad onSave onCancel />` inside its own `Modal` **without `open`**. `SignaturePad` passes `open` to `Modal`, and `Modal` returns `null` when `!open`. So the scoreboard's post-match captain dialog opens **empty**. `onCancel` is also not a prop of `SignaturePad`. Fix: drop the outer `Modal` and render `<SignaturePad open={!!postMatchSignature} onClose=… onSave=… title=…/>`.
- **B2** The same bug is in the `CoinToss.jsx` roster modal (~2160, the coach and captain buttons under "Signatures"). Fix it the same way.
- **B3** The LAN sweeper timer (4.5) must not live at module level. Per the known `vite build` hang (a module-level `setInterval` in `vite-plugin-api-routes.js` keeps every `vite build` alive), create it lazily inside `createLanRelay`, `.unref()` it, and clear it in the relay's `close()`.

---

## 1. How svrz_rc does it (the reference, read-only)

| Piece | svrz_rc | Kept / changed here |
|---|---|---|
| URL | `signUrlFor(slug) = origin + '/#/sign/' + slug` (App.tsx 727). The slug is in the fragment and served from `/`, so the form's own path never leaks into the link. | Kept: the token is in the fragment. The page is a separate static page, not a route of the app bundle. |
| Start | `POST /api/signature/start` behind `requireRcSession`, rate-limited at 30 per 5 min per coach (key: RC id, else IP). Slug `randomUUID()` without dashes (122 bits). Stores `{slug, context ≤300, signer ≤120, data:'', signed:false}` in a PocketBase collection. | Kept: auth on start, rate limit. Changed: 256-bit token, stored **hashed**, in memory, typed context fields instead of one free string. |
| Phone reads | `GET /api/signature/:slug` returns context, signer and `signed`, **and the image once signed, to anyone holding the slug**. The 7-day signed TTL and log redaction (`logguard`, `redactIcalToken`) were added later to contain that. | **Changed:** the token can open and submit only. The image (strokes) goes only to the holder of the separate **watch** secret, and only until the session closes. No token appears in any URL path, so there is nothing to redact. |
| Phone writes | `POST /api/signature/:slug` `{data, signer}`, per-IP limit 30 per 5 min, `data:image/` prefix and size ≤ 2 MB only, write-once under a per-slug in-process lock (409 on a second write). | Kept: write-once, per-IP limit, per-session serialisation. Changed: strokes with strict bounds instead of any `data:image/*`, and the body is capped at 64 KB. |
| Expiry | 24 h unsigned, 7 d signed. A nightly prune deletes rows. | **10 min** to sign. Strokes are kept ≤ 5 min after signing or until the watcher closes. A sweeper runs every 60 s, and nothing is persisted. |
| Waiting side | `setInterval` polls `GET` every 3 s while the dialog is open. When the image arrives it fills the slot and closes the dialog. | Long-poll (one request in flight, instant). Preview and confirm (D5). |
| Phone page | `SignaturePage.tsx` inside the app bundle: logo, context line, name input, pad, "Löschen" / "Bestätigen". States: loading, ready, saving, done, error. A failed save keeps the strokes. | Same states plus expired, used and cancelled. No name input (the slot already knows the role; the scorer side knows the name). Strokes survive rotation and resize. Its own five-language string table. |
| Hand the link | "Send link" (`navigator.share`), else "Copy link", with the hint "keep this dialog open until the signature arrives". If the clipboard is refused, a toast points at the QR (App.tsx 1968–1990). | Kept as is. |
| No server | Demo mode: no QR. "In the demo you can only sign here." An offline start error shows "not available (offline), signing here works" and still shows the pad. | Kept as a principle: the pad is always there. Each impossible case gets its own reason (5.4). |

---

## 2. The signature slots in OpenVolley today

Every slot stores a **transparent PNG data URL** (`canvas.toDataURL('image/png')`, black, line
width 4 CSS px, round caps and joins, canvas 100 % × 200 px × devicePixelRatio) on the Dexie
`matches` row:

| Where | Slot (role key) | Field | Saved by |
|---|---|---|---|
| `MatchEnd.jsx` | `captain-a`, `captain-b` | `homePostGameCaptainSignature` / `awayPostGameCaptainSignature` (A/B by `coinTossTeamA`, `signatureFieldOf`) | `handleSaveSignature` → `db.matches.update` |
| `MatchEnd.jsx` | `asst-scorer`, `scorer`, `ref2`, `ref1` | `asstScorerSignature`, `scorerSignature`, `ref2Signature`, `ref1Signature` | same. Scorer and referees may instead be complete through an account approval (`slotComplete`). |
| `Scoreboard.jsx` (post-match panel) | home and away captain | `home/awayPostGameCaptainSignature` | inline `db.matches.update` (B1) |
| `CoinToss.jsx` | home and away coach and captain (menus A/B, and the roster modal) | `home/awayCoachSignature`, `home/awayCaptainSignature` | React state, written on coin-toss confirm (`updateData.*Signature`) |
| `MatchSetup.jsx` | home and away coach and captain (three pad instances) | same four fields | `handleSignatureSave` → state → saved with the setup |

Downstream, unchanged by this spec:

- **PDF:** `scoresheet_pdf/App_Scoresheet.tsx` → `FooterSection.tsx` (`getSignatureForRole`, `getCaptainSignature`) renders the image or the account-approval text.
- **Cloud:** the post-match images go up once, inside `approval.signatures` with the `status:'approved'` sync-queue update (MatchEnd ~1120).
- **Relays:** every relay strips any key matching `/signature/i` from what it hands out (`publicColumns.js`, `lanRelayCore.cjs` `MATCH_PRIVATE_FIELDS`, `relay.rs`). The new `signatureSources` key matches that pattern too, so it never leaks to tablets.
- **Reopen:** `clearedPostMatchSignatures()` (`domain/matchEnd.js`) nulls the post-match fields.

---

## 3. End-to-end flow

```
Scoring device (waiting)              Relay (cloud or LAN)                     Phone
───────────────────────────           ──────────────────────────               ─────────────────
tap "Sign on phone"
POST /api/sign/start ───────────────► check auth (D2/D3), caps
  {slot, matchKey, context}            token, watch = 32 random bytes each
                                       store by sha256(token), sha256(watch)
◄───────── 201 {token, watch, expiresAt}
show QR  <phoneBase>/sign#k=<token>
POST /api/sign/wait {watch} ────────► (held ≤25 s)
                                                                               scan QR → GET /sign (static)
                                                                               JS: k from fragment → sessionStorage,
                                                                               strip fragment
                                       ◄──────────────────────────────────── POST /api/sign/open {k}
                                       state pending→opened ──► wait returns
◄───────── {state:'opened'}            ────────────────────────────────────► {context, expiresAt}
"Opened on a phone…"                                                           draw, "Done"
POST /api/sign/wait {watch} ────────►  ◄──────────────────────────────────── POST /api/sign/submit {k, pad, strokes}
                                       validate, state→signed (token now dead)
◄───────── {state:'signed', pad, strokes}  ────────────────────────────────► {ok:true} → "Signature sent"
render strokes → PNG data URL
preview: "Use signature" | "Discard"
POST /api/sign/close {watch} ───────► delete session
onSave(dataUrl, {source})  →  same field, same PDF
```

`<phoneBase>` is the cloud backend origin (`getCloudApiBaseUrl()`, e.g.
`https://backend.openvolley.app`) for the cloud. For the LAN it is
`http://<laptop LAN address>:<http port>`, chosen as in 5.2.

---

## 4. Protocol (identical on `backend/server.js`, `lanRelayCore.cjs`, `relay.rs`)

### 4.1 Session record (memory only)

```
{
  tokenHash   : hex sha256(token)       // map key 1
  watchHash   : hex sha256(watch)       // map key 2
  ref         : first 8 hex of tokenHash  // the only id ever logged
  state       : 'pending' | 'opened' | 'signed'
  slot        : one of SLOTS (4.3)
  matchKey    : string ≤128 | null      // seed_key / room key, for the log and caps
  context     : CONTEXT (4.3), sanitised
  owner       : cloud: user id; LAN: 'local' or 'pin:<matchKey>'
  createdAt, expiresAt (= createdAt + 600 s), openedAt?, signedAt?
  pad?, strokes?                        // only once signed
  waiter?                               // the one pending /wait response
}
```

Tokens: 32 bytes from the CSPRNG (`crypto.randomBytes`, `getrandom` / `rand::rngs::OsRng`),
base64url without padding, exactly 43 characters `[A-Za-z0-9_-]`. A presented token or watch
secret that is not 43 such characters gets the not-found answer before hashing. Lookup is by hash
in a map. No comparison is done on secrets, so no timing concern applies. SHA-256 without a key is
enough because the input has 256 bits of entropy.

**Lifetimes.** An unsigned session dies at `expiresAt` (10 min). A signed session lives until
`close`, or `signedAt + 300 s`, whichever comes first, and never past `createdAt + 900 s`.
Expired sessions answer as described in 4.4 for 60 s more (a "tombstone" with only the hashes,
the state and the time), so the phone can say "expired" instead of "invalid". After that they
are gone.

**Caps** (constants exported for tests; cloud / LAN):

| Cap | Cloud | LAN |
|---|---|---|
| live sessions in total | 2000 | 200 |
| live sessions per owner | 20 | 20 |
| `start` per owner | 30 / 5 min | 60 / 5 min |
| `open` + `submit` per IP bucket (IPv6 /64, the existing `ipBucketKey`) | 120 / 5 min | 600 / 5 min |
| `wait` concurrent in total | 1000 | 200 |
| `wait` concurrent per session | 1 (a new `wait` answers the older one at once with the current state) | same |
| request body | 64 KB on submit, 4 KB otherwise | same |

A hall is one NAT, so the per-IP buckets are generous. The token's entropy is the real defence,
and the buckets only stop floods. A cap that is hit answers 429 `OV_SIGN_RATE_LIMITED` with
`Retry-After`. A full table answers 503 `OV_SIGN_BUSY`.

### 4.2 Endpoints

All are `POST` with a JSON body, `Content-Type: application/json`, `Cache-Control: no-store` on the
response, and every answer is JSON `{ ok, … }` or `{ ok:false, code, message }`. No secret ever
appears in a URL path or a query string.

| Endpoint | Caller | Auth | Body | 2xx answer |
|---|---|---|---|---|
| `/api/sign/start` | scoring device | cloud: `Authorization: Bearer <session>` + role (D2). LAN: `isLocal(addr)` **or** `X-OV-Match-Pin: <game PIN>` of `matchKey` (D3) | `{ slot, matchKey?, context }` | 201 `{ ok, token, watch, expiresAt, ttlSeconds: 600, path: '/sign' }` |
| `/api/sign/open` | phone page | the token | `{ k }` | 200 `{ ok, state:'pending'\|'opened', slot, context, expiresAt }`. Moves `pending → opened` and wakes the waiter. Repeatable (a page reload). |
| `/api/sign/submit` | phone page | the token | `{ k, pad:{w,h}, strokes }` (4.3) | 200 `{ ok:true }`. Moves `→ signed`. From then on the token is dead (single use). |
| `/api/sign/wait` | scoring device | the watch secret | `{ watch, known?: state }` | 200 `{ ok, state, openedAt?, signedAt?, expiresAt, pad?, strokes? }`. The request returns at once when the state differs from `known`, else when it changes, else after 25 s with the same state. |
| `/api/sign/close` | scoring device | the watch secret | `{ watch }` | 200 `{ ok:true }`. Deletes the session, then answers the waiter (`state:'closed'`) and a later `open`/`submit` (`OV_SIGN_CANCELLED`). Idempotent: an unknown watch secret also gets 200. |

Cloud CORS: `start`, `wait` and `close` come from the app origins and use the existing
`lib/cors.js` allowlist (`Authorization` header, as `/api/approvals` does). `open` and `submit`
come from the page the backend serves itself, so they are same-origin and need no CORS entry. On
the LAN relays all calls are same-origin, or loopback for the Tauri webview at
`http://localhost:5173`.

Logging: one line per transition, `sign.start|open|submit|close|expire ref=<8 hex> slot=… via=cloud|lan`.
Never log the token, the watch secret, the context or the strokes. The backend's request logger
already prints paths only. These paths hold no secret, so `logguard` needs no new rule. Add a test
that proves it (8.1).

### 4.3 Shapes and validation (the same rules in JS and Rust; shared vectors in 8.4)

```
SLOTS = captain-a | captain-b | asst-scorer | scorer | ref2 | ref1      // post-match
      | coach-home | coach-away | captain-home | captain-away         // pre-match
      | captain-post-home | captain-post-away                         // scoreboard panel

CONTEXT = {
  matchNo?: string ≤ 20       // "4711"; game_n, or omitted
  home:     string 1..60      // team names as shown on the device
  away:     string 1..60
  teamSide?: 'home' | 'away'  // which one the signer belongs to (captains, coaches)
  teamLabel?: 'A' | 'B'       // coin-toss letter when known
  name?:    string ≤ 80       // signer's name if the device knows it (captain #, official)
  when?:    string ≤ 32       // display date "12.10.2026 20:15" made by the device
  lang?:    'en'|'de'|'de-CH'|'fr'|'it'  // the scorer's UI language, a fallback only
}
```

Sanitising: every string goes through NFC normalisation, all C0, C1 and bidi-control characters
(U+202A–202E, U+2066–2069) are removed, whitespace is trimmed, and the field is cut to its cap.
An empty `home` or `away` → 400 `OV_SIGN_CONTEXT`. Unknown keys are dropped. An unknown `slot` →
400 `OV_SIGN_SLOT`. The phone page renders every value with `textContent` only.

```
pad     = { w: 4000, h: integer 1000..4000 }      // pad box, x always spans 0..4000
strokes = [ [x0,y0, x1,y1, …], … ]                // flat integer arrays
  1 ≤ strokes.length ≤ 300
  each stroke: even length, 2 ≤ length ≤ 2000      // one point = a dot
  Σ points ≤ 4000
  every x integer in 0..pad.w, every y integer in 0..pad.h
  ink check: total polyline length ≥ 0.06 · pad.w  (blank pads and lone taps fail)
```

On failure: 400 `OV_SIGN_INK_INVALID`. A body over 64 KB: 413 `OV_SIGN_TOO_LARGE`. The relay
reads at most 64 KB and stops; it never buffers more. It stores `pad` and `strokes` exactly as
validated and returns them unchanged through `wait`.

### 4.4 Codes

| HTTP | `code` | When |
|---|---|---|
| 400 | `OV_SIGN_BAD_REQUEST` | body not JSON, or a wrong type |
| 400 | `OV_SIGN_SLOT` / `OV_SIGN_CONTEXT` / `OV_SIGN_INK_INVALID` | 4.3 |
| 401 | `OV_AUTH_REQUIRED` | cloud start without a valid session (existing code) |
| 403 | `OV_SIGN_FORBIDDEN` | cloud: the role rule (D2); LAN: not local and no PIN that grants the match |
| 403 | `OV_SIGN_PIN_INVALID` | LAN: wrong game PIN (counted, no oracle beyond the existing validate-pin) |
| 404 | `OV_SIGN_NOT_FOUND` | unknown token or watch secret (and malformed ones) |
| 409 | `OV_SIGN_USED` | `open`/`submit` after `signed` |
| 409 | `OV_SIGN_CANCELLED` | `open`/`submit` after `close` (tombstone) |
| 410 | `OV_SIGN_EXPIRED` | past `expiresAt` (tombstone) |
| 413 | `OV_SIGN_TOO_LARGE` | body cap |
| 429 | `OV_SIGN_RATE_LIMITED` | 4.1 caps, with `Retry-After` |
| 503 | `OV_SIGN_BUSY` / `OV_SIGN_UNAVAILABLE` | table full / the feature is switched off (`OV_SIGN_DISABLED=1`) |

Two simultaneous `submit`s for one token (a double tap, two phones on one QR) run one after the
other on the session. Node is single-threaded, and Rust takes the session's `Mutex`. The first
one wins and the second gets 409 `OV_SIGN_USED`, as svrz_rc's `withCapabilityLock` does.

### 4.5 Where it lives in each relay

- **Shared pure core** `frontend/electron/signSessionCore.cjs`: dependency-free CommonJS like `lanRelayCore.cjs`, so the packaged Electron app can `require()` it, and with no `require()` inside it (the Vite config bundler turns it into ESM). It exports `createSignSessions({ now, randomBytes, sha256, caps })`, which returns `start/open/submit/wait/close/sweep/close()`, plus `validateContext` and `validateStrokes`. `createLanRelay` creates one instance and serves `/api/sign/*` in its `handleApi` beside `/api/match/*`. That covers `server.js`, the Vite dev plugin and Electron's `relayServer.js`. Per B3, the sweeper is created lazily, with `.unref()`, and cleared on close.
- **`backend/server.js`**: `backend/lib/signSessions.js` is an ESM copy of the core. It is GENERATED from the `.cjs` by `frontend/scripts/make-sign-core.mjs`, in the way `lib/brandMark.js` is generated, because the backend's Docker context does not contain `frontend/`. A frontend vitest fails when the copy drifts. Routes go next to `/api/approvals`. In `DB_MODE` (cloud) start uses D2 through `getDataLayer().auth.requireUser` and `accessFromRoles`. In `IS_LOCAL` (`--local`, the SEA) start uses D3 with the relay's own `activeMatches` PIN store.
- **`relay.rs`**: a Rust port in a new `src-tauri/src/sign.rs`, wired in `relay.rs`'s router (`.route("/api/sign/start", post(…))`, and so on). It takes a `tokio::sync::Mutex<HashMap>`, the waiter is a `oneshot::Sender`, and `wait` races it against `tokio::time::sleep(25 s)`. The existing `is_local(&addr)` and the stored game PIN cover D3. The sweeper is a `tokio::spawn` interval tied to the relay's shutdown.

### 4.6 Why long-poll and not the WebSocket

- On the Tauri, Electron and `server.js` relays the role socket sits on a **separate port** (8080) from HTTP (5173). The phone never opens a socket at all, and the sign API belongs with the HTTP API.
- On the cloud the scoring device writes over HTTP (`/api/db`, the sync queue). It holds a role socket only for tablets and a `?purpose=live` hub socket only for subscriptions, and neither is guaranteed to be open while MatchEnd is shown.
- Long-poll is the same 30 lines in all three runtimes. It survives a socket reconnect, and it needs no new message type in the three WS protocols that are already kept in sync by hand.
- 25 s stays well under Cloudflare's 100 s idle limit. The cost is one held request per open dialog, bounded by the `wait` caps.

### 4.7 The phone page is served at `/sign`

- **Source:** `frontend/public/sign/index.html`, `sign.js`, `sign.css`. Vite copies `public/` to `dist/` as is, so every LAN relay already serves it: `server.js`, Electron, the Tauri embedded `dist` (`/sign` → `sign/index.html` through `serve_asset`), and the SEA's embedded assets.
- **Cloud:** the backend has no `dist`, so `backend/lib/signPage.js` (GENERATED from the three files by the same script) exports them as strings. `server.js` serves `GET /sign`, `/sign/`, `/sign/sign.js` and `/sign/sign.css`. The phone page URL online is therefore `https://backend.openvolley.app/sign#k=…`. It is same-origin with its API, so it needs no CORS, no allowlist of API origins, and none of the app domain's service worker.
- **Headers for `/sign*`** (all relays): `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, plus `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and `Cache-Control: no-cache`. There is no inline script, because the backend's global CSP is `script-src 'self'`.
- **PWA:** add `/^\/sign(\/|$)/` to `navigateFallbackDenylist`. Leave `sign/**` out of the precache globs: the app never opens the page itself.

---

## 5. App side

### 5.1 Files

| File | What |
|---|---|
| `src/lib/phoneSignApi.js` | `startPhoneSign({ transport, slot, matchKey, context, gamePin })`, `waitPhoneSign(handle, known, { signal })`, `closePhoneSign(handle)` (also sent with `fetch(…, { keepalive: true })` on `pagehide`). `handle = { transport, apiBase, phoneBase, token, watch, expiresAt }`. |
| `src/domain/phoneSignature.js` | Pure: `validateStrokes` (same rules as 4.3), `fitTransform(pad, strokes) → {scale, dx, dy}`, `drawStrokes(ctx, pad, strokes, opts)`, `phoneSignatureDataUrl(pad, strokes, { createCanvas })`. |
| `src/utils/phoneSignTransport.js` | `availableTransports({ online, signedIn, access, relayStatus, backendUrl })` → `{ cloud: ok\|reason, lan: ok\|reason, default }` (5.2, 5.4). |
| `src/components/signature/PhoneSignPanel.jsx` | QR, link actions, status, transport switch, Wi-Fi join QR, reasons. |
| `src/components/SignaturePad.jsx` | New optional prop `phone`. `onSave(dataUrl, meta)` gains a second argument. |
| callers | MatchEnd, Scoreboard (B1), CoinToss (both pads, B2), MatchSetup (three pads). |

### 5.2 Choosing the transport and the address

- **Cloud** is possible when all of these hold: `navigator.onLine`; `getCloudApiBaseUrl()` is set; the device is signed in; the access rule of D2 holds (the client copy of `callerMayApprove` in MatchEnd, generalised to beach roles); and the page is not `isCloudBlockedOnThisPort()`. `phoneBase` = `apiBase` = `getCloudApiBaseUrl()`.
- **LAN** is possible when the page has a relay to talk to, that is `getLocalServerStatusUrl()` answers (the Tauri and Electron webview at `http://localhost:5173`, a `server.js` or Pi relay, the dev server), or the backend override is a LAN relay (`isLanBackendUrl`); **and** that relay's `/api/server/status` lists at least one address a phone can open (`hallInterfaces(status)`, which includes the laptop's hotspot). `apiBase` is the relay origin. `phoneBase` is `http://<ip>:<port>`. When the page itself was opened by LAN IP, that origin is used directly.
- **Which address:** the one the scorer last chose in "Connect tablets" (`ov_connect_tablets_view`: `lanMode` hall or laptop, and the selected hall IP), else the first `hallInterfaces` entry. When there is more than one, a small `SegmentedControl` in the panel switches between them, with the same labels as `HallPanel`.
- **Laptop's own Wi-Fi** (`lanMode:'laptop'` and `hotspot.status().active`): the panel shows step 1, a Wi-Fi QR (`wifiQrString(displayedWifi(status))`) with "Join this Wi-Fi first", then step 2, the signing QR. On Windows, when `needsFirewallStep(fw, hotspotStatus)` holds, it shows the existing firewall hint.
- **Default** (D6): cloud when it is possible, else LAN. When both are possible, the panel shows "Internet · Hall network", and the choice is stored in `localStorage` key `ov_phone_sign_transport` (with try/catch).
- **LAN start auth:** the request carries `X-OV-Match-Pin: match.gamePin` when the page is not on the relay host. The match is the one the scorer publishes to that relay (`relayMatchKey(match)`). From the Tauri or Electron webview, `isLocal` is enough and no PIN is sent.

### 5.3 The panel (inside the `SignaturePad` modal)

`SignaturePad` gets `phone = { slot, matchKey, context, match }`. When it is present, the footer
gets a quiet `Button variant="secondary" icon={Smartphone}` "Sign on phone", left of
Clear/Cancel/Save. Tapping it replaces the canvas area with `PhoneSignPanel`. "Sign here instead"
brings the canvas back and closes the session. Nothing is started before the tap, unlike
svrz_rc, which started a session on every open.

Panel states (volleyui: white card, stone hairlines, sentence case, h-11 actions):

1. **Starting.** A skeleton the size of the QR.
2. **Waiting.** A `QRCodeSVG` of `<phoneBase>/sign#k=<token>`, level M, 200 px in a white box with a quiet zone. Under it, the link in a mono, truncated row with **Copy link** (`copyToClipboard`), or **Send link** when `navigator.share` exists (as svrz_rc). The hint: "Scan with the phone camera. Keep this window open until the signature arrives." A countdown: "Link valid for 9:41". The status line "Waiting for the phone…" (amber, spinner). With LAN, a 45 s timer: if the state is still `pending`, it adds "Phone can't open it? Some hall Wi-Fis block devices from reaching each other. Use the laptop's own Wi-Fi or the internet." with a link that opens Connect tablets.
3. **Opened.** "Opened on a phone. Waiting for the signature…"
4. **Received.** The rendered PNG on the white pad surface (same box as the canvas), the line "Signed on phone", and the actions **Discard** (ghost) and **Use signature** (positive). Use → `onSave(dataUrl, { source: 'phone', transport })` → close the session → close the modal. Discard → close the session → back to state 1 with a fresh session.
5. **Expired / cancelled / error.** One line saying what happened, plus **New link**. A start that fails because the device is offline or the cloud is unreachable falls back to the other transport when it is possible, else to 5.4.

Closing the modal by any route (backdrop through `backdropDismiss`, ×, Cancel, unmount) aborts the
`wait` (`AbortController`) and sends `close`.

The context for each slot is built by one helper, `phoneSignContext(match, role, { teams,
officials, i18n })`, in `src/domain/phoneSignature.js`:

| slot | `teamSide` / `teamLabel` | `name` |
|---|---|---|
| captain-a/b, captain-post-* | the side and the A/B letter | `"#<captain number> <name>"` when the roster has it |
| coach-home/away, captain-home/away | the side, and A/B once the coin toss has decided | coach name / captain |
| scorer, asst-scorer, ref1, ref2 | — | official's name from `match.officials` when set |

### 5.4 When it is not possible (the button stays, disabled, with the reason as its subtitle)

| Situation | Text (en) |
|---|---|
| no transport at all | "Sign on phone needs the internet or the hall network. Neither is available here: sign on this device." |
| online, not signed in, no relay | "Sign in to sign on a phone over the internet. Or sign on this device." |
| signed in without a scorer, referee or admin role, no relay | "Your account can't start phone signing yet. Sign on this device." |
| relay present, but no address a phone can reach | "No network for phones: connect this laptop to the hall Wi-Fi or turn on its own Wi-Fi (Connect tablets)." |
| `match.test` | allowed (practice), as with account approval (D6 there) |

### 5.5 Rendering the strokes (same data as a drawn signature)

`phoneSignatureDataUrl` draws on a canvas of **1200 × 400** device pixels: a logical 600 × 200
surface at scale 2, the size of the local pad at a typical dpr. It is transparent.

1. Bounding box of all points. A margin of 4 % of the pad width on every side.
2. Uniform scale so the box fits 600 × 200 (contain), centred.
3. `strokeStyle '#000000'`, `lineWidth 4` (logical), `lineCap/lineJoin 'round'`, and `moveTo` / `lineTo` per stroke, exactly like the local pad. A one-point stroke becomes a filled circle of radius 2.
4. `toDataURL('image/png')`.

The slot field, the MatchEnd thumbnail, the backup and the PDF then see a value of the same kind
as a locally drawn one.

### 5.6 Recording "signed on phone"

- `match.signatureSources` is a plain object on the Dexie row. It is not indexed, so Dexie needs no new version: `{ [field]: { via: 'phone', transport: 'cloud'|'lan', at: ISO } }`. It is written **in the same `db.matches.update`** as the image, through key paths (`{ [field]: dataUrl, ['signatureSources.' + field]: {...} }`). A drawn signature in that field sets the key path to `null`, so the record always describes the image that is there.
- CoinToss and MatchSetup keep the four pre-match sources in React state beside the images and write them with the same `updateData`.
- `clearedPostMatchSignatures()` also nulls `signatureSources.<f>` for every `POST_MATCH_SIGNATURE_FIELDS` entry. Its test in `domain/__tests__/matchEnd.test.js` is extended.
- **MatchEnd Re-sign / Clear** (`domain/signatureEdits.js`): `writeSignature(role, dataUrl, meta)` is the single writer of a post-match slot. A drawing, a phone result and a Clear all go through it: one `db.matches.update` with `signatureUpdate(field, …)` (so Clear and a local re-sign set `signatureSources.<field>` to `null`, a phone result sets the record), then the match's `signatures` sync job at once. A phone result drops a stale account approval exactly as a drawing does. Re-sign and Clear both open the pad, which offers "Sign on phone". Once `signatureEditLocked()` holds (approved, closed or final), MatchEnd passes `phone.locked`: the button is disabled with the lock sentence, no transport is probed, an open panel is unmounted (its session closed), and a late result is not written.
- **Approval JSON** (MatchEnd ~1120): it adds `signatureSources: { captainA: 'phone'|'device', captainB, scorer, asstScorer, ref1, ref2 }`. No server change is needed, because `approval` is JSONB the client writes.
- **UI:** a signed MatchEnd slot shows a 12 px `Smartphone` icon with the tooltip "Signed on phone". The PDF stays unchanged (owner brief: same PDF output).

### 5.7 i18n (namespace `phoneSign.*`, all five locales; de-CH uses "ss")

`signOnPhone`, `signHereInstead`, `scanHint`, `copyLink`, `sendLink`, `linkCopied`,
`copyFailedUseQr`, `validFor` (`{{time}}`), `waiting`, `opened`, `received`, `signedOnPhone`,
`useSignature`, `discard`, `newLink`, `expired`, `cancelled`, `joinWifiFirst`, `transportInternet`,
`transportHall`, `hallBlocked`, `openConnectTablets`, `reasonNone`, `reasonSignIn`, `reasonRole`,
`reasonNoNetwork`, `startFailed`, `step1`, `step2` (the Wi-Fi then link QR captions; `connectTablets.step1/2` went with the Connect tablets redesign).

The existing `localeKeys`, `missingKeys`, `duplicateKeys` and `sentenceCase` tests cover them.

---

## 6. The phone page (`frontend/public/sign/`)

**Budget:** about 15 KB uncompressed for all three files together, no external request, and it
loads in under 1 s on a 3G hall connection.

**Boot.** Read `k` from `location.hash` (`#k=<43 chars>`). Put it in `sessionStorage`
(`ov_sign_k`, in try/catch) and `history.replaceState` the fragment away, so a screenshot or a
shared tab does not carry it. On reload, take `k` from `sessionStorage`. Then call `POST
/api/sign/open`.

**Language:** the first of `navigator.languages` that matches de-CH, de, fr, it or en (`de-*`
other than CH → de), else `context.lang`, else en. All strings live in one table inside
`sign.js`, and the five locales match the app's tone.

**Layout** (portrait first, volleyui tokens copied as CSS variables, Inter from the system stack,
light only like paper):

```
┌──────────────────────────────┐
│  ● OpenVolley   (inline SVG) │
│                              │
│  Sign as captain of Team A   │  h1, 20 px semibold
│  VBC Wiedikon – Volley 05    │  14 px stone-600
│  Match #4711 · 12.10.2026    │
│  #7 Lea Muster               │  (when known)
│ ┌──────────────────────────┐ │
│ │                          │ │  white pad, stone-300 hairline, radius 12
│ │ ________________________ │ │  faint baseline at 70 % height, "Sign here" hint
│ └──────────────────────────┘ │  until the first stroke
│  [ Clear ]      [   Done   ] │  48 px tall, Done = positive, disabled until ink
└──────────────────────────────┘
```

- **Pad size:** full width minus 32 px. Height = `clamp(180px, 0.55 × width, 45vh)` in portrait and `min(0.33 × width, 60vh)` in landscape. `touch-action: none` on the pad, `overscroll-behavior: none` on `html`/`body`, and `user-select: none` with `-webkit-touch-callout: none` on the pad.
- **Input:** Pointer Events, with `getCoalescedEvents()` where supported and `setPointerCapture`. One pointer at a time; a second finger is ignored. Points are kept in **pad coordinates** (x 0..4000, y 0..h, integers). The canvas is a view that is redrawn from the stroke list on every resize or rotation. svrz_rc learned this the hard way: resizing a canvas wipes the bitmap. Consecutive points closer than 8 units are dropped, which keeps a normal signature well under the 4000-point cap. When the cap is reached, drawing stops and a hint appears.
- **Pen:** black, width 4 CSS px on screen, the same feel as the local pad.
- **Done** is enabled when the client-side ink check (4.3) passes. It sends `submit`. While sending it shows a spinner and the strokes stay put.
- **States:** loading, ready, sending, **done** ("Signature sent. You can close this page." with a green check), **send failed** (network or 5xx: "Couldn't send. Check the connection and tap Done again." with the strokes kept, as svrz_rc does), **expired** (410: "This link has expired. Ask for a new QR code."), **used** (409 `USED`: "This link was already used."), **cancelled** (409 `CANCELLED`: "Signing was cancelled on the scoring device."), **invalid** (404 or no `k`: "This link is not valid.").
- **No** cookies, analytics, fonts, service worker or `localStorage`. Only `sessionStorage` holds the token, and it is removed on done, used, expired or invalid.
- **Accessibility:** the pad has `role="img"` with an `aria-label` ("Signature pad"). The buttons are real `<button>`s with 48 px targets, the contrast follows volleyui, and state changes go to an `aria-live="polite"` line.

---

## 7. Security summary

| Threat | Mitigation |
|---|---|
| Token in logs, referrers, history | Fragment only, stripped on load. API secrets only in POST bodies. `no-referrer`. |
| Guessing a token | 256 bits. Per-IP limits on `open` and `submit`. Live for 10 min. |
| Reading someone's signature | Strokes go only to the watch secret, which never leaves the scoring device's memory, and are deleted on close or within 5 min. svrz_rc's "anyone with the slug can GET the image" is not possible here. |
| Replay or second phone | Single use: `signed` kills the token, and a second submit gets 409. |
| Leaked link, stranger signs | 10 min life, the QR is shown on the scoring device only, D5 preview before use, closing the dialog cancels. |
| Malicious image (polyglot, decompression bomb, SVG script) | No image accepted (D1). Bounded integers only, rasterised by the scoring device. |
| Context injection on the phone page | Typed, capped, control and bidi characters stripped, `textContent` only, strict CSP without inline script. |
| Abuse of the cloud as a free relay | Start needs an account with a scorer, referee or admin role (D2), with per-user and global caps. |
| Abuse on the LAN | Start is local or needs the game PIN (D3), wrong PINs are counted by the existing limiter, and a LAN IP has a cap of 20 live sessions. |
| Memory exhaustion | Caps in 4.1, body caps read with a hard stop, a sweeper, and tombstones that keep hashes only. |
| Tablets seeing signatures | `signatureSources` and every image field match `/signature/i` and are stripped by all relays (unchanged). |

### 7.1 Review of 2026-10-07: what is left on purpose

- **First to submit wins.** Anyone who sees the QR code before the signer can open the link and send a scribble first. The signer's phone then says "already used", and the scorer sees the result before tapping "Use signature" (D5). Binding the link to the first phone that opens it would close this, at the cost of a protocol change on all three relays. It is worth doing if a hall ever reports it.
- **Plain HTTP on the hall network.** On an open hall Wi-Fi, someone listening can read the token and the strokes, as with every other LAN relay call. The internet way is HTTPS.
- **A `--local` backend behind a reverse proxy on the same machine** sees every caller as itself, so anyone on the Wi-Fi may start a session there. This only gives them a session of their own and no match data.
- **Personal data in the relay's memory.** The signer's name and the teams stay in memory for at most 15 minutes, are never logged, and are shown only to whoever holds the token.

---

## 8. Tests

### 8.1 Backend (`node --test`; the cloud e2e uses the throwaway Postgres)

- `tests/signSessions.test.js` (pure, fake clock and random source) runs the shared vectors (8.4): token format, hashing, every state transition, 10 min expiry, the signed TTL, tombstones for 60 s then 404, caps, the double submit serialised (exactly one 200), `wait` (immediate on a differing `known`, wakes on open and on submit, 25 s timeout, a second `wait` answers the first), and `close` waking the waiter.
- `tests/sign.e2e.test.js` (cloud mode, pg container): start without a session → 401. A pending account → 403. A scorer, a referee and `beach:scorer` → 201. Context sanitising (bidi, control characters, caps). The full flow over HTTP. 64 KB + 1 → 413. 429 at the start limit. CORS preflight from `app.openvolley.app` allowed and from an unknown origin refused. `GET /sign` serves the page with the CSP from 4.7. No token, watch secret or stroke in captured stdout or stderr for the whole run.
- `tests/sign.local.e2e.test.js` (`--local`): a loopback start → 201. A non-loopback start without a PIN → 403. With the right game PIN of a synced match → 201. A wrong PIN → 403 and counted.

### 8.2 Node LAN relays (vitest, `src/utils/__tests__/`)

- `signSessionCore.test.js` runs the same vectors against the `.cjs`.
- `lanRelaySign.test.js` uses `createLanRelay`'s `handleApi` with an injected `isLocal`: the same local and PIN rules as the backend; a sweeper exists only after the first start; `close()` leaves no live handle. This is the vite-build-hang guard: assert the relay process has no active timers after `close()`.
- `signCoreCopy.test.js`: `backend/lib/signSessions.js` and `backend/lib/signPage.js` equal the generator's output (drift guard).

### 8.3 Rust (`cargo test`, target dir under `/home/lucanepa/.cache/openvolley/`)

- `sign.rs` unit tests run the shared vectors through `include_str!("../../electron/__fixtures__/sign-vectors.json")`.
- Router tests in `relay.rs`'s existing test module: start from a local and a non-local `ConnectInfo`, the full flow, long-poll wake-up with `tokio::time::pause`, and `/sign` served from the embedded `dist` with the CSP headers.

### 8.4 Shared vectors

`frontend/electron/__fixtures__/sign-vectors.json` holds `{ context: [{in, out|error}],
strokes: [{pad, strokes, ok|error}], flows: [{ steps: [{op, body, at, expect}] }] }`. One file and
three runners: protocol drift between the relays fails a test instead of breaking a hall.

### 8.5 Frontend (vitest)

- `domain/__tests__/phoneSignature.test.js`: `validateStrokes` agrees with the vectors. `fitTransform` contains and centres, and keeps the aspect. `drawStrokes` against a recording fake `ctx` issues the same style properties and `moveTo`/`lineTo` sequence as `SignaturePad`, and a dot becomes an `arc`. The output is a `data:image/png` URL of 1200 × 400 (canvas stubbed).
- `utils/__tests__/phoneSignTransport.test.js`: every row of 5.2 and 5.4, including `isCloudBlockedOnThisPort`, the remembered choice, and the hotspot step.
- `components/__tests__/PhoneSignPanel.test.jsx`: starting, the QR value, copy and share, the countdown, the opened / received / use / discard flow (fake API), closing the modal sends `close` and aborts the wait, the 45 s LAN hint, and fallback to the other transport when start fails.
- MatchEnd: a phone result lands in the right field for each of the six slots (A/B swapped by `coinTossTeamA`), sets `signatureSources`, and drops a stale account approval exactly as a drawn signature does. A later local drawing clears the source. Reopen clears both. The approval payload carries `signatureSources`.
- B1/B2 regression: the Scoreboard and CoinToss roster pads render a canvas when opened.
- `public/sign/__tests__/signPage.test.js` (jsdom, `sign.js` evaluated with a fake `fetch`): fragment stripping, the sessionStorage reload, language choice (de-CH, de-AT → de, fr, it, en), every state text, strokes kept across a resize, Done disabled until there is ink, point thinning, the cap, and strokes kept after a failed send.

### 8.6 Manual, before the owner tries it in a hall

- `npm run build` exits (B3).
- Tauri app on Linux with the phone on the same Wi-Fi: every slot, portrait and landscape. Then with the laptop's own Wi-Fi (Wi-Fi QR first).
- Cloud with the scorer signed in on a dev backend, and the phone on mobile data.
- Phone page on the Android emulator (`/android-emulator` skill) at font scale 1.3 and in portrait. Screenshots go in the PR.
- The PDF of a match signed half on the phone and half on the device: the slots look alike.

---

## 9. Order, ownership, and later

1. **Core and vectors:** `signSessionCore.cjs`, `sign-vectors.json`, the generator script, and the generated `backend/lib/signSessions.js` and `signPage.js` (stubbed page until step 4).
2. **In parallel:** the backend routes (4.5), `lanRelayCore` routes, and `sign.rs`. Each must pass the shared vectors.
3. **App:** `phoneSignature.js`, `phoneSignTransport.js`, `phoneSignApi.js`, `PhoneSignPanel`, the `SignaturePad` prop, then the callers (MatchEnd first, then Scoreboard B1, CoinToss B2, MatchSetup), `signatureSources`, and i18n.
4. **Phone page**, then regenerate `signPage.js`.
5. Tests from section 8, then the manual list. One commit per step, explicit paths.

Later (not in this branch):

- Parallel phone sessions (both captains at once) with a "Waiting for phone" badge on the slot (D7).
- A `sign_sessions` table (hashes, state, strokes nullable, `expires_at`) if the backend ever runs more than one instance (D4).
- openbeach adopts the same panel; its relays already share this protocol.
- An optional "signed on phone" footnote on the PDF, if the federation ever asks for one.

---

## 10. Deploy notes (for the owner; not part of this branch's work)

- The backend image gains `lib/signSessions.js`, `lib/signPage.js` and the routes, with no migration and no new secret. `OV_SIGN_DISABLED=1` switches the feature off (503 `OV_SIGN_UNAVAILABLE`, and the app shows reason "none").
- Cloudflare in front of `backend.openvolley.app` must not cache `/api/sign/*`, which it doesn't for POST. `/sign*` is `no-cache`.
- The desktop apps pick it up with the next release. A scorer on an older desktop relay sees the LAN reason "no network for phones"; `start` returns 404 there and is treated as unsupported.
