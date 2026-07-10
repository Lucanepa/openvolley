// SourceManager owns whichever Source (manual / LAN / cloud) currently drives the
// board. Swapping sources tears down the old one's listeners, caches the last
// liveState so the appliance can repaint or report status, and re-emits every
// source 'state' upward for the appliance to push to the LedBox.

import { EventEmitter } from 'node:events'

export class SourceManager extends EventEmitter {
  constructor() {
    super()
    this.active = null
    this._last = null
    this._meta = { mode: 'idle', matchId: null }
    this._onState = null
    this._onError = null
  }

  setSource(source, meta = {}) {
    // Tear down the previous source (stop + drop our listeners).
    if (this.active) {
      try { this.active.stop() } catch { /* ignore */ }
      if (this._onState) this.active.removeListener('state', this._onState)
      if (this._onError) this.active.removeListener('error', this._onError)
    }
    this.active = source
    this._meta = { mode: meta.mode ?? 'idle', matchId: meta.matchId ?? null }

    this._onState = (s) => { this._last = s; this.emit('state', s) }
    // A source that emits 'error' with no listener would crash the process (Node
    // throws on unheard 'error' events); always listen and forward it upward.
    this._onError = (e) => { this.emit('error', e) }
    source.on('state', this._onState)
    source.on('error', this._onError)
    source.start()

    // Some sources (manual) expose a current state synchronously — surface it now.
    if (typeof source.getState === 'function') {
      const s = source.getState()
      if (s != null) { this._last = s; this.emit('state', s) }
    }
  }

  get status() {
    return { mode: this._meta.mode, matchId: this._meta.matchId }
  }

  getState() {
    return this._last ?? null
  }

  stop() {
    if (this.active) {
      try { this.active.stop() } catch { /* ignore */ }
      if (this._onState) this.active.removeListener('state', this._onState)
      if (this._onError) this.active.removeListener('error', this._onError)
    }
  }
}
