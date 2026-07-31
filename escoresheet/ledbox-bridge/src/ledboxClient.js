// LEDbox TCP client — connect, Init handshake, push live volleyball state.
//
// Runs in a Node context (Electron main process, or a local sidecar). A browser
// tab cannot open this socket, which is the core reason the connector lives here.
// USB-serial / Bluetooth would swap the transport but reuse encode/decode + mapper.

import net from 'node:net'
import { EventEmitter } from 'node:events'
import { encode, StreamDecoder } from './ledboxProtocol.js'
import { toSections, toCountdownSections, toIdleSections, toClubIdleSections, toBreakSections } from './volleyballMapper.js'

const CONTROL_PORT = 8889
const HOTSPOT_IP = '172.24.1.1'

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
    // Idle-screen name style. Full club names are auto-shrunk to fit the panel, so
    // idleFontMax is a ceiling (what a short name gets), not a fixed size.
    idleFullNames = true,
    idleFontMax = 24,
    timerSection = 'timer',
    labelSection = 'lbl',
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
  } = {}) {
    super()
    Object.assign(this, { port, alias, sport, apiVersion, layout, countdownLayout, breakLayout, idleLayout, idleFullNames, idleFontMax, timerSection, labelSection, reconnectMs, connectTimeoutMs, layoutSettleMs, layoutGuardMs, pulseMs, pulseIntervalMs, totalTimeouts, totalSubs })
    this._pulses = new Map()
    this._idle = false
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
  }

  connect() {
    this._closing = false
    this.host = this.hosts[this._hostIdx % this.hosts.length]
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
        this._startLayoutGuard()
        // The board advertises `noresend` and stays silent when asked for the layout it
        // already has, so this legitimately times out on every reconnect. Swallow that
        // one case; a real refusal (e.g. error 5, layout not on the device) still surfaces.
        await this.setLayoutIfNeeded(this.layout)
        if (this._lastState) await this.pushState(this._lastState) // repaint after reconnect
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
      // Forget which layout we thought the board had. `currentLayout` is a client-side
      // cache used to skip redundant SetLayout calls, but a board that restarted comes
      // back on its default (`waiting`) — so a stale cache makes setLayoutIfNeeded a
      // no-op and every following section write lands on a layout that isn't loaded
      // ("section team1 not found"), leaving the board stuck on the waiting screen.
      this.currentLayout = null
      // Never got a handshake on this address — try the next one. Once an address has
      // worked we stay on it, so a transient drop doesn't send us wandering.
      if (!reachedReady && this.hosts.length > 1) this._hostIdx++
      this.emit('close')
      if (!this._closing && this.reconnectMs) {
        setTimeout(() => this.connect(), this.reconnectMs)
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
        waiter.reject(new Error(`${msg.sender}: ${detail} (${msg.error_code})`))
      } else {
        waiter.resolve(msg.value)
      }
    }
  }

  // Sends {cmd, ...extra, value} and resolves with the matching response's value.
  send(cmd, value, extra = {}, { timeoutMs = 5000 } = {}) {
    if (!this.socket) return Promise.reject(new Error('not connected'))
    const frame = { cmd, ...extra }
    if (value !== undefined) frame.value = value
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(cmd)
        reject(new Error(`${cmd} timed out`))
      }, timeoutMs)
      this._pending.set(cmd, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.socket.write(encode(frame))
    })
  }

  setLayout(name) { return this.send('SetLayout', name) }
  info() { return this.send('Info', '') }

  // Sound the board's buzzer. Payload confirmed from the vendor app + verified audible:
  // `times` = number of beeps, `sleep` = gap between them in seconds. Best-effort.
  horn(times = 2, sleep = 0.3) {
    if (!this.ready) return Promise.resolve(false)
    return this.send('Horn', { times, sleep }).catch(() => false)
  }

  // The one call the app drives on every score change.
  pushState(state) {
    this._lastState = state
    // Suppress the paint but keep the state: used when a swap is applied immediately before a
    // countdown, so the match layout is never repainted in between (no 0-0 flash, no race with
    // the layout switch). pushCountdown then reads this fresh _lastState.
    if (this._suppressPaint) return Promise.resolve(false)
    if (!this.ready) return Promise.resolve(false)
    // A countdown layout has none of the match sections; writing them there is an error 6.
    // Hold the state instead — pushCountdown(null) repaints it when the countdown ends.
    if (this.currentLayout && this.currentLayout !== this.layout) return Promise.resolve(false)
    // Idle overrides scoring: while the idle screen is up, a stray state push (e.g. a poll)
    // must not repaint the scoreboard over it. showIdle(false) lifts this.
    if (this._idle) return Promise.resolve(false)
    const paint = () => this.send('SetSections', toSections(state, { totalTimeouts: this.totalTimeouts, totalSubs: this.totalSubs }))
    return paint().catch(async (err) => {
      // "section not found (6)" means the board is on a different layout than we think.
      // It happens whenever something changes the layout behind our back — most reliably
      // the board's own boot sequence, which paints its info screen AFTER we've set ours.
      // Re-assert the layout once and repaint, rather than silently dropping the score.
      if (!/not found \(6\)/.test(err.message)) throw err
      this.currentLayout = null
      await this.setLayoutIfNeeded(this.layout)
      return paint()
    })
  }

  // Update the per-set allowances that drive the counter colours (from operator settings),
  // and repaint so the change shows immediately.
  setLimits({ totalTimeouts, totalSubs, idleFullNames, idleFontMax } = {}) {
    if (Number.isFinite(totalTimeouts)) this.totalTimeouts = totalTimeouts
    if (Number.isFinite(totalSubs)) this.totalSubs = totalSubs
    if (typeof idleFullNames === 'boolean') this.idleFullNames = idleFullNames
    if (Number.isFinite(idleFontMax)) this.idleFontMax = idleFontMax
    // If the crest screen is what's currently up, repaint it so a name-style change shows
    // immediately instead of waiting for the next time someone toggles idle.
    if (this.ready && this._idle) this.showIdle(true).catch(() => {})
    if (this.ready && this._lastState && !this._idle && this.currentLayout === this.layout) {
      this.pushState(this._lastState).catch(() => {})
    }
  }

  // Pre-match / between-matches screen: team names + "VS", scores blanked, on the match
  // layout (no image needed). showIdle(false) returns to live scoring.
  async showIdle(on = true) {
    if (!this.ready) return false
    this._idle = !!on
    this.clearPulses()
    try {
      if (on && this.idleLayout) {
        // Preferred: the club screen. If the device doesn't have that layout (error 5),
        // don't lose the idle screen entirely — fall through to the match-layout version.
        try {
          await this.setLayoutIfNeeded(this.idleLayout)
          await this.send('SetSections', toClubIdleSections(this._lastState, { fullNames: this.idleFullNames, maxFontSize: this.idleFontMax }))
          return true
        } catch (err) {
          this.emit('error', new Error(`club idle layout unavailable (${err.message}); using match layout`))
        }
      }
      await this.setLayoutIfNeeded(this.layout)
      const sections = on ? toIdleSections(this._lastState) : toSections(this._lastState || {})
      await this.send('SetSections', sections)
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
    try {
      if (secondsLeft == null) {
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
        ? toBreakSections(this._lastState, { timerText, label, content, team })
        : toCountdownSections(this._lastState, { timerText, label, content })
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
    // Software blink: alternate the section's colour between the team colour and off. The
    // board's native `blinking` can't do team colours (it uses the layout default), so we
    // drive it ourselves. Ends settled on the team colour.
    const team = color || '255,255,255'
    const OFF = '0,0,0'
    const prev = this._pulses.get(section)
    if (prev) { clearInterval(prev.timer); clearTimeout(prev.stop) } // re-scoring restarts, never stacks
    const paint = (c) => this.send('SetSections', [{ name: section, value: { attrib: 'color', value: c } }]).catch(() => {})
    let dark = true
    paint(OFF)
    const timer = setInterval(() => { dark = !dark; paint(dark ? OFF : team) }, this.pulseIntervalMs)
    const stop = setTimeout(() => {
      clearInterval(timer)
      this._pulses.delete(section)
      paint(team) // settle on the team colour
    }, ms)
    if (timer.unref) timer.unref()
    if (stop.unref) stop.unref()
    this._pulses.set(section, { timer, stop, color: team })
    return true
  }

  // Stop every running blink NOW — cancel the timers and restore each section to its team
  // colour, while the sections still exist (this runs just before a layout switch). Without
  // it a blink could be left mid-toggle (a black score), or carry into the next set.
  clearPulses() {
    const restore = []
    for (const [section, p] of this._pulses) {
      clearInterval(p.timer)
      clearTimeout(p.stop)
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
      await this.setLayout(this.layout).catch(() => {}) // no-op on the board if already set
      this.currentLayout = this.layout
      if (this._lastState) await this.pushState(this._lastState).catch(() => {})
    }, this.layoutGuardMs)
  }

  disconnect() {
    this._closing = true
    clearInterval(this._layoutGuard)
    this.clearPulses() // stop any blink timers so they can't fire after we close
    if (this.socket) {
      try { this.socket.write(encode({ cmd: 'Disconnect', value: '' })) } catch { /* ignore */ }
      this.socket.end()
    }
  }
}
