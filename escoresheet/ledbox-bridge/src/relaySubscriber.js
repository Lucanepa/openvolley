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
import { log } from './logStore.js'

const PING_MS = 25000

// The relay is the one dependency this appliance cannot see or fix from the venue floor, so
// its whole lifecycle is on the record: which URL, which match, every open/close/retry, and
// every message shape that arrived but carried no usable live-state.
const rlog = log.child('relay')

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
    rlog.info('connecting', { url: this.url, matchId: this.matchId })
    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.addEventListener('open', () => {
      rlog.info('connected', { url: this.url, matchId: this.matchId })
      this.emit('open')
      if (this.matchId) this._send({ type: 'subscribe-match', matchId: this.matchId })
      clearInterval(this._pingTimer)
      this._pingTimer = setInterval(() => this._send({ type: 'ping' }), PING_MS)
    })
    ws.addEventListener('message', (ev) => this._onMessage(ev.data))
    ws.addEventListener('error', (ev) => {
      // Node's WebSocket hands us an ErrorEvent whose `error` is a TypeError with an EMPTY
      // message and no cause — "socket error: " told nobody anything. Name the target instead,
      // which is the fact an operator can actually act on ("is the scoring laptop up?").
      const detail = (ev && ev.error && ev.error.message) || (ev && ev.message) || `cannot reach ${this.url}`
      const err = ev && ev.error && ev.error.message ? ev.error : new Error(detail)
      rlog.error(`socket error: ${detail}`, { url: this.url, matchId: this.matchId })
      this.emit('error', err)
    })
    ws.addEventListener('close', () => {
      clearInterval(this._pingTimer)
      const retry = !this._closing && this.reconnectMs
      rlog[retry ? 'warn' : 'info'](retry ? `disconnected — retrying in ${this.reconnectMs}ms` : 'disconnected', {
        url: this.url, matchId: this.matchId, retrying: !!retry,
      })
      this.emit('close')
      if (retry) setTimeout(() => this._open(), this.reconnectMs)
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
      rlog.warn('unparseable message from the relay', { bytes: String(raw ?? '').length })
      return
    }
    switch (msg.type) {
      case 'connected':
        rlog.info('relay acknowledged the subscription', { matchId: this.matchId })
        this.emit('connected', msg)
        break
      case 'match-full-data':
      case 'match-data-update': {
        if (this.matchId && String(msg.matchId) !== this.matchId) return
        const liveState = msg.data?.liveState
        if (liveState) {
          rlog.debug(`${msg.type} → live-state`, { matchId: msg.matchId })
          this.emit('state', liveState)
        } else {
          // A sync with no computed live-state means the scoreboard app hasn't published one
          // for this match — the board will sit unchanged, which looks like a bridge fault.
          rlog.warn(`${msg.type} carried no liveState`, { matchId: msg.matchId, keys: Object.keys(msg.data || {}) })
          this.emit('nostate', msg) // raw match sync without the computed live-state
        }
        break
      }
      case 'live-state-update': {
        // Dedicated, fresh live-state push (see server.js). This is the normal path.
        if (this.matchId && String(msg.matchId) !== this.matchId) return
        if (msg.liveState) {
          rlog.debug('live-state-update', { matchId: msg.matchId })
          this.emit('state', msg.liveState)
        }
        break
      }
      case 'match-deleted':
        if (!this.matchId || String(msg.matchId) === this.matchId) {
          rlog.warn('the linked match was deleted on the relay', { matchId: msg.matchId })
          this.emit('match-gone', msg)
        }
        break
      default:
        break // pong and other control messages are ignored
    }
  }

  stop() {
    rlog.info('unsubscribing', { url: this.url, matchId: this.matchId })
    this._closing = true
    clearInterval(this._pingTimer)
    try { this.ws?.close() } catch { /* ignore */ }
  }
}
