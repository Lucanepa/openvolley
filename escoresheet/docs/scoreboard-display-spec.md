# Scoreboard displays and their settings page

A scoreboard display (an LED board in the hall, a hall screen) can follow a match on the relay like a livescore does. It can also name its own settings page, such as brightness or orientation. While it follows the match, the scorer's **Match** menu gets one more row, **Scoreboard settings** (Devices and data), which opens that page. With no display, or a display that names no usable page, the row is not there.

A display finds its match by the room key, or, on any network, by the scorer's scoreboard code (`subscribe-match { code }`, docs/scoreboard-code-spec.md and docs/scoreboard-feed.md).

OpenVolley knows nothing about any particular board. The display announces itself, and the relay passes the page on only when it is on the hall's own network.

## Wire contract

Every relay speaks it the same way: the cloud relay (`backend/server.js`), the LAN relays (`frontend/electron/lanRelayCore.cjs`, used by `frontend/server.js`, the Vite dev plugin and Electron) and the desktop app's relay (`frontend/src-tauri/src/relay.rs`).

### Display to relay

```jsonc
{ "type": "subscribe-match", "matchId": "<room key>", "device": "display", "settingsUrl": "http://172.24.1.1:8890/#settings" }
```

- `matchId` is the room key (the seed key, the `id` in `GET /api/match/list`), as for any subscriber.
- `device: "display"` labels the socket. Like the other device labels, it grants nothing: the display gets the PIN-free summary and every `live-state-update`, as before.
- `settingsUrl` is optional. The relay keeps it only when all of these hold:
  - it is a string of at most 256 characters, with no spaces or control characters;
  - it parses as a URL with the scheme `http:` or `https:`;
  - it has no user name or password;
  - its host is a private-LAN IP literal: IPv4 `10.0.0.0/8`, `172.16.0.0/12` or `192.168.0.0/16`, or IPv6 `fc00::/7` (unique local).

  Names, loopback, link-local and public addresses are refused. The relay keeps the URL's normalised form (WHATWG). A refused URL becomes `null`, and the socket still counts as a display.
- Sending `subscribe-match` again (after a reconnect, or with another page) replaces the announcement. `unsubscribe-match` or closing the socket ends it.

The device label was chosen as `display`, not `scoreboard`, on purpose. In the relays, `scoreboard` is the role of the scorer's own app, which is the role that proves a match with its game PIN. A follower must never carry that word.

### Relay to scorer

```jsonc
{ "type": "display-presence", "matchId": "<room key>", "present": true, "settingsUrl": "http://172.24.1.1:8890/#settings" }
```

- This message goes **only to the room's scoreboard sockets**, the ones that proved the match with an accepted sync. Referee, bench, livescore and display sockets never get it.
- `present` is true while at least one open display socket follows the room, whether it is in the room or waiting for it.
- `settingsUrl` is the kept page of the display that subscribed most recently with a usable page. It is `null` otherwise, and always `null` when `present` is false.
- When the message is sent:
  - to a socket right after its first accepted sync of the room, with the current state (`present: false` included);
  - to the room's scoreboard sockets whenever `(present, settingsUrl)` changes: a display subscribing, naming another page, unsubscribing or closing.

  There is no repeat of an unchanged state and no timer.
- These four keys are the whole message. It carries no PIN, no device id, no address and no name.

Older relays send nothing. The scorer then shows no row, which is the same as having no display.

## The scorer

`frontend/src/utils/scoreboardDisplay.js` keeps the last `display-presence` per match for the scorer socket it came on. A new socket counts as unknown until its first sync is answered.

The page is checked again before it is offered, and nothing from the relay is trusted as it came. The scorer accepts the same private-LAN rule, plus one more case: the URL's host is the host the scorer page itself was loaded from (never `localhost` or loopback).

The menu row (`components/matchMenu.jsx`, key `scoreboard-settings`) opens the page through `openAppWindow`:
- **Browser:** a new tab, with `noopener`.
- **Desktop app:** the system browser.
- **Android app:** Android's browser.
- **Point Hub tablet app's OpenVolley layer:** the layer opens the board's own Settings instead.

The scorer's screen is never left or reloaded.

## Privacy

On the cloud relay, the only thing that travels is the private-LAN address of the display's settings page, and it reaches the match's scorer only. Nothing about the display is logged or listed. `/api/server/connections` counts it as a plain subscriber.

## Tests

- `backend/tests/helpers/displayPresenceContract.js`: the wire scenario, run against `backend/server.js --local` (`tests/displayPresence.relay.test.js`) and, from `frontend/src/utils/__tests__/lanRelayProtocol.test.js`, against `server.js`, the Vite dev plugin and the Tauri relay (`OV_TAURI_RELAY_BIN`).
- URL rule: `backend/tests/displayPresence.test.js`, the shared cases in the contract helper (checked against the backend, the LAN core and the scorer), and `relay.rs` unit tests.
- Scorer: `frontend/src/utils/__tests__/scoreboardDisplay.test.jsx` and `frontend/src/components/__tests__/matchMenu.test.jsx`.
