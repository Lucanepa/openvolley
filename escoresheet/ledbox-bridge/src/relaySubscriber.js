// Subscribes to the OpenVolley LAN relay and emits the flat live-state that the
// Scoreboard computes (points_a, subs_a, serving_team as 'left'/'right', team
// colours, ...). The relay wraps each update as { type, matchId, data }; we read
// `data.liveState`.
//
// Uses Node's built-in global WebSocket (Node >= 22), so there is no npm
// dependency in production.
//
// Relay protocol (see escoresheet/frontend/server.js):
//   -> { type: 'subscribe-match', matchId }
//   <- { type: 'match-full-data',   matchId, data }   (initial, on subscribe)
//   <- { type: 'match-data-update', matchId, data }   (on every scoreboard sync)
//   <- { type: 'match-deleted',     matchId }
//   keepalive: -> { type: 'ping' }  <- { type: 'pong' }

import { EventEmitter } from 'node:events'

const PING_MS = 25000

export class RelaySubscriber extends EventEmitter {
  constructor({ url, matchId, reconnectMs = 3000 } = {}) {
    super()
    this.url = url
    this.matchId = matchId != null ? String(matchId) : null
    this.reconnectMs = reconnectMs
    this.ws = null
    this._closing = false
    this._pingTimer = null
  }

  start() {
    this._closing = false
    this._open()
  }

  _open() {
    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.addEventListener('open', () => {
      this.emit('open')
      if (this.matchId) this._send({ type: 'subscribe-match', matchId: this.matchId })
      clearInterval(this._pingTimer)
      this._pingTimer = setInterval(() => this._send({ type: 'ping' }), PING_MS)
    })
    ws.addEventListener('message', (ev) => this._onMessage(ev.data))
    ws.addEventListener('error', (ev) => this.emit('error', ev?.error || new Error('relay ws error')))
    ws.addEventListener('close', () => {
      clearInterval(this._pingTimer)
      this.emit('close')
      if (!this._closing && this.reconnectMs) setTimeout(() => this._open(), this.reconnectMs)
    })
  }

  _send(obj) {
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj))
    } catch { /* ignore transient send errors */ }
  }

  _onMessage(raw) {
    let msg
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    switch (msg.type) {
      case 'connected':
        this.emit('connected', msg)
        break
      case 'match-full-data':
      case 'match-data-update': {
        if (this.matchId && String(msg.matchId) !== this.matchId) return
        const liveState = msg.data?.liveState
        if (liveState) this.emit('state', liveState)
        else this.emit('nostate', msg) // relay payload has no computed live-state
        break
      }
      case 'match-deleted':
        if (!this.matchId || String(msg.matchId) === this.matchId) this.emit('match-gone', msg)
        break
      default:
        break // pong and other control messages are ignored
    }
  }

  stop() {
    this._closing = true
    clearInterval(this._pingTimer)
    try { this.ws?.close() } catch { /* ignore */ }
  }
}
