/**
 * relayRealtime — a drop-in for the slice of supabase-js Realtime the app
 * uses, running over one WebSocket to the OpenVolley relay (`?purpose=live`)
 * instead of Supabase.
 *
 * Supported surface (everything the call sites use):
 *   const ch = client.channel(name)
 *     .on('postgres_changes', { event, schema, table, filter }, (payload) => {})
 *     .subscribe((status, err) => {})            // returns the channel
 *   client.removeChannel(ch)                      // null-safe, resolves 'ok'
 *   ch.unsubscribe(), client.getChannels(), client.removeAllChannels()
 *
 *   event   '*' | 'INSERT' | 'UPDATE' | 'DELETE'
 *   filter  optional, `<column>=eq.<value>` only (e.g. match_id=eq.<uuid>,
 *           external_id=eq.<seed>, sport_type=eq.indoor)
 *   status  'SUBSCRIBED' on server ack (again after every reconnect),
 *           'TIMED_OUT' when no ack within 10 s, 'CHANNEL_ERROR' (with an
 *           Error) when the server refuses the channel or the socket drops,
 *           'CLOSED' on removeChannel/unsubscribe.
 *   payload { schema, table, commit_timestamp, eventType, new, old, errors }
 *           new is {} for DELETE, old is {} unless the server sent a row.
 *
 * Wire protocol: see escoresheet/backend/lib/realtimeHub.js. In short:
 *   -> { type:'subscribe-db', id, subs:[{table, event, column?, value?}] }
 *   <- { type:'subscribe-db-ack', id } | { type:'subscribe-db-error', id, code, message }
 *   -> { type:'unsubscribe-db', id }
 *   <- { type:'db-change', id, ids?, schema, table, eventType, new, old, commit_timestamp }
 *        (ids: every channel of this socket the row is for; the server sends a
 *        row once per socket)
 *   -> { type:'ping' }  <- { type:'pong' }
 *
 * The socket opens lazily on the first subscribe, reconnects with
 * exponential backoff plus jitter, re-subscribes every channel after a
 * reconnect and closes itself shortly after the last channel is removed.
 *
 * Liveness: every 25 s it sends an application ping (browsers cannot see the
 * server's protocol pings) and drops the socket only if nothing at all comes
 * back within pongTimeoutMs of that ping. The check never compares against the
 * time of the last message, so background-tab timer throttling (one tick a
 * minute) cannot make a healthy socket look dead. When the tab becomes visible
 * with a socket open, it probes at once instead of waiting for the next tick.
 *
 * Capability check: the first frame must be { type:'connected', mode:'live',
 * protocol >= 1 }. A relay without live support (the LAN relays in
 * frontend/server.js, lanRelayCore.js and Electron answer mode 'local' or no
 * mode) is remembered as unsupported for that URL: the socket is closed, every
 * channel gets CHANNEL_ERROR (err.code 'unsupported') once, and no further
 * sockets are opened to that URL until the backend URL changes.
 *
 * The backend URL is resolved on every connect attempt through
 * utils/backendConfig.js, so a runtime override takes effect on reconnect.
 */
import { getWebSocketUrl } from '../utils/backendConfig'

export const REALTIME_SUBSCRIBE_STATES = Object.freeze({
  SUBSCRIBED: 'SUBSCRIBED',
  TIMED_OUT: 'TIMED_OUT',
  CLOSED: 'CLOSED',
  CHANNEL_ERROR: 'CHANNEL_ERROR'
})

const EVENTS = new Set(['*', 'INSERT', 'UPDATE', 'DELETE'])
const OPEN = 1

/**
 * Parse a supabase-js postgres_changes filter. Only `col=eq.value` is supported.
 * @param {string|undefined|null} filter
 * @returns {{column: string, value: string} | null}  null for "no filter"
 * @throws {Error} on unsupported syntax
 */
export function parseFilter(filter) {
  if (filter == null || filter === '') return null
  if (typeof filter !== 'string') throw new Error('filter must be a string')
  const eqAt = filter.indexOf('=')
  if (eqAt <= 0) throw new Error(`invalid filter: ${filter}`)
  const column = filter.slice(0, eqAt).trim()
  const rest = filter.slice(eqAt + 1)
  if (!rest.startsWith('eq.')) throw new Error(`unsupported filter operator (only eq): ${filter}`)
  const value = rest.slice(3)
  if (!/^[a-z_][a-z0-9_]*$/i.test(column)) throw new Error(`invalid filter column: ${column}`)
  if (value === '') throw new Error(`empty filter value: ${filter}`)
  return { column, value }
}

/** Append `purpose=live` to the relay WebSocket base URL. */
export function toLiveUrl(base) {
  const url = new URL(base)
  if (!url.pathname) url.pathname = '/'
  url.searchParams.set('purpose', 'live')
  return url.toString()
}

