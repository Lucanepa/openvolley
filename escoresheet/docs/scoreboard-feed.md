# The scoreboard feed: follow a match by its scoreboard code

Any scoreboard can show an OpenVolley match: a TV, an HDMI stick, a tablet,
an LED board's controller or a board of your own. The scorer opens **Match ▸
Show on a scoreboard** and gets a code like `ABCD-2345`. With that code a
board finds the match on the relay and follows its score. This page is the
contract for boards that are not OpenVolley's own page (`/board`); the design
is in [scoreboard-code-spec.md](scoreboard-code-spec.md).

The feed is **read-only and public**: team names and colours, points, sets,
serve, time-outs, the number of substitutions, set results, the phase of the
match. It never carries a PIN, a roster, a line-up, a shirt number, a
sanction or a name of a person.

Reference clients: [`tools/scoreboard-client/scoreboard-client.mjs`](../tools/scoreboard-client/scoreboard-client.mjs)
(Node 22+, WebSocket or HTTP) and [`tools/scoreboard-client/scoreboard_client.py`](../tools/scoreboard-client/scoreboard_client.py)
(Python 3, HTTP, standard library only).

```sh
node tools/scoreboard-client/scoreboard-client.mjs --code ABCD-2345
python3 tools/scoreboard-client/scoreboard_client.py --code ABCD-2345 --server http://192.168.1.20:5173
# VBC Musterdorf • 1 | 12 : 9 | 0 Volley Beispiel · set 2 · sets 25:21 · time-outs 1/0 · subs 2/1
```

## 1. Where the relay is

| Scorer scores on | HTTP base | WebSocket |
|---|---|---|
| the cloud (default) | `https://backend.openvolley.app` | `wss://backend.openvolley.app` |
| a relay in the hall (the desktop app, `server.js`) | `http://<relay>:<port>` (e.g. `:5173`) | `ws://<relay>:<wsPort>`; `wsPort` from `GET /api/server/status` |

The QR code in the scorer's panel is the board page on the same relay
(`https://livescore.openvolley.app/board#ABCD2345`, or
`http://<relay>:<port>/livescore/board#ABCD2345` in the hall). A code works on
the relay its scorer is connected to.

## 2. The code

- 8 symbols of `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0, O, 1, I), shown as
  `ABCD-2345`. Send it as typed: the relay ignores case, spaces and dashes.
- One code per match. The scorer can make a new one (the old one ends) or stop
  sharing (it ends). It ends by itself when the match is closed, deleted, or
  12 hours after it was made.
- **Keep it out of URLs that reach a server** (no query strings, no paths):
  send it in a WebSocket frame or a POST body. OpenVolley's own page reads it
  from the fragment (`#ABCD2345`), which browsers never send.
- Wrong codes count per address: 20 per 5 minutes on the cloud, 60 on a hall
  relay. Beyond that every lookup from that address of a code it has not
  resolved before is refused with `rate-limited` and a wait in seconds. A code
  your address resolved keeps resolving while it is live (6,000 / 12,000
  lookups per 5 minutes for those); all other lookups count too (600 / 1200
  per 5 minutes), so poll at most every 2 s. A web page of another site counts
  on its own bucket per address.

## 3. WebSocket (recommended: pushes every change)

Open the WebSocket and send:

```json
{ "type": "subscribe-match", "code": "ABCD-2345", "device": "display" }
```

No `matchId`, no PIN. `device: "display"` tells the scorer a scoreboard
follows (it may add `settingsUrl`, see [scoreboard-display-spec.md](scoreboard-display-spec.md)).
The relay first answers:

```json
{ "type": "display-code", "ok": true, "matchId": "match_17_kq3f", "endsAt": 1763784000000 }
{ "type": "display-code", "ok": false, "reason": "not-found" }
{ "type": "display-code", "ok": false, "reason": "rate-limited", "retryAfter": 120 }
{ "type": "display-code", "ok": false, "reason": "ended" }
```

On `ok`, keep `matchId` (the room key: every later message names it) and
read, for that `matchId`:

