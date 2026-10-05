/**
 * The scorer's side of the match relay, kept out of the components so it can be
 * tested: which PINs go with a sync, the order of live-state pushes and
 * match_live_state writes, and how long to wait before reconnecting.
 * Used by Scoreboard.jsx and App.jsx.
 */
import { relayMatchPayload, getRelayServerStatus } from './serverDataSync'

/**
 * PINs go to the relay with the first sync on a socket and when one changed;
 * the relay keeps the stored ones meanwhile. Any relay error about the match
 * (a refusal, a lost room, 'pins-required') makes the next sync carry them again.
 */
export function createRelayPinTracker() {
  let sent = { ws: null, signature: null }
  return {
    /**
     * The match object for a sync on `ws`. Call commit() once it was sent.
     * @returns {{ match: object, commit: () => void }}
     */
    payloadFor(ws, match) {
      const { match: out, pinSignature } = relayMatchPayload(match, sent.ws === ws ? sent.signature : null)
      return { match: out, commit: () => { sent = { ws, signature: pinSignature } } }
    },
    reset() {
      sent = { ws: null, signature: null }
    }
  }
}

/**
 * True for a relay `error` message about this match: it names one of `ids`
 * (the relay key or the local id), or names none at all.
 */
export function isRelayErrorFor(message, ids) {
  if (!message || message.type !== 'error') return false
  if (message.matchId === undefined || message.matchId === null) return true
  const id = String(message.matchId)
  return ids.some((k) => k !== undefined && k !== null && String(k) === id)
}

/**
 * Orders the live-state of one scorer. Each snapshot takes a sequence number
 * when it is computed (next()), not a wall-clock time: a clock stepped back by
 * NTP must not freeze the referee and the livescore.
 * - shouldPush(seq): the relay push of a snapshot older than one already pushed
 *   is dropped (on a side-out the 'point' snapshot from before the rotation and
 *   the 'rotation' one race);
 * - write(seq, fn): match_live_state upserts run one at a time, and one older
 *   than the last written is skipped (concurrent upserts are last-write-wins).
 */
export function createLiveStateOrder() {
  let seq = 0
  let lastPushed = 0
  let lastWritten = 0
  let chain = Promise.resolve()
  return {
    next() {
      seq += 1
      return seq
    },
    shouldPush(n) {
      if (n < lastPushed) return false
      lastPushed = n
      return true
    },
    /** @returns {Promise<any>} fn's result, or { skipped: true } */
    write(n, fn) {
      const run = async () => {
        if (n < lastWritten) return { skipped: true }
        lastWritten = n
        return fn()
      }
      const pending = chain.then(run, run)
      chain = pending.catch(() => {})
      return pending
    }
  }
}

export const RELAY_RECONNECT_BASE_MS = 5000
export const RELAY_RECONNECT_MAX_MS = 60000

/**
 * Delay before reconnect attempt `attempt` (0 = first after a drop): 5 s,
 * 10 s, 20 s, 40 s, then 60 s. A relay that is not there (offline hall on a
 * cloud build) is not hammered with a new socket every few seconds.
 */
export function relayReconnectDelay(attempt) {
  const n = Math.max(0, Math.min(Number(attempt) || 0, 16))
  return Math.min(RELAY_RECONNECT_BASE_MS * 2 ** n, RELAY_RECONNECT_MAX_MS)
}

const WS_CONNECTING = 0
const WS_OPEN = 1

/**
 * The relay entry of the scorer's connection status. The scorer's own socket
 * when it is open; otherwise GET /api/server/status (getRelayServerStatus, as
 * the referee and bench apps do), never a throwaway probe socket.
 * @param {{ wsUrl: string|null, ws?: { readyState: number }|null, getStatus?: () => Promise<{ running: boolean }> }} args
 * @returns {Promise<{ status: string, message: string, details?: string }>}
 */
export async function relayConnectionStatus({ wsUrl, ws = null, getStatus = getRelayServerStatus }) {
  if (!wsUrl) {
    return { status: 'not_available', message: 'No WebSocket relay for this page (using local database only)' }
  }
  if (ws && ws.readyState === WS_OPEN) {
    return { status: 'connected', message: 'WebSocket server is reachable (active connection)' }
  }
  const { running } = await getStatus()
  if (running) {
    return { status: 'connected', message: 'WebSocket server is reachable', details: `Relay: ${wsUrl}` }
  }
  if (ws && ws.readyState === WS_CONNECTING) {
    return { status: 'connecting', message: 'Connecting to the WebSocket server...' }
  }
  return {
    status: 'disconnected',
    message: 'Not connected to the WebSocket server (retrying in the background)',
    details: `Relay: ${wsUrl}`
  }
}
