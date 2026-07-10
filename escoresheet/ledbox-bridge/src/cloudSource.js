// Cloud (Supabase) source for the LedBox appliance — STUB. Mirroring a match
// straight from the cloud (no LAN relay) is not wired up yet; starting it just
// surfaces an error so the operator gets clear feedback.

import { EventEmitter } from 'node:events'

export class CloudSource extends EventEmitter {
  // TODO subscribe to Supabase match_live_state realtime and emit 'state' liveState.
  start() {
    queueMicrotask(() => this.emit('error', new Error('cloud (Supabase) source not implemented yet')))
  }

  stop() {}
}
