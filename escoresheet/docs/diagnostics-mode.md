# Diagnostics mode

Off by default. When on, the scorer app writes one JSON line per observation:
page loads and reloads, window and layout sizes, layout jumps, dialogs, clicks,
scorer actions and their database transactions. The aim is to explain a
scoreboard that pulses bigger and smaller, a dialog that flashes the wrong
content, or a reload, from the log alone.

Code: `frontend/src/diagnostics/` (page) and `frontend/src-tauri/src/diagnostics.rs`
(desktop sink and native window events).

## Switching it on

| How | Scope |
| --- | --- |
| `OPENVOLLEY_DIAGNOSTICS=1 openvolley-escoresheet` (desktop app) | this run, from the first script on (Rust runs `window.__OV_DIAGNOSTICS__ = 'env'` before the page) |
| Options > Logs > Diagnostics mode | this device, until switched off (localStorage `ov.diagnostics`) |
| `?diag=1` in the URL | this tab, until `?diag=0` (`?diag=0` also overrides the other two) |

The React commit counts and the `db.*` lines need diagnostics to be on when the
page loads. Switching it on in Options starts everything else at once.

## Where the lines go

- **Desktop app (Tauri, OpenVolley and OpenBeach):**
  `<log dir>/diagnostics-YYYY-MM-DD.jsonl` (UTC date), next to `desktop.log`
  and `activity-*.jsonl`. On Linux the log dir is `~/.local/share/OpenVolley/logs`,
  on Windows `%APPDATA%\OpenVolley\logs`, on macOS `~/Library/Logs/OpenVolley`
  (OpenBeach: `~/Library/Logs/OpenBeach`). `OPENVOLLEY_LOG_DIR` overrides it.
  A day's file stops at 20 MB, and a `diag.capped` line marks the cut. 7 files are kept.
  "Open log folder" in Options opens it.
- **Browser and Android:** an IndexedDB ring buffer (`openvolley-diagnostics`,
  50,000 lines, 7 days). Use Options > Logs > Export diagnostics to save it as a `.jsonl` file.

## Line format

```
{"ts":"2026-10-08T12:34:56.789Z","m":15234.5,"sid":"k3f9a2","seq":42,"src":"page","k":"geo.jump","a":7,"d":{...}}
```

| Field | Meaning |
| --- | --- |
| `ts` | wall clock, UTC |
| `m` | monotonic ms: `performance.now()` of this page load (page), or ms since the process started (native) |
| `sid` | page load id. A new `sid` means a new load. Native lines have none |
| `seq` | line number within the page load |
| `src` | `page` or `native` |
| `k` | kind (see below) |
| `a` | number of the user action (click or key) this line follows, counted per load. 0 means before any action |
| `d` | data, redacted |

Many `d` objects carry `after: {a, ms}`, which is the last user action and how long ago it was.
`geo.*` lines also carry `state: {k, ms}`, which is the last line that changed the screen
(`action.commit`, `action.ui`, `lq.emit`, `dialog.*`, `css.vars`, `geo.window`) and how long ago it was.

### Kinds

