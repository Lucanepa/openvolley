# Public match API (embeddable)

Read-only, anonymous, no account, **no names**: players are shirt numbers (with
captain / libero flags), officials and bench staff are roles ("1st referee",
"head coach"). Dates of birth, signatures, licences, PINs and remarks never
appear. Team names are club data and stay. Test (rehearsal) matches are never
served. Code: `backend/lib/publicApi.js`, `backend/lib/publicEmbed.js`, routes in
`backend/server.js` (cloud mode, `DATABASE_URL`).

CORS: every origin (`Access-Control-Allow-Origin: *`), never with credentials, GET only,
so any website can call it from the browser.

Base: `https://backend.openvolley.app/api/public/v1`. A match id is the match's
`external_id`, the same id the livescore link uses.

| Request | What |
|---|---|
| `GET /matches?from=&to=&status=&limit=&club=` | Match infos (no rosters) in a window (default: yesterday to +7 days, max 62 days; `status` = `scheduled,live,finished`; limit ≤ 200); `club=<club id>`: only that club's matches |
| `GET /matches/:id` | Match info: teams, league, venue, best of, `officials` (roles only), rosters (numbers, captain, libero), staff (roles), result |
| `GET /matches/:id/live` | Livescore snapshot: sets, points, serving team and server's number, timeouts, challenges, set results, timeout / interval flags. No line-ups, substitutions or sanctions: like every anonymous live read (`LIVE_STATE_PRIVATE_COLUMNS` in `lib/publicColumns.js`) they need the match PIN |
| `GET /matches/:id/stream` | The same snapshot as Server-Sent Events (`event: live`), a frame on every change, a keep-alive comment every 20 s (every 30 s once the match is finished). `EventSource` reconnects by itself |
| `GET /matches/:id/stats` | After the match (`409` before): everything of `/matches/:id` plus `stats` |

`stats` holds, per team, totals (points, timeouts, substitutions, sanctions), and
per set: points, winner, minutes, **starting formation** (numbers per position),
`pointLog` (`[home, away, 'H'|'A']` after each rally), longest run, timeouts,
substitutions (team) and sanctions (team and type), each with the score at
that moment, and the number of libero actions. A substitution or a sanction
never says which shirt number or why (an injury, an expulsion): rosters with
names can be read by number elsewhere. Voided (undone) events are left out.
A set's `startedAt`, `endedAt` and `minutes` are the times printed on the
scoresheet: the start the scorer confirmed (or corrected after the match) and the
recorded end, each to the minute, `minutes` their difference
(`lib/sheetTimes.js`, a copy of the app's rules).

In the live snapshot the teams are labelled A / B as in the scoresheet:
`score.pointsA`, `teams.A.name`, `serving` is `"A"` / `"B"`. In `stats` and the
match info they are `home` / `away`.

## Embed

```html
<script src="https://backend.openvolley.app/embed/livescore.js" async></script>
<ov-livescore match="MATCH_ID"></ov-livescore>
```

Attributes: `match` (a match id) or `club` (a club id: that club's games of the day as a ticker, refreshed every 10 s), `api` (another backend's origin), `theme`
(`light` / `dark`, default: the visitor's setting). It draws in a shadow root,
so the page's CSS cannot break it, uses the stream and falls back to polling
every 5 s. A site that cannot add a script can use an iframe: `<iframe src="https://backend.openvolley.app/embed/match/MATCH_ID?theme=dark" style="border:0;width:100%;height:160px">` (or `/embed/club/CLUB_ID`). Or call the JSON yourself:

```js
const es = new EventSource('https://backend.openvolley.app/api/public/v1/matches/MATCH_ID/stream')
es.addEventListener('live', (e) => render(JSON.parse(e.data)))
```

## Limits

240 requests per minute and 30 new streams per minute per address (one IPv4
address or one IPv6 /64, so all viewers on a hall's Wi-Fi share it); at most
100 open streams per address, 500 viewers per match, 200 streamed matches and 3000
streams in all. A stream over a limit is refused with `503` and `Retry-After`
before it starts (the widget then polls `/live`). One database poll every 2 s
per streamed match, however many viewers, every 30 s once it is finished. A
viewer that does not read its stream (256 KB unsent) is dropped. `/live` is
cached 2 s, `/matches` 15 s, `/stats` 30 s while the match is finished but not
yet closed (a correction or a late event from an offline scorer still changes
it) and 5 min once it is closed (then built once per version on the server; an
admin change or reopen makes a new version).

## Tests

`tests/publicApi.test.js` (no database: privacy of every builder, statistics,
stream, widget), `tests/publicApi.pg.test.js` (SQL on the real schema under the
app role), `tests/publicApi.e2e.test.js` (CORS, SSE and widget through server.js).
