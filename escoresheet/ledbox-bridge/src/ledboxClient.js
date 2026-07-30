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
    host = HOTSPOT_IP,
    port = CONTROL_PORT,
    alias = 'openvolley',
    sport = 'volleyball',
    apiVersion = 2,
    layout = 'volleyball_matchscore_02',
    timerSection = 'timer', // board section for the countdown; confirm on real hardware
    reconnectMs = 3000,
  } = {}) {
    super()
    Object.assign(this, { host, port, alias, sport, apiVersion, layout, timerSection, reconnectMs })
    this.socket = null
    this.decoder = new StreamDecoder()
    this.ready = false
    this._pending = new Map() // sender -> resolver, for request/response
    this._closing = false
    this._lastState = null
  }

  connect() {
    this._closing = false
    const socket = net.connect({ host: this.host, port: this.port }, async () => {
      this.emit('connect')
      try {
        const info = await this.send('Init', undefined, {
          alias: this.alias,
          sport: this.sport,
          value: { version: this.apiVersion, typeDevice: 'app' },
        })
        this.ready = true
        this.emit('ready', info)
        await this.setLayout(this.layout)
        if (this._lastState) await this.pushState(this._lastState) // repaint after reconnect
      } catch (err) {
        this.emit('error', err)
      }
    })
    socket.on('data', (chunk) => {
      for (const msg of this.decoder.push(chunk)) this._onMessage(msg)
    })
    socket.on('error', (err) => this.emit('error', err))
    socket.on('close', () => {
      this.ready = false
      this.socket = null
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
        waiter.reject(new Error(`${msg.sender}: ${msg.message || 'error'} (${msg.error_code})`))
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
