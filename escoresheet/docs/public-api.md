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
| `GET /matches?from=&to=&status=&limit=` | Match infos (no rosters) in a window (default: yesterday to +7 days, max 62 days; `status` = `scheduled,live,finished`; limit ≤ 200) |
| `GET /matches/:id` | Match info: teams, league, venue, best of, `officials` (roles only), rosters (numbers, captain, libero), staff (roles), result |
| `GET /matches/:id/live` | Livescore snapshot: sets, points, serving team, timeouts, on court (numbers per position I–VI), sanctions, set results, timeout / interval flags |
| `GET /matches/:id/stream` | The same snapshot as Server-Sent Events (`event: live`), a frame on every change, a keep-alive comment every 20 s. `EventSource` reconnects by itself |
| `GET /matches/:id/stats` | After the match (`409` before): everything of `/matches/:id` plus `stats` |

`stats` holds, per team, totals (points, timeouts, substitutions, sanctions), and
per set: points, winner, minutes, **starting formation** (numbers per position),
`pointLog` (`[home, away, 'H'|'A']` after each rally), longest run, timeouts,
substitutions (out / in numbers, exceptional, expelled, disqualified) and
sanctions (type, number or role), each with the score at that moment, and the
number of libero actions. Voided (undone) events are left out.

In the live snapshot the teams are labelled A / B as in the scoresheet:
`score.pointsA`, `teams.A.name`, `serving` is `"A"` / `"B"`. In `stats` and the
match info they are `home` / `away`.

## Embed

```html
<script src="https://backend.openvolley.app/embed/livescore.js" async></script>
<ov-livescore match="MATCH_ID"></ov-livescore>
```

Attributes: `match` (required), `api` (another backend's origin), `theme`
(`light` / `dark`, default: the visitor's setting). It draws in a shadow root,
so the page's CSS cannot break it, uses the stream and falls back to polling
every 5 s. Or call the JSON yourself:

```js
const es = new EventSource('https://backend.openvolley.app/api/public/v1/matches/MATCH_ID/stream')
es.addEventListener('live', (e) => render(JSON.parse(e.data)))
```

## Limits

240 requests per minute and 30 new streams per minute per address; 500 viewers
per match and 3000 streams in all. One database poll every 2 s per streamed
match, however many viewers. `/live` is cached 2 s, `/matches` 15 s, `/stats` 5 min.

## Tests

`tests/publicApi.test.js` (no database: privacy of every builder, statistics,
stream, widget), `tests/publicApi.pg.test.js` (SQL on the real schema under the
app role), `tests/publicApi.e2e.test.js` (CORS, SSE and widget through server.js).
