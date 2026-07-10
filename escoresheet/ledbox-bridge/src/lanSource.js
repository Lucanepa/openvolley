// LAN source for the LedBox appliance — a thin adapter over RelaySubscriber that
// mirrors a live OpenVolley match on the local relay. Forwards the relay's
// liveState 'state' events through unchanged, and folds its socket lifecycle
// events into a uniform 'status'/'error' surface for the SourceManager.

import { EventEmitter } from 'node:events'
import { RelaySubscriber } from './relaySubscriber.js'

export class LanSource extends EventEmitter {
  constructor({ relayUrl, matchId, reconnectMs } = {}) {
    super()
    this.relayUrl = relayUrl
    this.matchId = matchId != null ? String(matchId) : null
    this.reconnectMs = reconnectMs
    this.sub = null
  }

  start() {
    this.sub = new RelaySubscriber({ url: this.relayUrl, matchId: this.matchId, reconnectMs: this.reconnectMs })
    this.sub.on('state', (liveState) => this.emit('state', liveState))
    this.sub.on('open', () => this.emit('status', 'open'))
    this.sub.on('close', () => this.emit('status', 'close'))
    this.sub.on('error', (err) => this.emit('error', err))
    this.sub.start()
  }

  stop() {
    try { this.sub?.stop() } catch { /* ignore */ }
    this.sub = null
  }
}
