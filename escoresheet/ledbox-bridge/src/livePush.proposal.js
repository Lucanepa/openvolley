// ─────────────────────────────────────────────────────────────────────────────
// PROPOSAL — NOT WIRED IN. Nothing imports this file.
//
// A board-side hook that POSTs manualSource.getState() to the wiedisync cloud
// relay (Cloudflare Worker + Durable Object) on every scoring change, so club
// members can follow the match live in the app. See the full design in
//   wiedisync/.planning/live-scoring-DESIGN.md
//
// It is deliberately standalone and side-effect-free so it can sit in the repo
// without touching the scoring path. When ready, wire it in from bridge.js with:
//
//     import { livePushFromEnv } from './livePush.proposal.js'
//     const livePush = livePushFromEnv()      // no-op unless LIVE_RELAY_* set
//     livePush.attach(manualSource)           // mirror every state change
//
// (Or add a single `livePush.push(newState, manualSource.lastEvent)` line after
// `manualSource.apply(action)` in controlServer.js's /api/action handler.)
//
// ── Config — DISTINCT env vars on purpose ────────────────────────────────────
// The existing RELAY_URL / RELAY_HTTP_URL point at the OpenVolley LAN relay that
// the board SUBSCRIBES to (lanSource → relaySubscriber). This cloud PUSH is a
// different direction and a different endpoint, so it uses its own vars and can
// never clobber the LAN relay config:
//
//     LIVE_RELAY_URL      https base of the deployed relay Worker
//                         (e.g. https://kscw-live-relay.lucanepa.workers.dev
//                          or a custom route https://live.kscw.ch)
//     LIVE_RELAY_TOKEN    shared secret; sent as `Authorization: Bearer <token>`
//                         — must equal the Worker's RELAY_TOKEN secret
//     LIVE_RELAY_CHANNEL  channel id (default 'kscw' — one board, one channel)
//
// Everything here is best-effort: a relay outage, a slow network or a bad token
// must NEVER affect the physical scoreboard, so every failure is swallowed
// (logged only when debug is on), exactly like historyStore is isolated today.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULTS = { channel: 'kscw', timeoutMs: 2000, debounceMs: 150, debug: false }

export function createLivePush(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const base = String(cfg.url || '').replace(/\/$/, '')
  const enabled = !!(base && cfg.token)

  let pending = null // latest { state, event } waiting to be flushed
  let timer = null
  let attached = null // { source, handler } when attach() is active

  function log(...a) { if (cfg.debug) console.log('[livePush]', ...a) }

  // Coalesce a burst of rapid changes (typed corrections, next-set) into one
  // POST carrying the LATEST state — the board only ever cares about "now".
  function push(state, event = null) {
    if (!enabled || !state) return
    pending = { state, event, ts: Date.now() }
    if (timer) return
    timer = setTimeout(flush, cfg.debounceMs)
    if (timer.unref) timer.unref() // don't keep the process alive for a ping
  }

  async function flush() {
    timer = null
    const payload = pending
    pending = null
    if (!payload) return

    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs)
    try {
      const res = await fetch(`${base}/publish/${encodeURIComponent(cfg.channel)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.token}`,
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      })
      if (!res.ok) log('relay responded', res.status)
      else log('pushed seq', payload.ts, 'event', payload.event)
    } catch (err) {
      log('push failed:', err && err.message) // swallow — scoring must not care
    } finally {
      clearTimeout(t)
    }
  }

  // Subscribe to a ManualSource: it emits 'state' AFTER apply() has set
  // `lastEvent`, so reading source.lastEvent inside the handler is correct.
  function attach(source) {
    if (!enabled || !source || attached) return
    const handler = (state) => push(state, source.lastEvent)
    source.on('state', handler)
    attached = { source, handler }
    // Seed the relay with the current board immediately.
    if (typeof source.getState === 'function') push(source.getState(), source.lastEvent)
    log('attached to ManualSource')
  }

  function detach() {
    if (attached) { attached.source.off('state', attached.handler); attached = null }
    if (timer) { clearTimeout(timer); timer = null }
    pending = null
  }

  return { enabled, push, attach, detach }
}

// Convenience: build from the environment. Returns a disabled stub (all no-ops)
// when LIVE_RELAY_URL / LIVE_RELAY_TOKEN are unset, so wiring it in is always safe.
export function livePushFromEnv(env = process.env) {
  return createLivePush({
    url: env.LIVE_RELAY_URL,
    token: env.LIVE_RELAY_TOKEN,
    channel: env.LIVE_RELAY_CHANNEL || DEFAULTS.channel,
    debug: /^(1|true|yes|on)$/i.test(String(env.DEBUG || '')),
  })
}