let channelSeq = 0

class RelayChannel {
  constructor(client, name, params) {
    this._client = client
    this.name = String(name)
    this.topic = `realtime:${this.name}`
    this.params = params || {}
    this.bindings = []
    this.state = 'closed' // closed | joining | joined | errored
    this._wireId = `${++channelSeq}:${this.name}`.slice(0, 128)
    this._statusCb = null
    this._bindingError = null
    this._subscribed = false // subscribe() was called
    this._lastStatus = null
    this._joinTimer = null
  }

  /**
   * @param {'postgres_changes'|string} type
   * @param {{event?: string, schema?: string, table: string, filter?: string}} filter
   * @param {(payload: object) => void} callback
   */
  on(type, filter, callback) {
    if (type !== 'postgres_changes') {
      this._client._log('warn', `[relayRealtime] "${type}" bindings are not supported; ignored`)
      return this
    }
    try {
      const event = String(filter?.event ?? '*').toUpperCase()
      if (!EVENTS.has(event)) throw new Error(`unsupported event: ${filter?.event}`)
      const schema = filter?.schema ?? 'public'
      if (schema !== 'public') throw new Error(`unsupported schema: ${schema}`)
      if (!filter?.table || typeof filter.table !== 'string') throw new Error('table is required')
      if (typeof callback !== 'function') throw new Error('callback must be a function')
      const parsed = parseFilter(filter.filter)
      this.bindings.push({ event, schema, table: filter.table, column: parsed?.column ?? null, value: parsed?.value ?? null, callback })
    } catch (err) {
      this._bindingError = err
    }
    // A binding added after subscribe() is sent as a replacement subscription.
    if (this._subscribed) this._client._join(this)
    return this
  }

  /**
   * @param {(status: string, err?: Error) => void} [callback]
   * @param {number} [timeoutMs]
   */
  subscribe(callback, timeoutMs) {
    if (typeof callback === 'function') this._statusCb = callback
    if (timeoutMs) this._timeoutMs = timeoutMs
    if (this._subscribed) return this
    this._subscribed = true
    this._client._join(this)
    return this
  }

  unsubscribe() {
    return this._client.removeChannel(this)
  }

  _emit(status, err) {
    // Repeated identical error states are not re-announced (offline loops).
    if (status === this._lastStatus && status !== REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) return
    this._lastStatus = status
    if (!this._statusCb) return
    try {
      this._statusCb(status, err)
    } catch (e) {
      this._client._log('error', '[relayRealtime] status callback threw:', e)
    }
  }

  _subsForWire() {
    return this.bindings.map(b => (b.column
      ? { table: b.table, schema: 'public', event: b.event, column: b.column, value: b.value }
      : { table: b.table, schema: 'public', event: b.event }))
  }

  _dispatch(msg) {
    const eventType = msg.eventType
    const payload = {
      schema: msg.schema || 'public',
      table: msg.table,
      commit_timestamp: msg.commit_timestamp,
      eventType,
      new: msg.new || {},
      old: msg.old || {},
      errors: null
    }
    const row = eventType === 'DELETE' ? payload.old : payload.new
    for (const b of this.bindings) {
      if (b.table !== msg.table) continue
      if (b.event !== '*' && b.event !== eventType) continue
      if (b.column && (row?.[b.column] == null || String(row[b.column]) !== b.value)) continue
      try {
        b.callback(payload)
      } catch (e) {
        this._client._log('error', '[relayRealtime] postgres_changes callback threw:', e)
      }
    }
  }
}

/**
 * @param {Object} [options]
 * @param {() => string|null} [options.getUrl]  WebSocket base URL (default: backendConfig.getWebSocketUrl)
 * @param {typeof WebSocket} [options.WebSocketImpl]  default: globalThis.WebSocket at connect time
 * @param {number} [options.subscribeTimeoutMs=10000]
 * @param {number} [options.reconnectBaseMs=1000]
 * @param {number} [options.reconnectMaxMs=30000]
 * @param {number} [options.heartbeatMs=25000]
 * @param {number} [options.pongTimeoutMs=10000]
 * @param {number} [options.idleCloseMs=5000]  close the socket this long after the last channel goes
 * @param {() => number} [options.random=Math.random]  jitter source (tests)
 * @param {Console} [options.logger=console]
 */
