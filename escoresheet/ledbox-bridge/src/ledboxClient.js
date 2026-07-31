// LEDbox TCP client — connect, Init handshake, push live volleyball state.
//
// Runs in a Node context (Electron main process, or a local sidecar). A browser
// tab cannot open this socket, which is the core reason the connector lives here.
// USB-serial / Bluetooth would swap the transport but reuse encode/decode + mapper.

import net from 'node:net'
import { EventEmitter } from 'node:events'
import { encode, StreamDecoder } from './ledboxProtocol.js'
import { toSections, toCountdownSections } from './volleyballMapper.js'

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
    timerSection = 'timer',
    labelSection = 'lbl',
    reconnectMs = 3000,
    // A TCP connect to an address that isn't routable from here does NOT fail fast — it
    // sits until the kernel gives up (minutes). Without our own deadline the host list
    // never advances and failover silently never happens.
    connectTimeoutMs = 4000,
    // Give the panel time to bring a new layout up before painting into it.
    layoutSettleMs = 400,
  } = {}) {
    super()
    Object.assign(this, { port, alias, sport, apiVersion, layout, countdownLayout, timerSection, labelSection, reconnectMs, connectTimeoutMs, layoutSettleMs })
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

  // The one call the app drives on every score change.
  pushState(state) {
    this._lastState = state
    if (!this.ready) return Promise.resolve(false)
    // A countdown layout has none of the match sections; writing them there is an error 6.
    // Hold the state instead — pushCountdown(null) repaints it when the countdown ends.
    if (this.currentLayout && this.currentLayout !== this.layout) return Promise.resolve(false)
    return this.send('SetSections', toSections(state))
  }

  // Show (or clear, when secondsLeft == null) a countdown on the board.
  //
  // The device ships `volleyball_matchscore_timeout_02` for exactly this — GetSections on a
  // real C0270 reports it holding `lbl` ("TIMEOUT"), `timer` ("30"), both scores and both set
  // counts. So a timeout, a set interval and the warm-up clock are all the same screen with a
  // different label and number; we switch to it for the duration and switch back after.
  async pushCountdown(secondsLeft, label = '') {
    if (!this.ready) return false
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
      if (this.currentLayout !== this.countdownLayout) {
        await this.setLayoutIfNeeded(this.countdownLayout)
        await new Promise((r) => setTimeout(r, this.layoutSettleMs))
      }
      const s = Math.max(0, Math.round(secondsLeft))
      // The layout's own default is a bare "30", so stay bare under a minute and only use
      // M:SS once there are minutes to show (set interval, warm-up).
      const timerText = s < 60 ? String(s) : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
      await this.send('SetSections', toCountdownSections(this._lastState, { timerText, label }))
      return true
    } catch { return false }
  }

  // Switch layouts only when it actually changes. Re-asking for the current layout gets no
  // reply at all (the device advertises noresend), which would stall for the full timeout.
  async setLayoutIfNeeded(name) {
    if (!name || this.currentLayout === name) return
    await this.setLayout(name).catch((err) => {
      if (!/timed out/.test(err.message)) throw err // silence here just means "already there"
    })
    this.currentLayout = name
  }

  disconnect() {
    this._closing = true
    if (this.socket) {
      try { this.socket.write(encode({ cmd: 'Disconnect', value: '' })) } catch { /* ignore */ }
      this.socket.end()
    }
  }
}
