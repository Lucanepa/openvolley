// LEDbox TCP client — connect, Init handshake, push live volleyball state.
//
// Runs in a Node context (Electron main process, or a local sidecar). A browser
// tab cannot open this socket, which is the core reason the connector lives here.
// USB-serial / Bluetooth would swap the transport but reuse encode/decode + mapper.

import net from 'node:net'
import { EventEmitter } from 'node:events'
import { encode, StreamDecoder } from './ledboxProtocol.js'
import { toSections } from './volleyballMapper.js'

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
    timerSection = 'timer', // board section for the countdown; confirm on real hardware
    reconnectMs = 3000,
    // A TCP connect to an address that isn't routable from here does NOT fail fast — it
    // sits until the kernel gives up (minutes). Without our own deadline the host list
    // never advances and failover silently never happens.
    connectTimeoutMs = 4000,
  } = {}) {
    super()
    Object.assign(this, { port, alias, sport, apiVersion, layout, timerSection, reconnectMs, connectTimeoutMs })
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
        await this.setLayout(this.layout).catch((err) => {
          if (!/timed out/.test(err.message)) throw err
        })
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
    return this.send('SetSections', toSections(state))
  }

  // Show (or clear, when secondsLeft == null) a timeout/interval countdown on the board.
  // HARDWARE-UNVERIFIED: the `timer` section name is a best guess for the
  // `volleyball_matchscore` layout — confirm against a real Tech4Sport LedBox at the
  // hardware smoke-test (it may need a custom layout uploaded via TCP :12345). Harmless
  // on the mock (it just stores the section); safe no-op until the board is ready.
  pushCountdown(secondsLeft, label = '') {
    if (!this.ready) return Promise.resolve(false)
    const text = secondsLeft == null
      ? ''
      : `${Math.floor(secondsLeft / 60)}:${String(Math.max(0, secondsLeft) % 60).padStart(2, '0')}`
    const sections = [{ name: this.timerSection || 'timer', value: { attrib: 'text', value: text } }]
    return this.send('SetSections', sections).catch(() => false)
  }

  disconnect() {
    this._closing = true
    if (this.socket) {
      try { this.socket.write(encode({ cmd: 'Disconnect', value: '' })) } catch { /* ignore */ }
      this.socket.end()
    }
  }
}