| Message | What |
|---|---|
| `match-full-data` | Right after the subscription (when the relay holds the match): `access: "summary"`, `match` (status, game number, scheduled time, sides' connection flags), `homeTeam` / `awayTeam` (`name`, `shortName`, `color`), `sets` (`index`, `homePoints`, `awayPoints`, `finished`), `liveState` (below, or absent before the scorer pushed one) |
| `match-data-update` | The same, whenever the scorer syncs |
| `live-state-update` | `liveState`: after every rally, time-out, substitution, set end |
| `scorer-presence` | `present`: whether the scorer's device is connected |
| `display-code` `ok:false` `reason:"ended"` | The code ended (a new code, stop sharing, match closed). You no longer get updates; ask for the new code |
| `match-deleted` | The scorer deleted the match |

Send `{"type":"ping"}` every 25 s; the relay answers `{"type":"pong"}`. No
answer within 10 s: the connection is dead (venue Wi-Fi without uplink keeps
sockets "open"), reconnect.

**Reconnect rules.** On every close or dead ping, reconnect after 5, 10, 20,
then every 30 s, and send the same `subscribe-match { code }` again (the
relay resolves it again; a relay that restarted learns the code back from the
scorer within seconds of the scorer reconnecting). On `not-found` keep trying
every 15–60 s (the scorer may still be reconnecting); on `rate-limited` wait
`retryAfter` seconds; on `ended` stop and show that a new code is needed.

Browsers: the cloud accepts WebSocket upgrades only from OpenVolley's own
sites. A web page of another site uses the HTTP feed below (CORS `*`). Native
apps, controllers and scripts send no `Origin` and may use the WebSocket.

## 4. HTTP (polling, any site, any language)

```http
POST /api/display/live
Content-Type: application/json

{"code":"ABCD-2345"}
```

`text/plain` works too (a browser then needs no preflight). Answers are
`Cache-Control: no-store` with `Access-Control-Allow-Origin: *`:

```json
{
  "ok": true,
  "matchId": "match_17_kq3f",
  "endsAt": 1763784000000,
  "match": { "status": "live", "gameNumber": 4711, "scheduledAt": "2026-11-21T18:00:00.000Z" },
  "homeTeam": { "name": "VBC Musterdorf", "color": "#e2001a" },
  "awayTeam": { "name": "Volley Beispiel", "color": "#1d4ed8" },
  "sets": [{ "index": 1, "homePoints": 25, "awayPoints": 21, "finished": true }, { "index": 2, "homePoints": 12, "awayPoints": 9, "finished": false }],
  "liveState": { "current_set": 2, "points_a": 12, "points_b": 9, "…": "…" }
}
```

`match`, `homeTeam`, `awayTeam` are `null` and `sets` `[]` while the relay
does not hold the match (its scorer is reconnecting); `liveState` is `null`
before the scorer's first push. `POST /api/display/lookup` answers only
`{ ok, matchId, endsAt }` (for a client that then subscribes by `matchId`).

| Status | `code` | Do |
|---|---|---|
| 200 | | show it; poll again in 2–5 s |
| 400 | `OV_DISPLAY_BAD_REQUEST` | the body is not `{"code": "…"}` JSON |
| 404 | `OV_DISPLAY_NOT_FOUND` | wrong code (or not set yet): ask again in 15–60 s, or ask for the code |
| 410 | `OV_DISPLAY_ENDED` | the code ended: ask for the new one |
| 413 | `OV_DISPLAY_TOO_LARGE` | body over 1 KB |
| 429 | `OV_DISPLAY_RATE_LIMITED` | wait `Retry-After` seconds |

## 5. The live state

The scorer's live state, as the `match_live_state` columns. **Team A and Team
B** are fixed for the match (the coin toss's Team A); `side_a` says where
Team A plays now, so a board can show the teams as they stand on the court.

| Field | Meaning |
|---|---|
| `team_a_name`, `team_b_name`, `team_a_short`, `team_b_short` | Team names (short: up to 12 characters) |
| `team_a_color`, `team_b_color` | The shirt colour each team chose, `#rrggbb`. Pick black or white text by contrast |
| `points_a`, `points_b` | Points in the current set |
| `sets_won_a`, `sets_won_b` | Sets won |
| `current_set` | The set being played (1–5). A best-of-3 decider is stored as `5`: show it as set 3 when `best_of` is 3 |
| `best_of` | 3 or 5 |
| `side_a` | `left` / `right`: Team A's side, as the scorer's screen shows the court |
| `serving_team` | `left` / `right`: the serving side (compare with `side_a`) |
| `server_number` | The serving player's position number, when the scorer pushes it |
| `timeouts_a`, `timeouts_b` | Time-outs used in this set (2 per set) |
| `subs_count_a`, `subs_count_b` | Regular substitutions in this set (6 per set); exceptional ones not counted. Absent from scorer apps up to 3.3.6 |
| `challenges_used_a`, `challenges_used_b` | Video challenges used, where the competition has them |
| `timeout_active`, `timeout_started_at` | A time-out is running (30 s) |
| `set_interval_active`, `set_interval_started_at` | The interval between sets is running |
| `match_status` | `live`, `interval`, `timeout`, `ended` / `final` (the match is over) |
| `set_results` | Finished sets, oldest first: `[{ set, home, away, a, b }]` (`a` / `b` by Team A / B) |
| `last_event_type`, `last_event_team`, `last_event_ts` | The last scoring event (`point`, `timeout`, `substitution`, `set_end`, …), the team the event names, and its time |
| `updated_at`, `_seq`, `_session` | Order of pushes: keep the push with the higher `_seq` of the same `_session`, else the later `updated_at` |

Never in it: `lineup_a/b`, `subs_a/b` (who for whom), `sanctions_a/b`,
`last_event_data`, `scorer_attention_trigger`. Unknown fields may appear:
ignore them.

## 6. League games by number

An official league game's live score is public by its game number (1–7
digits), without a code: `GET /api/global/live/game/<number>` on the cloud
(from the published live score) or on a hall relay (its own room of that
number). Indoor games only: OpenBeach numbers its games per tournament. CORS
`*`, poll every 5 s. The answer is the TV page's court summary
(`data.courts[0]`: `home` / `away` `{ name, short, color }`, `setsWon`,
`points`, `sets`, `currentSet` (a best-of-3 decider is 3), `bestOf`,
`serving` `home`/`away`, `ended`, `timeout`, `interval`), with no time-out
counts or substitutions. OpenVolley's
board page takes a game number in its code field.
