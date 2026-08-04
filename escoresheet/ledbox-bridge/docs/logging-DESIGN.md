# Logging & the `/logs` page

Status: **built**. One structured log for the whole appliance, live-viewable at
`http://<board>:8890/logs`, persisted to the card with a hard disk ceiling.

## Why

Before this, the appliance's only trail was `console.log` scattered across eight modules,
readable exclusively through `journalctl -u ledbox-bridge` over SSH. At a venue that means: the
one person who can answer "why did the panel freeze / why is the score wrong / why is `/live`
stale" is the one with a laptop and the Tailscale key. Worse, the most useful facts were never
logged at all — every `pushState` early-return, every swallowed `livePush` failure, every
settings change, every scored action.

## Shape

```
 every module ── log.info(scope, msg, data) ──▶ LogStore ─┬─▶ ring buffer   GET  /api/logs
                                                          ├─▶ subscribers   GET  /api/logs/stream (SSE)
                                                          ├─▶ console       journalctl -u ledbox-bridge
                                                          └─▶ data/logs/*.jsonl (rotated, ≤15 MB)
 the browser ── POST /api/logs ─────────────────▶ (scope 'ui')
```

An entry is `{ id, ts, level, scope, msg, data }`. `id` is a monotonic counter — it is the SSE
cursor, so a phone that drops off the LAN reconnects and asks for everything after its last id.

### One process-wide instance

`src/logStore.js` exports a singleton `log`, configured once at boot by `appliance.js` (or
`bridge.js`). Modules import it directly instead of taking a logger parameter: `LedboxClient`,
`RelaySubscriber` and the sources are constructed from the appliance, the bridge, the tests and
five selftests, and threading a logger through all of them would be noise for no gain.
Unconfigured, the store mirrors to console and keeps the memory ring — exactly what a test wants.

### Three rules the store lives by

1. **It can never throw.** Every entry point is wrapped; a failure drops the line silently. A
   logger that can break scoring is worse than no logger — the same isolation principle already
   applied to `historyStore` and `livePush`.
2. **It buffers writes.** The board runs off an SD card. Lines batch and flush on a 1 s timer or
   at 50 lines, whichever comes first; `error` flushes immediately (a crash must not eat the
   reason for it), and `process.on('exit')` flushes the tail.
3. **It redacts.** Any key matching `pin|token|secret|password|authorization|cookie|apikey`
   becomes `[redacted]` at any depth — the scorer PIN and the Directus token both pass through
   instrumented call sites. Payloads are also bounded: depth 4, 40 keys, 50 array items, 600
   characters per string, cycles marked rather than followed.

### Levels

| Level | What lives there |
|---|---|
| `debug` | The firehose: every board write and its round-trip time, every withheld paint and *why*, every HTTP GET, every relay message, every `livePush` publish |
| `info` | Anything that changes what the panel shows or what the board is doing: layout switches, idle on/off, countdowns, source changes, every scored action, settings diffs, boot and shutdown |
| `warn` | Recovered or degraded: host failover, the error-6 layout self-heal, a relay drop, a Directus non-2xx, a rejected PIN, history cleared |
| `error` | Push failures, socket errors, unhandled rejections, uncaught exceptions, a settings save that failed |

Default is `info`. `LOG_LEVEL=debug` (or the historical `DEBUG=1`) boots verbose, and the level
is switchable **at runtime** from the `/logs` page — a match can be made verbose without a
restart, which matters when the failure only happens during a game.

### Scopes

`appliance`, `bridge`, `ledbox`, `control`, `action`, `source`, `relay`, `livePush`, `settings`,
`history`, `process`, `ui`. The page builds its filter chips from `stats().scopes` — what has
actually been logged — so the list can never drift from the code.

## Persistence

`data/logs/appliance.jsonl` (the bridge writes `bridge.jsonl`), rotated at 5 MB across 3 files:
**15 MB ceiling**, trivial against the card. `data/` is already gitignored. An unwritable path
(full or read-only card) silently degrades to memory-only rather than failing the boot.

## API

| Endpoint | Purpose | PIN |
|---|---|---|
| `GET /api/logs?level=&scope=&q=&sinceId=&limit=` | Filtered slice of the ring + stats | open |
| `GET /api/logs/stream?sinceId=` | SSE live tail, with catch-up and 20 s keep-alives | open |
| `POST /api/logs` | Browser-side error ingest (scope `ui`), rate-limited to 60/min | open |
| `POST /api/logs/level` | Change the recording level at runtime | required |
| `POST /api/logs/clear` | Wipe the ring and the files | required |
| `GET /api/logs/export` | Whole trail as NDJSON, oldest rotation first | open |

Reads stay open and writes need the PIN, matching the rest of the control API. The one
exception is `POST /api/logs`: a spectator's phone hitting a bug is precisely what it is for, and
requiring the PIN would silence it — so it is rate-limited instead.

SSE rather than WebSocket: production has no `ws` dependency, and `EventSource` reconnects by
itself, which is the behaviour you want on a venue LAN.

## The page

`web/logs.html`, served at `/logs` (same pretty-route pattern as `/mockledbox`), linked from
**Settings ▸ Diagnostics**. Console styling — white ground, hairline borders, mono numerals —
with severity as the only colour on screen.

- Live tail over SSE, with **Pause** (the appliance keeps recording; a badge counts what
  arrived) and auto-follow that yields the moment you scroll up
- Filters — level, scope chips, full-text search across message *and* data — applied client-side
  over the server's buffer, so changing one re-renders history rather than only new lines
- Click a row to expand its structured payload
- **Recording level** control, distinct from the view filter and labelled as such
- Download (NDJSON) and Clear (behind the same promise-based confirm the controller uses — never
  a native dialog on a venue tablet)
- The page reports its own JS errors to the log it displays

## What the controller now reports

`window.onerror`, `unhandledrejection`, and any API response that came back non-2xx, posted to
`/api/logs` and throttled to one per message per 5 s. Network-level failures are deliberately
*not* reported: if the appliance is unreachable the report cannot land either, and the offline
banner already says so.

## Testing

`test/logstore-selftest.mjs` (47 assertions, in `npm test`) covers level gating, the ring cap,
monotonic ids, redaction, unloggable input (cycles, depth, huge strings, Errors, wide objects),
every query filter, `sinceId` catch-up, subscribe/unsubscribe, buffered writes, error-forced
flush, rotation with its byte ceiling, `clear()`, and the unwritable-path fallback.

## Deliberately not done

- **No log shipping.** The board is often on a venue LAN with no route out. Export + the page
  cover the actual need.
- **No per-request body logging.** Bodies carry the PIN on every mutating call; the redactor
  would handle it, but not logging it at all is a stronger guarantee.
- **No client-side log persistence.** The phone is not the system of record.
