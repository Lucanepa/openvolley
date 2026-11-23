# Scoreboard code: any scoreboard follows a match

Every scoreboard (a TV, an HDMI stick, a tablet, an LED board's controller, a
third-party board) can follow a match the way the livescore does. The data was
there already: the PIN-free public live state (with `subs_count_a/b` and
`set_results`), `subscribe-match` on every relay, and the board label
`device: 'display'` (docs/scoreboard-display-spec.md). What was missing was
**finding** the match: the cloud's `GET /api/match/list` shows a match without
the referee connection only to its own venue's address (backend
`cloudListsMatch`), so a board on another network never sees it.

The scorer now shows a short **scoreboard code**. A board that knows the code
finds the match on the relay, on any network, and gets the public live state
only.

## 1. Plan in short

1. **Scorer: "Show on a scoreboard"** (Match ▸ Devices and data, next to Pair a
   phone and Scoreboard settings). A code `ABCD-2345` and a QR code (the board
   page with the code), "New code", the time it is valid. The scoring device
   makes the code itself and keeps it with the match in its own database
   (Dexie `scoreboard_codes`, keyed by the match id), so it survives an app
   restart. It tells its relay the code on its scorer socket; nothing about it
   travels in the match's sync, backups or exports.
2. **Relays: code → room**, identical on the cloud backend, the LAN relay core
   (server.js, the Vite plugin, Electron) and the desktop app's Rust relay. One
   shared core, `frontend/electron/displayCodeCore.cjs` (generated backend copy
   `backend/lib/displayCodes.js` via `scripts/make-sign-core.mjs`, Rust port
   `src-tauri/src/display_code.rs`), shared vectors
   `electron/__fixtures__/display-code-vectors.json`, and one wire contract
   `backend/tests/helpers/displayCodeContract.js` run against every runtime,
   like Pair a phone (#248).
3. **Board: `subscribe-match { code }`** on the relay WebSocket (the existing
   follow flow, allowed by the code whatever `cloudListsMatch` says), or
   `POST /api/display/live { code }` for a board that polls.
4. **Board page** `/board` on the livescore app (`livescore.openvolley.app/board`,
   `<relay>/livescore/board` on a LAN relay): full screen, landscape, the
   volleyball look; names, colours, points, sets, serve, time-outs,
   substitutions, set scores, time-out / set interval / match end; reconnects
   by itself; a code form when it has none. A league game number (1–7 digits)
   works too, through the public game endpoint the TV page already uses.
5. **Docs and clients:** `docs/scoreboard-feed.md` for third-party boards and a
   Node and a Python reference client in `tools/scoreboard-client/`.

## 2. The code

- 8 symbols of `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (32 symbols, no 0/O/1/I):
  40 bits from the device's CSPRNG. Shown `ABCD-2345`; a relay compares it
  upper-cased with spaces and dashes removed (the Pair a phone code's rules).
- **Read-only.** A code gives what a PIN-less subscriber gets: the public
  summary (team names and colours, status, set scores) and the public live
  state (`LIVE_STATE_PRIVATE_COLUMNS` removed on every relay: no line-ups, no
  substitution details, no sanctions, no last event's data). Never a PIN,
  roster, shirt number or match action. A code never widens access: it only
  names a room key, and a room key already gives the public summary without a
  PIN (on a LAN relay every match is listed anyway).
- **One per match.** "New code" makes a new one; the relay forgets the old one
  at once and ends every board that followed by it (`display-code` `ended`).
- **Ends** when the scorer revokes it, when the match is closed (approved) or
  deleted on the scoring device, when the relay drops the room, or 12 hours
  after it was made (`MAX_LIFE_MS`), whichever is first. It stays through the
  match end screen, so a board keeps the final score.
- **Hash at rest, never logged.** A relay keeps `sha256("d:" + code)` only, and
  logs one line per change, `display.<event> ref=<8 hex of the hash> via=…`.
  The code travels only in a WebSocket frame or a POST body, never in a URL
  the server sees: the board page takes it from the fragment
  (`/board#ABCD2345`, also `?code=`, which the page removes from the address).
- **Not guessable at scale.** Wrong codes are counted per address (IPv4, IPv6
  /64): 20 per 5 minutes on the cloud, 60 on a LAN relay, then `rate-limited`
  with a wait, before any comparison. Every lookup counts too (600 / 1200 per
  5 minutes). With 1,000 live codes, one address guesses a code in about
  5·10⁻⁶ of its days.
- **Not stopped by someone else's wrong codes.** A code the address has
  resolved before is answered while it is live on a budget of its own (6,000 /
  12,000 lookups per 5 minutes), never refused for the address's wrong codes:
  the boards of a hall behind one NAT address keep following and polling. On
  the cloud a page of another site (an untrusted `Origin`) counts on a bucket
  of its own per address, so a page or an ad opened on a phone in the hall
  cannot spend the budget of the hall's boards either.

## 3. Wire contract (every relay)

### Scorer → relay (its scorer socket, after its first accepted sync)

```jsonc
{ "type": "display-code-set", "matchId": "<room key>", "code": "ABCD2345", "issuedAt": 1763740800000 }
{ "type": "display-code-set", "matchId": "<room key>", "code": null }          // revoke
```

Only a socket that proved the room (owns it) may send it. The scorer sends it
when the relay tells it `display-presence` (the answer to its first accepted
sync on a socket; relays without it know no codes either), and again on "New
code" and on revoke.

Answer, to that socket only (the code is never echoed):

```jsonc
{ "type": "display-code-state", "matchId": "<room key>", "active": true, "endsAt": 1763784000000 }
{ "type": "display-code-state", "matchId": "<room key>", "active": false, "reason": "expired" }
```

`reason`: `revoked`, `expired` (older than 12 h), `bad-code`, `taken` (another
room has it: make a new one), `not-match-owner`, `busy`, `rate-limited`.

### Board → relay

```jsonc
{ "type": "subscribe-match", "code": "ABCD-2345", "device": "display" }
```

No `matchId`, no PIN (a PIN next to a code is ignored). The relay answers

```jsonc
{ "type": "display-code", "ok": true, "matchId": "<room key>", "endsAt": 1763784000000 }
{ "type": "display-code", "ok": false, "reason": "not-found" }
{ "type": "display-code", "ok": false, "reason": "rate-limited", "retryAfter": 120 }
```

and, on success, subscribes the socket to the room exactly as
`subscribe-match { matchId, device: 'display' }` would (the summary, every
`live-state-update`, `scorer-presence`; the scorer hears `display-presence`).
When the code ends, the relay sends `{ "type": "display-code", "ok": false,
"reason": "ended", "matchId": … }` and takes the socket out of the room.
`unsubscribe-match { matchId }` works as for any subscriber.

### HTTP (POST, JSON or text/plain body, `Cache-Control: no-store`, CORS `*`)

| Request | Answer |
|---|---|
| `POST /api/display/lookup` `{ code }` | `200 { ok, matchId, endsAt }` |
| `POST /api/display/live` `{ code }` | `200 { ok, matchId, endsAt, match, homeTeam, awayTeam, sets, liveState }` |
| errors | `400 OV_DISPLAY_BAD_REQUEST`, `404 OV_DISPLAY_NOT_FOUND`, `410 OV_DISPLAY_ENDED`, `413 OV_DISPLAY_TOO_LARGE`, `429 OV_DISPLAY_RATE_LIMITED` (+ `Retry-After`) |

`match`, `homeTeam`, `awayTeam`, `sets` are the public summary's fields (as in
`match-full-data` with `access: 'summary'`); `liveState` is the public live
state, or `null` before the scorer pushed one.

