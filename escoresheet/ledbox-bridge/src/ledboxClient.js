// LEDbox TCP client — connect, Init handshake, push live volleyball state.
//
// Runs in a Node context (Electron main process, or a local sidecar). A browser
// tab cannot open this socket, which is the core reason the connector lives here.
// USB-serial / Bluetooth would swap the transport but reuse encode/decode + mapper.

import net from 'node:net'
import { EventEmitter } from 'node:events'
import { encode, StreamDecoder } from './ledboxProtocol.js'
import { toSections, toCountdownSections, toIdleSections, toClubIdleSections, toBreakSections, toLeftRight } from './volleyballMapper.js'
import { log } from './logStore.js'

const CONTROL_PORT = 8889
const HOTSPOT_IP = '172.24.1.1'

// Board traffic is logged here rather than in the appliance because most of it has no event
// to listen to: the silent early-returns in pushState, the layout cache, the error-6 self-heal.
// Per-write detail sits at `debug` (it fires ~1 Hz during a rally); anything that changes what
// the panel is showing, or that had to recover, is `info`/`warn`.
const blog = log.child('ledbox')

export class LedboxClient extends EventEmitter {
  constructor({
    // `host` may be a single address or a list. The board lives at a different address
    // depending on how you reached it (its own Wi-Fi vs the ethernet cable), so we walk
    // the list on each connect attempt and settle on whichever answers. `this.host` is
    // always the address currently in use, so status reporting stays honest.
    host = HOTSPOT_IP,
    hosts = null,
    port = CONTROL_PORT,
    alias = 'openvolley',
    sport = 'volleyball',
    apiVersion = 2,
    layout = 'volleyball_matchscore_02',
    // The device ships a purpose-built countdown layout with `timer` and `lbl` sections
    // (confirmed by GetSections on a C0270 fw 0.551). Timeouts, set intervals and the
    // warm-up clock all use it — we only change the label and the number.
    countdownLayout = 'volleyball_matchscore_timeout_02',
    // Our own break screen. It uses the whole panel (boxes left/right, break in the middle)
    // instead of the vendor layout's right third. Falls back to countdownLayout if absent.
    breakLayout = 'kscw_break',
    // Club idle screen (crest + team names). Optional: if the layout isn't on the
    // device, showIdle falls back to the plain match-layout idle screen.
    idleLayout = 'kscw_idle',
    // "Complete" idle — no teams known yet (e.g. the boot default): just the crest, centered,
    // no Home/Away. Falls back to idleLayout if this layout isn't on the device.
    crestLayout = 'kscw_crest',
    // Same "complete" idle, but for when an operator is already looking at the control UI.
    // crestLayout spends two thirds of the panel on a "Join WiFi" and an "Open UI" QR code,
    // which exist purely to GET someone connected — once they are, that space is dead and
    // carries the wall clock instead. Falls back to crestLayout if absent from the device.
    clockLayout = 'kscw_clock',
    // How long after the last control-UI request a viewer still counts as present. The UI polls
    // /api/status every 1.5s, so this is ~13 missed polls: long enough that a brief wifi stall
    // or a tablet blanking its screen doesn't flap the panel back to the QR codes, short enough
    // that the QRs return promptly for the next person once a device really is gone.
    viewerTimeoutMs = 20000,
    // How often the idle screen re-checks "is anyone watching?" and rolls the clock over. 1s
    // because the clock shows seconds. The presence check is a timestamp compare, and _paintClock
    // only writes when the string actually changed, so an idle board with nobody connected sends
    // nothing at all — the cost is one SetSections per second only while someone is watching.
    idleTickMs = 1000,
    // Idle-screen name style. Full club names are auto-shrunk to fit the panel, so
    // idleFontMax is a ceiling (what a short name gets), not a fixed size.
    idleFullNames = true,
    idleFontMax = 24,
    // Club name from settings; the matching side is painted in club gold on the crest.
    clubName = '',
    timerSection = 'timer',
    labelSection = 'lbl',
    // Text sections on clockLayout.
    clockTimeSection = 'time',
    clockDateSection = 'date',
    reconnectMs = 3000,
    // A TCP connect to an address that isn't routable from here does NOT fail fast — it
    // sits until the kernel gives up (minutes). Without our own deadline the host list
    // never advances and failover silently never happens.
    connectTimeoutMs = 4000,
    // Give the panel time to bring a new layout up before painting into it.
    layoutSettleMs = 400,
    // How often to re-assert the scoreboard layout and repaint. The board's layout can
    // change without us: its own boot sequence paints an info screen and then forces the
    // default layout, and any other client on 8889 can call SetLayout. Our `currentLayout`
    // is only a cache, so once it disagrees with the device the board can sit on the wrong
    // screen indefinitely while the bridge reports everything is fine. This bounds that to
    // one interval. Set 0 to disable.
    layoutGuardMs = 20000,
    // How long a point/substitution blinks on the board before settling, and the on/off
    // half-period of that blink. The board's native `blinking` animation ignores the runtime
    // colour (always blinks blue/red, the layout default), so we blink in software by toggling
    // the colour — kept near the vendor's ~1 Hz ceiling to avoid flooding the panel.
    pulseMs = 2000,
    // 160ms commanded toggles: the panel can't render that fast (its own limit is ~1 Hz), so
    // it smooths them into a clean, even blink — which reads better than a slower command rate
    // that the board renders literally and choppily. Chosen on the glass.
    pulseIntervalMs = 160,
    // Per-set allowances — drive the counter colours (set live from operator settings).
    totalTimeouts = 2,
    totalSubs = 6,
    // When true, a fresh boot (nothing scored yet) settles on the idle/crest screen after
    // the handshake instead of a blank match layout. Set by the appliance.
    defaultIdle = false,
    // One-shot text held on the panel right after the first handshake, then cleared back to
    // idle. Set by the appliance when this boot is the result of a sport switch.
    bootMessage = null,
    // Injected state→sections mapper set (per-sport; see src/sports.js). Defaults to the
    // volleyball mapper so the client still works standalone and in tests. Only toSections
    // differs between sports; idle / crest / countdown / break are shared.
    mapper = null,
  } = {}) {
    super()
    Object.assign(this, { port, alias, sport, apiVersion, layout, countdownLayout, breakLayout, idleLayout, crestLayout, clockLayout, viewerTimeoutMs, idleTickMs, idleFullNames, idleFontMax, clubName, timerSection, labelSection, clockTimeSection, clockDateSection, reconnectMs, connectTimeoutMs, layoutSettleMs, layoutGuardMs, pulseMs, pulseIntervalMs, totalTimeouts, totalSubs, defaultIdle, bootMessage })
    this.mapper = mapper || { toSections, toCountdownSections, toIdleSections, toClubIdleSections, toBreakSections, toLeftRight }
    this._pulses = new Map()
    this._idle = false
    // Last time the control UI was seen (epoch ms). 0 = never; the board boots showing the QRs.
    this._viewerAt = 0
    // Last clock text actually pushed, so the ticker only writes when it actually changed.
    this._clockText = null
    // Optional layouts this device has told us it does not have (SetLayout code 5). The idle
    // ticker runs every second, so without remembering a refusal it would re-ask — and re-log —
    // forever on a board that never had the KSCW layouts installed. Cleared on each connect, so
    // a board that gets them later picks them up without a bridge restart.
    this._missingLayouts = new Set()
    this._suppressPaint = false
    this.currentLayout = null
    this.hosts = (hosts && hosts.length ? hosts : String(host).split(',').map((h) => h.trim()))
      .filter(Boolean)
    this._hostIdx = 0
    this.host = this.hosts[0]
    this.socket = null
    this.decoder = new StreamDecoder()
    this.ready = false
    this._pending = new Map() // sender -> resolver, for request/response
    this._closing = false
    this._lastState = null
    // Outbound commands are serialized — exactly one in flight at a time (see send()).
    this._sendChain = Promise.resolve()
    // Held so a pending reconnect can be cancelled on disconnect() (else a queued connect
    // can resurrect the client after it was told to close).
    this._reconnectTimer = null
  }