export function createRelayRealtime(options = {}) {
  const {
    getUrl = getWebSocketUrl,
    WebSocketImpl,
    subscribeTimeoutMs = 10000,
    reconnectBaseMs = 1000,
    reconnectMaxMs = 30000,
    heartbeatMs = 25000,
    pongTimeoutMs = 10000,
    idleCloseMs = 5000,
    random = Math.random,
    logger = console
  } = options

  /** @type {Map<string, RelayChannel>} */
  const channels = new Map()
  let ws = null
  let wsBase = null // base URL the current socket was opened for
  let helloSeen = false // current socket sent a valid live 'connected'
  let unsupportedBase = null // base URL known to lack live support
  let attempts = 0
  let reconnectTimer = null
  let heartbeatTimer = null
  let pongTimer = null
  let idleTimer = null
  let listening = false

  const client = {
    channel(name, params) {
      return new RelayChannel(client, name, params)
    },

    removeChannel(channel) {
      if (!channel || !(channel instanceof RelayChannel)) return Promise.resolve('ok')
      const known = channels.get(channel._wireId) === channel
      channels.delete(channel._wireId)
      clearTimeout(channel._joinTimer)
      channel._joinTimer = null
      if (known && ws && ws.readyState === OPEN) {
        sendRaw({ type: 'unsubscribe-db', id: channel._wireId })
      }
      const wasActive = channel._subscribed
      channel._subscribed = false
      channel.state = 'closed'
      if (wasActive) channel._emit(REALTIME_SUBSCRIBE_STATES.CLOSED)
      if (channels.size === 0) scheduleIdleClose()
      return Promise.resolve('ok')
    },

    removeAllChannels() {
      return Promise.all([...channels.values()].map(ch => client.removeChannel(ch)))
    },

    getChannels() {
      return [...channels.values()]
    },

    /** Close the socket, drop every channel and stop reconnecting (tests, teardown). */
    disconnect() {
      for (const ch of [...channels.values()]) client.removeChannel(ch)
      clearTimeout(idleTimer)
      idleTimer = null
      closeSocket()
      stopListening()
    },

    /** Connection state, for debugging panels. */
    get connectionState() {
      if (!ws) {
        if (reconnectTimer) return 'reconnecting'
        return unsupportedBase ? 'unsupported' : 'closed'
      }
      return ws.readyState === OPEN ? 'open' : 'connecting'
    },

    _join(channel) {
      clearTimeout(idleTimer)
      idleTimer = null
      if (channel._bindingError) {
        channel.state = 'errored'
        channel._emit(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR, channel._bindingError)
        return
      }
      if (channel.bindings.length === 0) {
        channel.state = 'errored'
        channel._emit(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR, new Error('channel has no postgres_changes bindings'))
        return
      }
      channels.set(channel._wireId, channel)
      startJoin(channel)
      if (ws && ws.readyState === OPEN) sendSubscribe(channel)
      else ensureConnected()
    },

    _log(level, ...args) {
      try { logger?.[level]?.(...args) } catch { /* ignore */ }
    }
  }

  function sendRaw(obj) {
    try {
      ws.send(JSON.stringify(obj))
      return true
    } catch {
      return false
    }
  }

  function startJoin(channel) {
    channel.state = channel.state === 'joined' ? 'joined' : 'joining'
    clearTimeout(channel._joinTimer)
    const timeout = channel._timeoutMs || subscribeTimeoutMs
    channel._joinTimer = setTimeout(() => {
      channel._joinTimer = null
      if (channel.state === 'joining' && channels.get(channel._wireId) === channel) {
        channel._emit(REALTIME_SUBSCRIBE_STATES.TIMED_OUT)
      }
    }, timeout)
  }

  function sendSubscribe(channel) {
    sendRaw({ type: 'subscribe-db', id: channel._wireId, subs: channel._subsForWire() })
  }

  function ensureConnected() {
    if (ws || reconnectTimer) return
    connect()
  }

  function connect() {
    reconnectTimer = null
    if (channels.size === 0) return
    startListening()

    let base = null
    try { base = getUrl() } catch (err) { client._log('warn', '[relayRealtime] getUrl failed:', err) }
    const Impl = WebSocketImpl || globalThis.WebSocket
    if (!base || !Impl) {
      failChannels(new Error(base ? 'WebSocket is not available' : 'No backend available for realtime'))
      scheduleReconnect()
      return
    }
    if (base === unsupportedBase) {
      // Known not to speak the live protocol: no socket, no retry loop. A new
      // subscribe, 'online' or a visible tab re-checks the URL.
      failChannels(unsupportedError())
      return
    }

    let socket
    try {
      socket = new Impl(toLiveUrl(base))
    } catch (err) {
      failChannels(err instanceof Error ? err : new Error(String(err)))
      scheduleReconnect()
      return
    }
    ws = socket
    wsBase = base
    helloSeen = false

    socket.onopen = () => {
      if (ws !== socket) return
      startHeartbeat()
      for (const ch of channels.values()) {
        startJoin(ch)
        sendSubscribe(ch)
      }
    }
    socket.onmessage = (event) => {
      if (ws !== socket) return
      // Any frame proves the socket is alive.
      clearTimeout(pongTimer)
      pongTimer = null
      let msg
      try { msg = JSON.parse(event.data) } catch { return }
      if (!helloSeen) {
        if (msg && msg.type === 'connected' && msg.mode === 'live' && Number(msg.protocol) >= 1) {
          helloSeen = true
        } else {
          markUnsupported()
          return
        }
      }
      handleMessage(msg)
    }
    socket.onerror = () => { /* a close event follows */ }
    socket.onclose = (event) => {
      if (ws !== socket) return
      onSocketGone(new Error(`Realtime connection closed${event?.code ? ` (${event.code})` : ''}`))
    }
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'connected':
        // The server accepted us (cap checks happen before this message).
        attempts = 0
        return
      case 'subscribe-db-ack': {
        const ch = channels.get(msg.id)
        if (!ch) return
        clearTimeout(ch._joinTimer)
        ch._joinTimer = null
        ch.state = 'joined'
        ch._emit(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED)
        return
      }
      case 'subscribe-db-error': {
        const ch = channels.get(msg.id)
        if (!ch) return
        clearTimeout(ch._joinTimer)
        ch._joinTimer = null
        ch.state = 'errored'
        const err = new Error(msg.message || 'subscription refused')
        err.code = msg.code
        ch._emit(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR, err)
        return
      }
      case 'db-change': {
        const ids = Array.isArray(msg.ids) ? [...new Set(msg.ids)] : [msg.id]
        for (const id of ids) {
          const ch = channels.get(id)
          if (ch && ch.state === 'joined') ch._dispatch(msg)
        }
        return
      }
      default:
        // pong, unsubscribe-db-ack: liveness only
    }
  }

  function unsupportedError() {
    const err = new Error('This server does not support realtime database changes')
    err.code = 'unsupported'
    return err
  }

  function markUnsupported() {
    unsupportedBase = wsBase
    client._log('warn', '[relayRealtime] relay has no live (purpose=live) support:', wsBase)
    closeSocket()
    failChannels(unsupportedError())
  }

  function failChannels(err) {
    for (const ch of channels.values()) {
      ch.state = 'errored'
      clearTimeout(ch._joinTimer)
      ch._joinTimer = null
      ch._emit(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR, err)
    }
  }

  function onSocketGone(err) {
    stopHeartbeat()
    const socket = ws
    ws = null
    wsBase = null
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
    }
    if (channels.size === 0) return
    failChannels(err)
    scheduleReconnect()
  }

  function closeSocket() {
    stopHeartbeat()
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    const socket = ws
    ws = null
    wsBase = null
    if (!socket) return
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
    try { socket.close(1000, 'client closing') } catch { /* ignore */ }
  }

  function scheduleReconnect(immediate = false) {
    if (reconnectTimer || channels.size === 0) return
    const exp = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** attempts)
    const delay = immediate ? 0 : Math.round(exp * (0.5 + random() * 0.5))
    attempts = Math.min(attempts + 1, 20)
    reconnectTimer = setTimeout(connect, delay)
  }

  function startHeartbeat() {
    stopHeartbeat()
    if (heartbeatMs <= 0) return
    heartbeatTimer = setInterval(probe, heartbeatMs)
  }

  /**
   * Send a ping and give the server pongTimeoutMs to answer with anything.
   * Only a missing answer to THIS ping drops the socket (half-open
   * connections are common on mobile).
   */
  function probe() {
    if (!ws || ws.readyState !== OPEN || pongTimer) return
    if (!sendRaw({ type: 'ping' })) return
    const socket = ws
    pongTimer = setTimeout(() => {
      pongTimer = null
      if (ws !== socket) return
      onSocketGone(new Error('Realtime heartbeat timed out'))
      try { socket.close(4000, 'heartbeat timeout') } catch { /* ignore */ }
    }, pongTimeoutMs)
  }

  function stopHeartbeat() {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
    clearTimeout(pongTimer)
    pongTimer = null
  }

  function scheduleIdleClose() {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (channels.size === 0) {
        closeSocket()
        stopListening()
      }
    }, idleCloseMs)
  }

  // Reconnect at once when the device comes back online or the tab is shown.
  function onWake() {
    if (channels.size === 0 || ws) return
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    attempts = 0
    connect()
  }
  function onVisibility() {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
    // Socket open: check it now rather than at the next (possibly throttled) tick.
    if (ws && ws.readyState === OPEN) probe()
    else onWake()
  }
  function startListening() {
    if (listening || typeof window === 'undefined' || !window.addEventListener) return
    listening = true
    window.addEventListener('online', onWake)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  }
  function stopListening() {
    if (!listening) return
    listening = false
    window.removeEventListener('online', onWake)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
  }

  return client
}

/** App-wide instance. lib/supabaseClient.js re-exports it as `supabase`. */
export const relayRealtime = createRelayRealtime()