| Kind | What |
| --- | --- |
| `page.load` | every load: `nav` (navigate / reload / back_forward), `prev` (the reason the app gave for reloading, null when the app did not ask), version, platform, engine (from the UA), screen, window, dpr, `sw` (a service worker controls the page) |
| `page.reload_request` | the app is about to reload or navigate: `reason`, `how`, `url` (no query). Every app-initiated reload goes through `reloadWithReason()` |
| `page.hide` / `page.show` / `page.beforeunload` / `page.visibility` / `page.freeze` / `page.resume` / `page.focus` / `page.online` | lifecycle |
| `page.error` / `page.rejection` / `page.resource_error` | uncaught errors, unhandled rejections, failed resources |
| `sw.registration` / `sw.updatefound` / `sw.state` / `sw.controllerchange` | service worker |
| `geo.window` | window inner/outer size, dpr, visual viewport (size, scale, offset) |
| `geo.box` | a watched box changed size: `el` (`root`, `scoreboard`, `content`, `court`, `rally`, `toolbar`, `header`, `dialog`, any `[data-diag]`, plus `#n`), `w`, `h`, `from` |
| `geo.jump` | a box went back to an earlier size within 500 ms: `size`, `via` (the sizes in between), `ms` |
| `geo.dpr` / `geo.fullscreen` / `geo.orientation` | zoom or screen change, fullscreen, orientation |
| `css.vars` | `<html>` inline custom properties (`--scale-factor`, `--vmin-base`, ...), root font size, `<body>` classes: what changed |
| `dialog.open` / `dialog.content` / `dialog.close` | every `[role=dialog]` / `[role=alertdialog]`: `id`, `title` (heading or label, redacted), `hash` of its text, `ms` open, `flash` (closed within 400 ms) |
| `ui.click` / `ui.key` | user actions: element `id` (data-testid, data-help-id, id, or aria-label / title without digits, never the text), `role`, `dialog`. Keys typed into fields are not recorded |
| `action.start` / `action.commit` / `action.ui` / `action.drop` / `action.fail` | scorer actions (`useScorerActions`): `key` (`point`, `timeout`, `substitution`, ...), commit ms, `gen`, the number of screen changes and effects. `action.ui` is the moment the action's dialogs are applied |
| `lq.emit` / `lq.fallback` | the scoreboard live query delivered a result (`gen`) / gave up waiting for it |
| `db.tx_start` / `db.tx` / `db.reads` | read-write Dexie transactions (tables, ms, outcome). Read-only ones are summed per user action |
| `react.commits` | scoreboard renders per user action: `commits`, `ms` (sum), `maxMs` |
| `perf.longtask` / `perf.layoutshift` | only where the engine has them (Chromium, not WebKitGTK) |
| `diag.capabilities` / `diag.dropped` / `diag.capped` / `diag.stop` | what this engine supports, lines dropped at the buffer or day cap |
| `native.start` | desktop: app, version, OS, arch, WebKitGTK/WebView2 version, desktop session (e.g. `KDE wayland`) |
| `native.window` / `native.resized` / `native.scale` / `native.focus` / `native.theme` / `native.close_requested` | desktop window events, physical pixels |
| `native.page_load_started` / `native.page_load_finished` | the webview (re)loading the scoretable, URL without the query |

## Reading it

```sh
cd ~/.local/share/OpenVolley/logs
# loads and why
jq -c 'select(.k=="page.load" or .k=="page.reload_request" or (.k|startswith("native.page_load")))' diagnostics-*.jsonl
# every jump, with what came before it
jq -c 'select(.k=="geo.jump")' diagnostics-*.jsonl
# one user action, from click to the last resize
jq -c 'select(.sid=="k3f9a2" and .a==7)' diagnostics-*.jsonl
# dialogs that flashed or changed content
jq -c 'select(.k=="dialog.content" or (.k=="dialog.close" and .d.flash))' diagnostics-*.jsonl
```

## Never recorded

PINs, passwords, tokens or signatures. Diagnostics uses the activity log's redaction
(`domain/activitySummary`: no key named pin, password, token, signature, email, phone,
and so on, and no PIN or long number in text) and the click log's
(`utils/screenText`: no 6-digit run, also grouped like "771 234").
It also leaves out URL queries and fragments, data URLs, JWTs, the text of an
element or a dialog (a dialog keeps its title and a hash of its text), and
anything typed into a field.

## OpenBeach

OpenBeach builds from this `src-tauri`, so the sink and the native events are already there.
Its page calls the same commands from the scoretable window at `http://localhost`
(ACL: `capabilities/diagnostics.json`):

- `diagnostics_append({ lines: string[] }) -> number`: at most 500 lines per call, each one a JSON object of up to 16 KB with no line break. An invalid line refuses the whole call. It returns the number of lines written (lines past the day's 20 MB are dropped).
- `diagnostics_native({ on: boolean }) -> boolean`: turns the native window events on or off. `OPENVOLLEY_DIAGNOSTICS=1` keeps them on. It returns whether they are on.