  connect() {
    this._closing = false
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    this.host = this.hosts[this._hostIdx % this.hosts.length]
    blog.debug('connecting', { host: this.host, port: this.port, candidates: this.hosts })
    let reachedReady = false
    const socket = net.connect({ host: this.host, port: this.port }, async () => {
      this.emit('connect')
      try {
        const info = await this.send('Init', undefined, {
          alias: this.alias,
          sport: this.sport,
          value: { version: this.apiVersion, typeDevice: 'app' },
        })
        this.ready = true
        reachedReady = true
        socket.setTimeout(0) // connect deadline met; don't let it fire as an idle timeout
        this.emit('ready', info)
        // Re-ask once per connect: a board can gain the layouts between sessions (a reflash and
        // restore, or a firmware layout drop), and it should not need a bridge restart to notice.
        this._missingLayouts.clear()
        this._startLayoutGuard()
        this._startIdleTicker()
        // The board advertises `noresend` and stays silent when asked for the layout it
        // already has, so this legitimately times out on every reconnect. Swallow that
        // one case; a real refusal (e.g. error 5, layout not on the device) still surfaces.
        //
        // Default screen after the handshake: if an idle/crest screen is deliberately up
        // (already toggled, or the configured default on a fresh boot with nothing scored
        // yet) settle on it — otherwise the board's own boot sequence forces its default
        // layout and would clobber the crest a beat after we set it. Else re-assert the
        // scoreboard and repaint the last state.
        if (this._idle || (this.defaultIdle && !this._lastState)) {
          await this.showIdle(true)
        } else {
          await this.setLayoutIfNeeded(this.layout)
          if (this._lastState) await this.pushState(this._lastState) // repaint after reconnect
        }
        // AFTER the default screen is settled, not before — otherwise the idle assertion above
        // would paint straight over the confirmation. One-shot: cleared here so a later
        // reconnect (cable knock, board reboot) never replays a stale sport announcement.
        if (this.bootMessage) {
          const msg = this.bootMessage
          this.bootMessage = null
          await this.showSportConfirm(msg)
        }
      } catch (err) {
        this.emit('error', err)
      }
    })
    if (this.connectTimeoutMs) {
      socket.setTimeout(this.connectTimeoutMs, () => {
        if (!this.ready) socket.destroy(new Error(`connect to ${this.host} timed out`))
      })
    }
    socket.on('data', (chunk) => {
      for (const msg of this.decoder.push(chunk)) this._onMessage(msg)
    })
    socket.on('error', (err) => this.emit('error', err))
    socket.on('close', () => {
      this.ready = false
      this.socket = null
      clearInterval(this._layoutGuard)
      this.clearPulses() // stop blink timers; they must not fire against a dead/next socket
      // Forget which layout we thought the board had. `currentLayout` is a client-side
      // cache used to skip redundant SetLayout calls, but a board that restarted comes
      // back on its default (`waiting`) — so a stale cache makes setLayoutIfNeeded a
      // no-op and every following section write lands on a layout that isn't loaded
      // ("section team1 not found"), leaving the board stuck on the waiting screen.
      this.currentLayout = null
      // Never got a handshake on this address — try the next one. Once an address has
      // worked we stay on it, so a transient drop doesn't send us wandering.
      if (!reachedReady && this.hosts.length > 1) {
        this._hostIdx++
        blog.warn('no handshake — trying the next address', {
          failed: this.host, next: this.hosts[this._hostIdx % this.hosts.length],
        })
      }
      this.emit('close')
      if (!this._closing && this.reconnectMs) {
        this._reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs)
      }
    })
    this.socket = socket
  }

  _onMessage(msg) {
    this.emit('message', msg)
    const waiter = this._pending.get(msg.sender)
    if (waiter) {
      this._pending.delete(msg.sender)
      if (msg.status === 'Error' || msg.status === 'error') {
        // The device names the field `error_message`; `message` is only our own mock's
        // older spelling. Reading the wrong one threw away every diagnostic the board
        // sends ("code 6 - section not found", "key 'attrib' not defined"), leaving a
        // bare "error (9)" — which is what made the write-shape bug so hard to find.
        const detail = msg.error_message || msg.message || 'error'
        const err = new Error(`${msg.sender}: ${detail} (${msg.error_code})`)
        // Carry the code as a property too. Callers need to tell a PERMANENT refusal (code 5,
        // "layout not present on this device") from a transient one, and digging it back out of
        // the message text with a regex is exactly the kind of thing that rots.
        err.code = Number(msg.error_code)
        waiter.reject(err)
      } else {
        waiter.resolve(msg.value)
      }
    }
  }

  // Sends {cmd, ...extra, value} and resolves with the matching response's value.
  //
  // Serialized — exactly one command in flight at a time. The board echoes `sender = cmd`,
  // so replies can only be matched by command name; two same-cmd requests in flight (a
  // point's SetSections paint and its blink pulse, fired in the same tick) would collide on
  // the _pending key — the second overwrites the first, the board's first ack resolves the
  // WRONG promise, and the orphaned real paint only settles ~5 s later via its timeout
  // (logged as "push failed") while also defeating the error-6 self-heal. The wire can't
  // disambiguate by id, so the fix is to never have two outstanding: chain each send behind
  // the previous. Acks are fast on the LAN, so this doesn't slow the ~1 Hz paint rate.
  send(cmd, value, extra = {}, opts = {}) {
    const run = () => this._sendNow(cmd, value, extra, opts)
    const result = this._sendChain.then(run, run) // run regardless of the previous outcome
    this._sendChain = result.then(() => {}, () => {}) // the chain itself must never reject
    return result
  }

  _sendNow(cmd, value, extra = {}, { timeoutMs = 5000 } = {}) {
    if (!this.socket) return Promise.reject(new Error('not connected'))
    const frame = { cmd, ...extra }
    if (value !== undefined) frame.value = value
    const started = Date.now()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(cmd)
        // A write the board never acked. At debug this is expected noise (SetLayout to the
        // layout it already has never answers — see setLayoutIfNeeded); anywhere else it is
        // the first symptom of a wedged panel, so record the wait.
        blog.debug(`${cmd} timed out`, { cmd, timeoutMs, host: this.host })
        reject(new Error(`${cmd} timed out`))
      }, timeoutMs)
      this._pending.set(cmd, {
        resolve: (v) => {
          clearTimeout(timer)
          blog.debug(`${cmd} ok`, { cmd, ms: Date.now() - started })
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          blog.debug(`${cmd} refused`, { cmd, ms: Date.now() - started, error: e.message })
          reject(e)
        },
      })
      this.socket.write(encode(frame))
    })
  }

  setLayout(name) { return this.send('SetLayout', name) }
  info() { return this.send('Info', '') }

  // Sound the board's buzzer. Payload confirmed from the vendor app + verified audible:
  // `times` = number of beeps, `sleep` = gap between them in seconds. Best-effort.
  horn(times = 2, sleep = 0.3) {
    if (!this.ready) {
      blog.debug('horn skipped — board not ready')
      return Promise.resolve(false)
    }
    blog.info('horn', { times, sleep })
    return this.send('Horn', { times, sleep }).catch((err) => {
      blog.warn(`horn failed: ${err.message}`, { error: err.message })
      return false
    })
  }

  // The one call the app drives on every score change.
  pushState(state) {
    this._lastState = state
    // Each early return below means "the score changed but the panel deliberately did not".
    // They were silent, which made a held paint indistinguishable from a broken one; `skipped`
    // at debug level is how you tell those apart after the fact.
    // Suppress the paint but keep the state: used when a swap is applied immediately before a
    // countdown, so the match layout is never repainted in between (no 0-0 flash, no race with
    // the layout switch). pushCountdown then reads this fresh _lastState.
    if (this._suppressPaint) return this._skipPaint('paint suppressed (pre-countdown swap)')
    if (!this.ready) return this._skipPaint('board not ready')
    // A countdown layout has none of the match sections; writing them there is an error 6.
    // Hold the state instead — pushCountdown(null) repaints it when the countdown ends.
    if (this.currentLayout && this.currentLayout !== this.layout) {
      return this._skipPaint('another layout is up', { currentLayout: this.currentLayout, matchLayout: this.layout })
    }
    // Idle overrides scoring: while the idle screen is up, a stray state push (e.g. a poll)
    // must not repaint the scoreboard over it. showIdle(false) lifts this.
    if (this._idle) return this._skipPaint('idle screen is up')
    const paint = () => this.send('SetSections', this.mapper.toSections(state, { totalTimeouts: this.totalTimeouts, totalSubs: this.totalSubs }))
    // Wrapped: reading the state for a log line must never be what breaks a paint.
    try {
      const v = this.mapper.toLeftRight(state)
      blog.debug('paint', {
        score: `${v.leftPoints}-${v.rightPoints}`, sets: `${v.leftSets}-${v.rightSets}`,
        teams: `${v.leftName}/${v.rightName}`, serve: v.serving, layout: this.currentLayout,
      })
    } catch { /* unreadable state — the paint below is what matters */ }
    return paint().catch(async (err) => {
      // "section not found (6)" means the board is on a different layout than we think.
      // It happens whenever something changes the layout behind our back — most reliably
      // the board's own boot sequence, which paints its info screen AFTER we've set ours.
      // Re-assert the layout once and repaint, rather than silently dropping the score.
      if (!/not found \(6\)/.test(err.message)) throw err
      blog.warn('section not found — re-asserting the layout and repainting', {
        assumedLayout: this.currentLayout, layout: this.layout, error: err.message,
      })
      this.currentLayout = null
      await this.setLayoutIfNeeded(this.layout)
      return paint()
    })
  }

  // A paint that was deliberately withheld. Returns pushState's usual "didn't paint" value.
  _skipPaint(reason, data) {
    blog.debug(`skipped paint — ${reason}`, data)
    return Promise.resolve(false)
  }

  // Update the per-set allowances that drive the counter colours (from operator settings),
  // and repaint so the change shows immediately.
  setLimits({ totalTimeouts, totalSubs, idleFullNames, idleFontMax, clubName } = {}) {
    blog.debug('limits updated', { totalTimeouts, totalSubs, idleFullNames, idleFontMax, clubName })
    if (Number.isFinite(totalTimeouts)) this.totalTimeouts = totalTimeouts
    if (Number.isFinite(totalSubs)) this.totalSubs = totalSubs
    if (typeof idleFullNames === 'boolean') this.idleFullNames = idleFullNames
    if (Number.isFinite(idleFontMax)) this.idleFontMax = idleFontMax
    if (typeof clubName === 'string') this.clubName = clubName
    // If the crest screen is what's currently up, repaint it so a name-style change shows
    // immediately instead of waiting for the next time someone toggles idle.
    if (this.ready && this._idle) this.showIdle(true).catch(() => {})
    if (this.ready && this._lastState && !this._idle && this.currentLayout === this.layout) {
      this.pushState(this._lastState).catch(() => {})
    }
  }

  // True when we have real team names to show (vs a blank/boot "complete" idle).
  _hasTeams() {
    if (!this._lastState) return false
    const v = this.mapper.toLeftRight(this._lastState)
    return !!(String(v.leftName || '').trim() || String(v.rightName || '').trim())
  }

  // Pre-match / between-matches screen: team names + "VS", scores blanked, on the match
  // layout (no image needed). showIdle(false) returns to live scoring.
  async showIdle(on = true) {
    if (!this.ready) {
      blog.debug('showIdle ignored — board not ready', { on })
      return false
    }
    this._idle = !!on
    blog.info(on ? 'idle screen on' : 'idle screen off — back to scoring', { idle: this._idle, hasTeams: this._hasTeams() })
    this.clearPulses()
    try {
      if (on && this.idleLayout) {
        // A "complete" idle — no teams known yet (the boot default) — is the crest on its own
        // layout (no Home/Away). The crest image is baked into the layout, so the QR variant has
        // nothing to push; the clock variant pushes only its two text sections.
        // Gate on EITHER screen being available, not just the crest. Nesting the clock attempt
        // under the crest's availability meant a board with kscw_clock but no kscw_crest never
        // tried the clock at all — while _idleTick went on wanting it, so showIdle was re-entered
        // once a second forever. Silently, too: the layout it wanted was never asked for, so
        // nothing failed and nothing was logged.
        if (!this._hasTeams() && (this._layoutAvailable(this.crestLayout) || this._layoutAvailable(this.clockLayout))) {
          // Two flavours of "complete" idle. crestLayout gives two thirds of the panel to a
          // "Join WiFi" and an "Open UI" QR — instructions for getting connected. Once someone
          // IS connected those are dead space, so clockLayout spends it on the wall clock
          // instead. Anything unexpected falls back to the QR screen, because that is the one
          // that helps an operator who is stranded.
          if (this._layoutAvailable(this.clockLayout) && this.viewerPresent()) {
            try {
              await this.setLayoutIfNeeded(this.clockLayout)
              await this._paintClock(true)
              return true
            } catch (err) {
              this._noteLayoutMissing(this.clockLayout, err)
              this.emit('error', new Error(`clock layout unavailable (${err.message}); using crest`))
            }
          }
          if (this._layoutAvailable(this.crestLayout)) {
            try {
              await this.setLayoutIfNeeded(this.crestLayout)
              return true
            } catch (err) {
              this._noteLayoutMissing(this.crestLayout, err)
              this.emit('error', new Error(`crest layout unavailable (${err.message}); using named idle`))
            }
          }
        }
        // Teams known: the club screen (crest + names). If the device doesn't have that
        // layout (error 5), fall through to the match-layout version.
        if (this._layoutAvailable(this.idleLayout)) {
          try {
            await this.setLayoutIfNeeded(this.idleLayout)
            await this.send('SetSections', this.mapper.toClubIdleSections(this._lastState, { fullNames: this.idleFullNames, maxFontSize: this.idleFontMax, clubName: this.clubName }))
            return true
          } catch (err) {
            this._noteLayoutMissing(this.idleLayout, err)
            this.emit('error', new Error(`club idle layout unavailable (${err.message}); using match layout`))
          }
        }
      }
      await this.setLayoutIfNeeded(this.layout)
      const sections = on ? this.mapper.toIdleSections(this._lastState) : this.mapper.toSections(this._lastState || {})
      await this.send('SetSections', sections)
      return true
    } catch { return false }
  }

  // --- Idle wall clock -------------------------------------------------------------------
  //
  // Shown INSTEAD of the connect-me QR codes once an operator is on the control UI. Deliberately
  // limited to the "no teams known yet" idle screen: once teams are set, kscw_idle already spends
  // that side of the panel on their names.

  // Code 5 is the board saying "I do not have that layout" — a fact about the device, not a
  // transient failure, so it is worth remembering. Any other failure (a timeout, a busy panel)
  // stays retryable.
  _noteLayoutMissing(layout, err) {
    if (layout && err && Number(err.code) === 5) this._missingLayouts.add(layout)
  }

  _layoutAvailable(layout) {
    return !!layout && !this._missingLayouts.has(layout)
  }

  // True when the control UI has been in touch inside viewerTimeoutMs. Fed by noteViewer() from
  // the HTTP layer, so this class never has to know that HTTP exists.
  viewerPresent() {
    return !!this._viewerAt && (Date.now() - this._viewerAt) < this.viewerTimeoutMs
  }

  // Called by the control server on every API request.
  noteViewer() {
    const was = this.viewerPresent()
    this._viewerAt = Date.now()
    // An operator ARRIVING is worth reacting to at once — they are staring at a QR code telling
    // them to do the thing they have just done. Them leaving can wait for the next tick.
    if (!was) this._idleTick().catch(() => {})
  }

  // HH:MM:SS plus a dated line. Sizes are pinned to the layout: 28pt time and 14pt date, both
  // measured against the board's own ARIAL — "23:59:59" is 109px and the date 95px, inside the
  // 128px column. Writes only happen while someone is actually connected (the QR screen never
  // paints), so a ticking second hand costs nothing when the hall is empty.
  formatClock(now = new Date()) {
    const p = (n) => String(n).padStart(2, '0')
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    return {
      time: `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`,
      date: `${days[now.getDay()]} ${p(now.getDate())}.${p(now.getMonth() + 1)}.${now.getFullYear()}`,
    }
  }

  async _paintClock(force = false) {
    const { time, date } = this.formatClock()
    const stamp = `${time}|${date}`
    if (!force && stamp === this._clockText) return false
    await this.send('SetSections', [
      { name: this.clockTimeSection, value: { attrib: 'text', value: time } },
      { name: this.clockDateSection, value: { attrib: 'text', value: date } },
    ])
    this._clockText = stamp
    return true
  }

  // One timer covering both idle-screen jobs: noticing that a viewer arrived or left (QR crest
  // <-> clock) and rolling the clock over. Both only apply to the same screen and both are cheap.
  _startIdleTicker() {
    clearInterval(this._idleTicker)
    if (!this.idleTickMs) return
    this._idleTicker = setInterval(() => { this._idleTick().catch(() => {}) }, this.idleTickMs)
    if (this._idleTicker.unref) this._idleTicker.unref()
  }

  async _idleTick() {
    if (!this.ready || !this._idle || this._suppressPaint) return
    if (this._hasTeams()) return // the named idle screen is up; no room for a clock there
    const want = (this._layoutAvailable(this.clockLayout) && this.viewerPresent())
      ? this.clockLayout
      : (this._layoutAvailable(this.crestLayout) ? this.crestLayout : null)
    // Neither screen exists on this device: showIdle already settled on the match-layout
    // fallback. Bailing here is what stops a board without the KSCW layouts from being asked
    // once a second, forever, for a layout it has already refused.
    if (!want) return
    // Presence flipped: rebuild the whole screen through showIdle so the fallbacks still apply.
    if (this.currentLayout !== want) { await this.showIdle(true); return }
    if (want === this.clockLayout) await this._paintClock()
  }

  // Hold a short message on the break screen, then settle back to idle.
  //
  // Used to confirm a sport switch ON THE PANEL. The idle screens are deliberately sport-neutral
  // (every sport shares kscw_idle/kscw_crest) and a switch restarts into idle, so without this
  // the board looks byte-identical before and after and the operator cannot tell the switch took
  // — the new match layout only appears once someone scores.
  async showSportConfirm(text, ms = 3000) {
    if (!this.ready || !this.breakLayout || !text) return false
    try {
      await this.setLayoutIfNeeded(this.breakLayout)
      // content 'none' blanks the score boxes, so the panel is just the sport name.
      await this.send('SetSections', this.mapper.toBreakSections(null, { timerText: null, label: text, content: 'none' }))
      await new Promise((r) => setTimeout(r, ms))
      // Blank on the way out for the same reason pushCountdown does: the board keeps each
      // layout's section values, so the next countdown would otherwise flash this text.
      await this.send('SetSections', [{ name: this.labelSection, value: { attrib: 'text', value: '' } }]).catch(() => {})
      await this.showIdle(true)
      return true
    } catch { return false }
  }

  // Show (or clear, when secondsLeft == null) a countdown on the board.
  //
  // The device ships `volleyball_matchscore_timeout_02` for exactly this — GetSections on a
  // real C0270 reports it holding `lbl` ("TIMEOUT"), `timer` ("30"), both scores and both set
  // counts. So a timeout, a set interval and the warm-up clock are all the same screen with a
  // different label and number; we switch to it for the duration and switch back after.
  async pushCountdown(secondsLeft, label = '', { content = 'full', team } = {}) {
    if (!this.ready) return false
    this._idle = false // a countdown means the match is live; leave any idle screen
    // The ticker calls this once a second, so only the edges are worth `info`: entering the
    // break screen and leaving it. The seconds themselves are debug.
    if (secondsLeft == null) blog.info('countdown cleared — repainting the match')
    else if (this.currentLayout !== this.breakLayout && this.currentLayout !== this.countdownLayout) {
      blog.info(`countdown started: ${label || '(no label)'} ${Math.round(secondsLeft)}s`, { seconds: Math.round(secondsLeft), label, content, team })
    } else blog.debug('countdown tick', { seconds: Math.round(secondsLeft), label })
    try {
      if (secondsLeft == null) {
        // The board keeps each layout's section values, so the break screen still holds THIS
        // countdown's label and clock after we leave it. Re-entering (TO -> score -> interval)
        // switches the layout back and the old text is on the panel for the whole settle window
        // before the new values land — the operator sees the previous countdown flash up.
        // Blank it on the way out, while its sections still exist.
        // Only the two countdown screens carry these sections — writing them on the idle/crest
        // layout would just earn a "section not found" from the board.
        const onBreak = this.currentLayout === this.breakLayout || this.currentLayout === this.countdownLayout
        if (onBreak) {
          await this.send('SetSections', [
            { name: this.labelSection, value: { attrib: 'text', value: '' } },
            { name: this.timerSection, value: { attrib: 'text', value: '' } },
          ]).catch(() => {}) // cosmetic: never block the return to the match screen
        }
        await this.setLayoutIfNeeded(this.layout)
        if (this._lastState) await this.pushState(this._lastState) // repaint the match
        return true
      }
      // Switching layout costs the device real time; the vendor app inserts settle delays
      // of 200ms+ around every layout change. Without one, the first seconds of a countdown
      // are written into a screen that is not on yet and are simply lost — a 10s countdown
      // was observed starting from 5.
      // Prefer our own break screen; fall back to the vendor's if it isn't on the device.
      let useBreak = !!this.breakLayout
      const want = useBreak ? this.breakLayout : this.countdownLayout
      if (this.currentLayout !== want) {
        try {
          await this.setLayoutIfNeeded(want)
        } catch (err) {
          if (!useBreak) throw err
          this.emit('error', new Error(`break layout unavailable (${err.message}); using vendor countdown`))
          useBreak = false
          await this.setLayoutIfNeeded(this.countdownLayout)
        }
        await new Promise((r) => setTimeout(r, this.layoutSettleMs))
        if (!useBreak) {
          // The vendor layout ships a Tech4Sport logo in `media` covering most of the panel.
          // Blank it once on entry so the clock owns the screen.
          await this.send('SetSections', [{ name: 'media', value: { attrib: 'src', value: '' } }]).catch(() => {})
        }
      } else {
        useBreak = this.currentLayout === this.breakLayout
      }
      const s = Math.max(0, Math.round(secondsLeft))
      // The layout's own default is a bare "30", so stay bare under a minute and only use
      // M:SS once there are minutes to show (set interval, warm-up).
      const timerText = s < 60 ? String(s) : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
      const sections = useBreak
        ? this.mapper.toBreakSections(this._lastState, { timerText, label, content, team })
        : this.mapper.toCountdownSections(this._lastState, { timerText, label, content })
      await this.send('SetSections', sections)
      return true
    } catch { return false }
  }

  // Blink a section for a moment, then stop — the board's acknowledgement that a point or a
  // substitution registered. `animation` is a per-section LAYOUT attribute (it appears in the
  // layout XML alongside fontsize/color/align) and the firmware accepts it live over
  // SetSections; verified blinking on the real panel. That beats faking it by alternating
  // `color` from here, which would have meant writing far faster than the vendor ever does.
  pulse(section, ms = this.pulseMs, color = null) {
    if (!this.ready || !section) return false
    blog.debug(`blink ${section}`, { section, ms, color })
    // Software blink: alternate the section's colour between the team colour and off. The
    // board's native `blinking` can't do team colours (it uses the layout default), so we
    // drive it ourselves. Ends settled on the team colour.
    const team = color || '255,255,255'
    const OFF = '0,0,0'
    const prev = this._pulses.get(section)
    if (prev) prev.cancel() // re-scoring restarts, never stacks
    // Short timeout: a blink toggle is cosmetic and must never hold the serialized send queue
    // (and thus a real score paint queued behind it) for the full 5 s default.
    const paint = (c) => this.send('SetSections', [{ name: section, value: { attrib: 'color', value: c } }], {}, { timeoutMs: 1500 }).catch(() => {})

    // SELF-CLOCKED, not setInterval. `send` allows exactly one command in flight and waits for
    // the board's ack, so a fixed-rate interval enqueues toggles faster than they can drain
    // whenever an ack is slower than pulseIntervalMs. They pile up behind each other AND behind
    // the point's own score repaint, and the panel shows one long smear instead of a blink —
    // which is why the same blinkMs produced two blinks on one side and a single slow one on the
    // other, depending on what was already queued. Chaining each toggle behind its own ack makes
    // the cadence max(pulseIntervalMs, ackLatency): even, backlog-free and identical per side.
    const deadline = Date.now() + ms
    let dark = false
    let timer = null
    let stopped = false
    const entry = {
      color: team,
      cancel: () => { stopped = true; if (timer) clearTimeout(timer) },
    }
    const step = async () => {
      if (stopped) return
      dark = !dark
      await paint(dark ? OFF : team)
      if (stopped) return
      if (Date.now() >= deadline) {
        stopped = true
        this._pulses.delete(section)
        await paint(team) // settle on the team colour
        return
      }
      timer = setTimeout(step, this.pulseIntervalMs)
      if (timer.unref) timer.unref()
    }
    this._pulses.set(section, entry)
    step()
    return true
  }

  // Stop every running blink NOW — cancel the timers and restore each section to its team
  // colour, while the sections still exist (this runs just before a layout switch). Without
  // it a blink could be left mid-toggle (a black score), or carry into the next set.
  clearPulses() {
    const restore = []
    for (const [section, p] of this._pulses) {
      p.cancel()
      if (p.color) restore.push({ name: section, value: { attrib: 'color', value: p.color } })
    }
    this._pulses.clear()
    if (restore.length && this.ready) this.send('SetSections', restore).catch(() => {})
  }

  // Switch layouts only when it actually changes. Re-asking for the current layout gets no
  // reply at all (the device advertises noresend), which would stall for the full timeout.
  async setLayoutIfNeeded(name) {
    if (!name || this.currentLayout === name) return
    this.clearPulses()
    // What the panel is SHOWING is the single most useful thing to have on the record — a
    // wrong screen is the most visible failure this appliance has.
    blog.info(`layout → ${name}`, { from: this.currentLayout, to: name })
    await this.setLayout(name).catch((err) => {
      if (!/timed out/.test(err.message)) throw err // silence here just means "already there"
    })
    this.currentLayout = name
    // The board acks SetLayout before the new layout's sections actually exist, so a
    // section write sent right after can land on the *old* layout and be rejected
    // ("section team1 not found"). That is what ate the first repaint after every
    // reconnect. Every caller paints immediately after switching, so settle here
    // rather than repeating the delay at each call site.
    if (this.layoutSettleMs) await new Promise((r) => setTimeout(r, this.layoutSettleMs))
  }

  // Periodically re-assert the scoreboard layout and repaint, so a desync self-corrects.
  // Deliberately bypasses the `currentLayout` cache — the cache is exactly what goes stale.
  // Skipped while an idle screen or countdown is deliberately showing.
  _startLayoutGuard() {
    clearInterval(this._layoutGuard)
    if (!this.layoutGuardMs) return
    this._layoutGuard = setInterval(async () => {
      if (!this.ready || this._suppressPaint || this._idle) return
      if (this.currentLayout && this.currentLayout !== this.layout) return // a break screen is up
      blog.debug('layout guard — re-asserting the scoreboard', { layout: this.layout })
      await this.setLayout(this.layout).catch(() => {}) // no-op on the board if already set
      this.currentLayout = this.layout
      if (this._lastState) await this.pushState(this._lastState).catch(() => {})
    }, this.layoutGuardMs)
  }

  disconnect() {
    blog.info('disconnecting', { host: this.host })
    this._closing = true
    clearInterval(this._layoutGuard)
    clearInterval(this._idleTicker)
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    this.clearPulses() // stop any blink timers so they can't fire after we close
    if (this.socket) {
      try { this.socket.write(encode({ cmd: 'Disconnect', value: '' })) } catch { /* ignore */ }
      this.socket.end()
    }
  }
}