### Game numbers

A league game's number (1–7 digits) is already public: `GET
/api/global/live/game/<n>` (the TV page's `/tv/<n>`) answers the public score
summary of that official game from the database on the cloud, or the relay's
own room of that number on a venue relay. The board page takes a game number
in the same form and polls that endpoint every 5 s. It has no time-out counts
or substitutions (the summary does not carry them).

## 4. Pieces

| Piece | Where |
|---|---|
| Core (codes, hashes, limits, lifetimes, public live state, HTTP answers) | `frontend/electron/displayCodeCore.cjs`, `backend/lib/displayCodes.js` (generated), `frontend/src-tauri/src/display_code.rs` |
| Vectors | `frontend/electron/__fixtures__/display-code-vectors.json` + `displayCodeVectorRunner.cjs` |
| Cloud relay | `backend/server.js` |
| LAN relays | `frontend/electron/lanRelayCore.cjs` (option `displayCore`, wired by `frontend/lanRelayCore.js`) |
| Rust relay | `frontend/src-tauri/src/relay.rs` |
| Wire contract | `backend/tests/helpers/displayCodeContract.js` |
| Scorer | `src/utils/scoreboardCode.js`, `src/components/scoreboardCode/*`, `components/matchMenu.jsx` (`show-on-scoreboard`) |
| Board page | `src/components/board/BoardApp.jsx`, `src/utils/boardFeed.js`, `src/livescore-main.jsx` (`/board`) |
| Third parties | `docs/scoreboard-feed.md`, `tools/scoreboard-client/` |

## 5. Deploy

Backend (the cloud relay: new message types and `/api/display/*`) and an app
release (scorer menu, board page, LAN relays, desktop relay). Order: backend
first. An older backend ignores `display-code-set` (the scorer's panel then
says the relay does not know codes yet) and answers a code subscription with
`Match ID required`.
